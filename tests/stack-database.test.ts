import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { StackRef, StackSource, WorkStack } from "../shared/stacks.js";
import type { PublicStack } from "../server/stack-share.js";

test("ordered owner stacks, grant pinning, retries, conflicts, pagination and cascade across actual SQL roles", async () => {
  const db = new PGlite();
  const owner = randomUUID(), stranger = randomUUID(), stackId = randomUUID();
  const post: StackRef = { id: randomUUID(), source: "post" };
  const extra: StackRef = { id: randomUUID(), source: "post" };
  const other: StackRef = { id: randomUUID(), source: "post" };
  const video: StackRef = { id: randomUUID(), source: "certificate" };
  const pending: StackRef = { id: randomUUID(), source: "certificate" };
  const query = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ result: T }>(sql, params)).rows[0]?.result;
  const role = (name: "anon" | "authenticated" | "service_role") => db.exec("set role " + name);
  const login = async (id: string) => {
    await role("authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  };
  const save = (title: string, items: StackRef[], revision: number | null) =>
    query<WorkStack>("select public.save_work_stack($1,$2,$3::jsonb,$4) as result", [stackId, title, JSON.stringify(items), revision]);
  const share = (enabled: boolean, revision: number) =>
    query<WorkStack>("select public.set_work_stack_share($1,$2,$3) as result", [stackId, enabled, revision]);
  const resolve = (token: string, item: string | null = null) =>
    query<PublicStack | null>("select public.resolve_work_stack($1,$2) as result", [token, item]);
  const postLink = (item: StackRef, enabled: boolean) =>
    query<string | null>("select public.set_post_share_link($1,$2) as result", [item.id, enabled]);
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon,authenticated,service_role;
      grant all on storage.objects to anon,authenticated,service_role;`);
    const dir = new URL("../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(file => file.endsWith(".sql")).sort())
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    await db.query("insert into auth.users values ($1,'{}'),($2,'{}')", [owner, stranger]);
    for (const [item, user] of [[post, owner], [extra, owner], [other, stranger]] as const) {
      await db.query(`insert into public.posts(id,user_id,image_path,image_sha256,caption,platform,captured_at)
        values ($1,$2,$3,repeat('a',64),$4,'ios',now())`, [item.id,user,item.id + ".jpg",item.id === post.id ? "before" : "after"]);
      await db.query(`insert into storage.objects(bucket_id,name,metadata) values ('captures',$1,'{"mimetype":"image/jpeg"}')`, [item.id+".jpg"]);
    }
    for (const [item, state, mark] of [[video,"queued","b"], [pending,"uploading","c"]] as const) {
      await db.query(`insert into public.media_certificates(id,challenge_id,user_id,media_kind,source_hash,display_hash,salt,
        commitment,platform,state) values($1,gen_random_uuid(),$2,'video',repeat('a',64),repeat('a',64),repeat('a',64),
        repeat($4,64),'ios',$3)`, [item.id,owner,state,mark]);
    }
    await role("anon");
    await assert.rejects(save("x", [post], null), /permission denied/);
    await assert.rejects(resolve("a".repeat(43)), /permission denied/);
    await login(owner);
    for (const relation of ["work_stacks","work_stack_items","work_stack_sources_private"])
      await assert.rejects(db.query("select * from public." + relation), /permission denied/);
    await assert.rejects(db.query("select public.work_stack_owner_data($1)", [stackId]), /permission denied/);
    const library = (await db.query<{item: StackSource}>("select public.list_work_stack_sources() as item")).rows.map(row => row.item);
    assert.equal(library.length, 3);
    assert.ok(library.some(item => item.id === video.id && item.mediaKind === "video" && !item.imagePath));
    const cursor = library[0];
    assert.deepEqual((await db.query<{item: StackSource}>("select public.list_work_stack_sources($1,$2,$3) as item",
      [cursor.createdAt,cursor.id,cursor.source])).rows.map(row => row.item.id), library.slice(1).map(item => item.id));
    const initial = await save("  11월 기록  ", [post,video], null);
    assert.equal(initial.title, "11월 기록");
    assert.equal(initial.shareToken, null);
    assert.deepEqual(await save("11월 기록", [post,video], null), initial);
    await assert.rejects(save("다른 요청", [post,video], null), /이미 저장/);
    await assert.rejects(save("누락", [post,pending], 1), /내 촬영/);
    await assert.rejects(save("권한", [post,other], 1), /내 촬영/);
    await assert.rejects(save("중복", [post,post], 1), /한 번만/);
    await assert.rejects(share(true,1), /공유를 먼저/);
    await login(stranger);
    assert.equal((await db.query("select public.list_work_stacks()")).rows.length, 0);
    await assert.rejects(save("침범", [other], 1), /찾을 수/);
    await assert.rejects(share(false,1), /찾을 수/);
    await login(owner);
    const original = await postLink(post, true);
    const enabled = await share(true,1);
    const token = enabled.shareToken!;
    assert.match(token, /^[\w-]{43}$/);
    assert.deepEqual(enabled.items.map(item => item.inShare), [true,false]);
    await role("service_role");
    const manifest = (await resolve(token))!;
    assert.deepEqual(manifest.items.map(item => item.caption), ["before"]);
    assert.ok(!JSON.stringify(manifest).includes(original!) && !JSON.stringify(manifest).includes(post.id));
    const handle = manifest.items[0].id;
    assert.equal((await resolve(token, handle))!.items[0].credential, original);
    await db.exec("reset role");
    await db.query("update public.media_certificates set share_hash=repeat('d',64),share_nonce='nonce1' where id=$1", [video.id]);
    await login(owner);
    await postLink(extra,true);
    await assert.rejects(save("stale", [post], 1), /다른 곳/);
    const reordered = await save("작업 2", [video,extra,post], enabled.revision);
    assert.deepEqual(reordered.items.map(item => item.id), [video.id,extra.id,post.id]);
    assert.deepEqual(reordered.items.map(item => item.inShare), [false,true,true]);
    const refreshed = await share(true,reordered.revision);
    assert.equal(refreshed.shareToken, token);
    assert.ok(refreshed.items.every(item => item.inShare));
    await postLink(post,false);
    await postLink(post,true);
    await db.exec("reset role");
    await db.query("update public.media_certificates set share_hash=repeat('e',64),share_nonce='nonce2' where id=$1", [video.id]);
    await login(owner);
    const renamed = await save("마지막", [post,extra,video], refreshed.revision);
    assert.deepEqual(renamed.items.map(item => item.inShare), [false,true,false]);
    await role("service_role");
    assert.deepEqual((await resolve(token))!.items.map(item => item.caption), ["after"]);
    assert.deepEqual((await resolve(token,handle))!.items, []);
    await login(owner);
    const off = await share(false,renamed.revision);
    assert.equal(off.shareToken, null);
    assert.ok(off.items.every(item => !item.inShare && item.shared));
    const again = await share(true,off.revision);
    assert.notEqual(again.shareToken, token);
    await role("service_role");
    assert.equal(await resolve(token), null);
    assert.equal((await resolve(again.shareToken!))!.items.length, 3);
    await db.exec("reset role");
    await db.query("delete from public.posts where id=$1", [extra.id]);
    await db.query("delete from public.media_certificates where id=$1", [video.id]);
    await login(owner);
    const saved = (await db.query<{stack: WorkStack}>("select public.list_work_stacks() as stack")).rows[0].stack;
    assert.deepEqual(saved.items.map(item => item.id), [post.id]);
    await db.exec("reset role");
    await db.query("delete from auth.users where id=$1", [owner]);
    await role("service_role");
    assert.equal(await resolve(again.shareToken!), null);
  } finally {
    await db.close();
  }
});
