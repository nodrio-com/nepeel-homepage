import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { postShareUrl, setOwnPostShare } from "../shared/post-share";

const token = "a".repeat(43);

test("web and native deliver the same public post URL and never deliver malformed tokens", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc(name: string, args: { p_post: string; p_enabled: boolean }) {
      calls.push([name, args]);
      return { data: args.p_enabled ? token : null, error: null };
    },
  } as unknown as SupabaseClient;
  const published = await setOwnPostShare(client, "own-post", true);
  assert.equal(postShareUrl(published), postShareUrl(published, "https://nepeel.com"));
  assert.equal(postShareUrl(published), "https://nepeel.com/s/" + token);
  assert.equal(await setOwnPostShare(client, "own-post", false), null);
  assert.deepEqual(calls, [
    ["set_post_share_link", { p_post: "own-post", p_enabled: true }],
    ["set_post_share_link", { p_post: "own-post", p_enabled: false }],
  ]);
  for (const invalid of ["", "example-photo", "/private", token + "/media"]) {
    assert.throws(() => postShareUrl(invalid));
    const invalidResponse = { rpc: async () => ({ data: invalid, error: null }) } as unknown as SupabaseClient;
    await assert.rejects(setOwnPostShare(invalidResponse, "own-post", true));
  }
  const denied = { rpc: async () => ({ data: null, error: new Error("permission denied") }) } as unknown as SupabaseClient;
  await assert.rejects(setOwnPostShare(denied, "other-post", true), /permission denied/);
});
