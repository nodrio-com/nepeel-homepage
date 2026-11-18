import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { servePostShare, type PostShareSource } from "../server/post-share.js";

const token = "a".repeat(43);
const url = "https://nepeel.example/s/" + token;
const row = { image_path: "private/member/file.jpg", caption: "<script>bad</script>", mime_type: "image/jpeg" };
const source: PostShareSource = {
  async resolve(value) { return value === token ? row : null; },
  async media() { return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Length": "3" } }); },
};

test("a shared photo opens without script, member routes, or a storage URL", async () => {
  const response = await servePostShare(new Request(url), source);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /촬영 인증 미확인/);
  assert.ok(html.includes(`src="/s/${token}/media"`));
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|#post\/|로그인|private\/member/i);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const media = await servePostShare(new Request(url + "/media"), source);
  assert.equal(media.headers.get("content-type"), "image/jpeg");
  assert.equal(media.headers.get("netlify-cdn-cache-control"), "no-store");
  assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [1, 2, 3]);
});

test("videos render native controls and forward range/HEAD without exposing the signed object", async () => {
  const video: PostShareSource = {
    async resolve() { return { ...row, mime_type: "video/mp4" }; },
    async media(path, request) {
      assert.equal(path, row.image_path);
      assert.equal(request.headers.get("range"), "bytes=2-3");
      return new Response(request.method === "HEAD" ? null : "ab", {
        status: 206, headers: { "Content-Range": "bytes 2-3/4", "Accept-Ranges": "bytes",
          "Content-Length": "2", "Content-Location": "private-storage-url" },
      });
    },
  };
  assert.match(await (await servePostShare(new Request(url), video)).text(), /<video[^>]+controls playsinline muted autoplay/);
  for (const method of ["GET", "HEAD"]) {
    const req = new Request(url + "/media", { method, headers: { Range: "bytes=2-3" } });
    const media = await servePostShare(req, video);
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("content-range"), "bytes 2-3/4");
    assert.equal(media.headers.get("content-type"), "video/mp4");
    assert.equal(media.headers.get("content-location"), null);
    assert.equal(await media.text(), method === "HEAD" ? "" : "ab");
  }
});

test("missing, revoked and malformed links protect the page and media on every request", async () => {
  let calls = 0;
  const revoked: PostShareSource = {
    async resolve() { calls++; return null; },
    async media() { throw new Error("unexpected download"); },
  };
  for (const target of [url, url + "/media"]) {
    const res = await servePostShare(new Request(target), revoked);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /<video|class="photo"|private\/member/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await servePostShare(new Request(url + "x"), revoked)).status, 404);
  assert.equal(calls, 2);
  assert.equal((await servePostShare(new Request(url, { method: "POST" }), source)).status, 405);
  const invalidRange = new Request(url + "/media", { headers: { Range: "bytes=1-4,7-12" } });
  assert.equal((await servePostShare(invalidRange, source)).status, 416);
  const unsupported = { ...source, async resolve() { return { ...row, mime_type: "text/html" }; } };
  assert.equal((await servePostShare(new Request(url), unsupported)).status, 404);
  const offline = { ...source, async resolve() { throw new Error("private failure"); } };
  const failure = await servePostShare(new Request(url), offline);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /private failure/);
});

test("only authors can issue and revoke links, old links stay dead after reissue and deletion", async () => {
  const db = new PGlite();
  const post = "00000000-0000-4000-8000-000000000001";
  const author = "00000000-0000-4000-8000-000000000002";
  const other = "00000000-0000-4000-8000-000000000003";
  try {
    await db.exec(`create role authenticated; create role anon; create role service_role;
      create schema auth; create schema storage;
      create function auth.uid() returns uuid language sql stable as $$
        select current_setting('request.jwt.claim.sub',true)::uuid $$;
      create table public.posts(id uuid primary key,user_id uuid,caption text,image_path text);
      create table storage.objects(bucket_id text,name text,metadata jsonb);
      insert into public.posts values('${post}','${author}','hello','photo.jpg');
      insert into storage.objects values('captures','photo.jpg','{"mimetype":"image/jpeg"}');`);
    await db.exec(await readFile(new URL("../supabase/migrations/202611180001_post_share_links.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../supabase/migrations/202611190002_post_share_state.sql", import.meta.url), "utf8"));
    const issue = async () => (await db.query<{token: string}>(
      "select public.set_post_share_link($1,true) as token", [post])).rows[0].token;
    const revoke = () => db.query("select public.set_post_share_link($1,false)", [post]);
    const active = async () => (await db.query<{ active: boolean }>(
      "select public.has_own_post_share_link($1) as active", [post])).rows[0].active;
    const resolve = (value: string) => db.query("select * from public.resolve_post_share($1)", [value]);
    await db.exec("set role service_role");
    assert.equal((await resolve(token)).rows.length, 0);
    await db.exec("set role anon");
    await assert.rejects(issue, /permission denied/);
    await assert.rejects(active, /permission denied/);
    await assert.rejects(resolve(token), /permission denied/);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${other}',false)`);
    await assert.rejects(issue, /Post unavailable/);
    await assert.rejects(revoke, /Post unavailable/);
    await assert.rejects(db.query("select * from public.post_share_links"), /permission denied/);
    await db.exec(`select set_config('request.jwt.claim.sub','${author}',false)`);
    assert.equal(await active(), false);
    const first = await issue();
    assert.equal(await active(), true);
    await db.exec(`select set_config('request.jwt.claim.sub','${other}',false)`);
    assert.equal(await active(), false);
    await db.exec(`select set_config('request.jwt.claim.sub','${author}',false)`);
    assert.match(first, /^[\w-]{43}$/);
    assert.equal(await issue(), first);
    await assert.rejects(resolve(first), /permission denied/);
    await db.exec("set role service_role");
    assert.deepEqual((await resolve(first)).rows,
      [{ image_path: "photo.jpg", caption: "hello", mime_type: "image/jpeg" }]);
    await db.exec("set role authenticated");
    await revoke();
    assert.equal(await active(), false);
    await revoke();
    const next = await issue();
    assert.notEqual(first, next);
    await db.exec("set role service_role");
    assert.deepEqual((await resolve(first)).rows, []);
    assert.equal((await resolve(next)).rows.length, 1);
    await db.exec("reset role; delete from public.posts; set role service_role");
    assert.deepEqual((await resolve(next)).rows, []);
  } finally {
    await db.close();
  }
});
