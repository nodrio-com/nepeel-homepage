import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection } from "../shared/connect.js";
import { HiMessageDrafts } from "../src/lib/hi-message-drafts.js";

test("returning to a Hi draft can retry the same submission without clearing a newer edit", () => {
  const drafts = new HiMessageDrafts();
  drafts.edit("older", "  hello  ");
  const first = drafts.prepareSend("older")!;
  drafts.edit("other", "another conversation");
  drafts.reconcile([{ id: "other", status: "accepted" } as Connection]);
  assert.deepEqual(drafts.prepareSend("older"), first);
  assert.equal(first.body, "hello");
  drafts.edit("older", "next message");
  drafts.sent("older", first.clientId);
  assert.equal(drafts.body("older"), "next message");
  const next = drafts.prepareSend("older")!;
  assert.notEqual(next.clientId, first.clientId);
  drafts.sent("older", next.clientId);
  assert.equal(drafts.body("older"), "");
  assert.equal(drafts.body("other"), "another conversation");
});

test("a closed, blocked, expired, or pending Hi cannot retain an accepted chat's draft", () => {
  const drafts = new HiMessageDrafts();
  for (const status of ["blocked", "expired", "declined", "pending"] as const) {
    drafts.edit("chat", "private");
    drafts.reconcile([{ id: "chat", status } as Connection]);
    assert.equal(drafts.body("chat"), "");
    assert.equal(drafts.prepareSend("chat"), undefined);
  }
});
