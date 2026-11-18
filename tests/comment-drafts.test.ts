import assert from "node:assert/strict";
import { test } from "node:test";
import { CommentDrafts } from "../shared/commentDrafts";
import type { Comment } from "../shared/types";

const row: Comment = {
  id: "comment", user_id: "member", body: "첫 댓글", created_at: "2026-11-01T00:00:00Z",
  profiles: { username: "member", display_name: "회원" },
};

test("drafts follow the post and belong to a single login", () => {
  const member = new CommentDrafts("member");
  member.edit("first", "첫 댓글");
  member.edit("second", "두 번째 댓글");
  assert.equal(member.read("first").body, "첫 댓글");
  assert.equal(member.read("second").body, "두 번째 댓글");
  assert.equal(new CommentDrafts("other").read("first").body, "");
  assert.equal(new CommentDrafts("member").read("first").body, "");
  const guest = new CommentDrafts();
  guest.edit("first", "게스트");
  assert.equal(guest.read("first").body, "");
});

test("an uncertain send retains its id across reopening and prevents overlapping submissions", async () => {
  const drafts = new CommentDrafts("member");
  const ids: string[] = [];
  let allocated = 0;
  const makeId = () => String(++allocated);
  drafts.edit("first", "  첫 댓글  ");
  drafts.edit("second", "남겨둔 댓글");
  await assert.rejects(drafts.submit("first", makeId, async (id, body) => {
    ids.push(id);
    assert.equal(body, row.body);
    throw Error("response lost");
  })!, /response lost/);
  assert.equal(drafts.read("first").postError, true);
  assert.equal(drafts.read("first").body, "  첫 댓글  ");
  drafts.edit("first", "첫 댓글");

  let finish!: (comment: Comment) => void;
  const retry = drafts.submit("first", makeId, (id) => {
    ids.push(id);
    return new Promise(resolve => { finish = resolve; });
  });
  await Promise.resolve();
  assert.equal(drafts.read("first").pending, retry);
  assert.equal(drafts.submit("first", makeId, async () => row), undefined);
  drafts.edit("first", "다른 내용");
  assert.equal(drafts.read("first").body, row.body);
  finish(row);
  assert.equal(await retry, row);
  assert.equal(drafts.read("first").body, "");
  assert.equal(drafts.read("first").pending, undefined);
  assert.equal(drafts.read("second").body, "남겨둔 댓글");
  assert.deepEqual(ids, ["1", "1"]);

  drafts.edit("first", row.body);
  await drafts.submit("first", makeId, async id => { ids.push(id); return row; });
  assert.deepEqual(ids, ["1", "1", "2"]);
});

test("bounded draft history prioritizes retaining unconfirmed submissions", async () => {
  const drafts = new CommentDrafts("member");
  drafts.edit("retry", row.body);
  await assert.rejects(drafts.submit("retry", () => "stable", async () => { throw Error("offline"); })!);
  for (let i = 0; i < 100; i++) drafts.edit(String(i), "댓글 " + i);
  assert.equal(drafts.read("0").body, "");
  assert.equal(drafts.read("99").body, "댓글 99");
  const retry = await drafts.submit("retry", () => assert.fail("lost the pending ID"), async id => ({ ...row, id }));
  assert.equal(retry?.id, "stable");
});

test("restoring an earlier edit reuses its own unconfirmed attempt", async () => {
  const drafts = new CommentDrafts("member");
  const ids: string[] = [];
  for (const body of ["첫 댓글", "수정한 댓글", "첫 댓글"]) {
    drafts.edit("first", body);
    await assert.rejects(drafts.submit("first", () => String(ids.length + 1), async id => {
      ids.push(id);
      throw Error("unconfirmed");
    })!);
  }
  assert.deepEqual(ids, ["1", "2", "1"]);
});
