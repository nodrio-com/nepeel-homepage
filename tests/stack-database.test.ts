import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { StackRef, StackSource, WorkStack } from "../shared/stacks.js";
import type { PublicStack } from "../server/stack-share.js";

const selectionMigration = "202611190001_work_stack_selection.sql";
async function migrate(db: PGlite, legacy = false) {
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
  for (const file of (await readdir(dir)).filter(file => file.endsWith(".sql") && (!legacy || file < selectionMigration)).sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
}

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
    await migrate(db);
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
    await db.query("update public.posts set tape='center' where id=$1", [post.id]);
    await role("anon");
    await assert.rejects(save("x", [post], null), /permission denied/);
    await assert.rejects(resolve("a".repeat(43)), /permission denied/);
    await login(owner);
    for (const relation of ["work_stacks","work_stack_items","work_stack_sources_private"])
      await assert.rejects(db.query("select * from public." + relation), /permission denied/);
    await assert.rejects(db.query("select public.work_stack_owner_data($1)", [stackId]), /permission denied/);
    const library = (await db.query<{item: StackSource}>("select public.list_work_stack_sources() as item")).rows.map(row => row.item);
    assert.equal(library.length, 3);
    assert.equal(library.find(item => item.id === post.id)?.tape, "center");
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
    assert.equal(manifest.items[0].tape, "center");
    assert.equal(await query<string>("select tape as result from public.resolve_post_share($1)", [original]), "center");
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
    assert.deepEqual(reordered.items.map(item => item.inShare), [false,false,true]);
    const refreshed = await share(true,reordered.revision);
    assert.equal(refreshed.shareToken, token);
    assert.ok(refreshed.items.every(item => item.inShare));
    await postLink(post,false);
    await postLink(post,true);
    await db.exec("reset role");
    await db.query("update public.media_certificates set share_hash=repeat('e',64),share_nonce='nonce2' where id=$1", [video.id]);
    await login(owner);
    await assert.rejects(save("마지막", [post,extra,video], refreshed.revision), /다른 곳/);
    await assert.rejects(query("select public.publish_work_stack_selection($1,$2::jsonb,$3)",[
      stackId,JSON.stringify([post,video]),refreshed.revision]), /다른 곳/);
    const latest = (await db.query<{stack: WorkStack}>("select public.list_work_stacks() as stack")).rows[0].stack;
    const renamed = await save("마지막", [post,extra,video], latest.revision);
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

test("explicit publication upgrades legacy links, grants only selected members and handles stale or failed changes atomically", async () => {
  const db = new PGlite();
  const actor = randomUUID(), stranger = randomUUID(), stack = randomUUID(), second = randomUUID();
  const ref = (source: StackRef["source"]): StackRef => ({ source, id: randomUUID() });
  const pinned = ref("post"), privatePost = ref("post"), video = ref("certificate"), later = ref("post");
  const original = [pinned, privatePost, video];
  const query = async <T>(sql: string, args: unknown[] = []) => (await db.query<{v:T}>(sql,args)).rows[0]?.v;
  const role = (name: "anon" | "authenticated" | "service_role") => db.exec("set role " + name);
  const login = async (id: string) => {
    await role("authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
  };
  const save = (id: string, items: StackRef[], revision: number | null) => query<WorkStack>(
    "select public.save_work_stack($1,'stack',$2::jsonb,$3) v",[id, JSON.stringify(items), revision]);
  const publish = (id: string, selected: unknown, revision: number | null) => query<WorkStack>(
    "select public.publish_work_stack_selection($1,$2::jsonb,$3) v",[id,JSON.stringify(selected),revision]);
  const get = (id: string) => query<WorkStack>("select s v from public.list_work_stacks() s where s->>'id'=$1",[id]);
  const toggle = (id: string, enabled: boolean, revision: number) => query<WorkStack>(
    "select public.set_work_stack_share($1,$2,$3) v",[id,enabled,revision]);
  const link = (item: StackRef, enabled: boolean) => query<string>("select public.set_post_share_link($1,$2) v",[item.id,enabled]);
  const resolve = (token: string, handle: string | null = null) => query<PublicStack | null>(
    "select public.resolve_work_stack($1,$2) v",[token,handle]);
  try {
    await migrate(db,true);
    await db.query("insert into auth.users values ($1,'{}'),($2,'{}')",[actor,stranger]);
    for (const item of [pinned,privatePost,later]) {
      await db.query(`insert into public.posts(id,user_id,image_path,image_sha256,caption,platform,captured_at)
        values($1,$2,$3,repeat('1',64),$4,'ios',now())`,[item.id,actor,item.id+".jpg",item.id]);
      await db.query(`insert into storage.objects(bucket_id,name,metadata) values('captures',$1,'{"mimetype":"image/jpeg"}')`,[item.id+".jpg"]);
    }
    await db.query(`insert into public.media_certificates(id,challenge_id,user_id,media_kind,source_hash,display_hash,salt,
      commitment,platform,state) values($1,gen_random_uuid(),$2,'video',repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),'ios','queued')`,[video.id,actor]);
    await login(actor);
    const oldStandalone = await link(privatePost,true);
    await link(privatePost,false);
    const activeStandalone = await link(pinned,true);
    await save(stack,original,null);
    await save(second,original,null);
    const oldStack = await toggle(stack,true,1), otherStack = await toggle(second,true,1);
    await db.exec("reset role");
    await db.exec(await readFile(new URL("../supabase/migrations/"+selectionMigration,import.meta.url),"utf8"));
    await role("service_role");
    assert.deepEqual((await resolve(oldStack.shareToken!))!.items.map(i=>i.caption),[pinned.id]);
    assert.equal(await query("select count(*)::int v from public.resolve_post_share($1)",[activeStandalone]),1);
    await role("anon");
    await assert.rejects(publish(stack,[privatePost],oldStack.revision),/permission denied/);
    await login(stranger);
    await assert.rejects(publish(stack,[privatePost],oldStack.revision),/찾을 수/);
    await login(actor);
    for (const invalid of [null,{},[],[privatePost,privatePost],[privatePost,later],[{id:video.id,source:"post"}],
      [privatePost,{source:"post",id:"bad"}],Array(101).fill(video)]) {
      await assert.rejects(publish(stack,invalid,oldStack.revision),/골라|확인/);
      assert.deepEqual(await get(stack),oldStack);
    }
    const shared = await publish(stack,[video,privatePost],oldStack.revision);
    assert.equal(shared.shareToken,oldStack.shareToken);
    assert.deepEqual(shared.items.map(i=>[i.shared,i.inShare]),[[true,false],[false,true],[false,true]]);
    await assert.rejects(toggle(stack,true,shared.revision),/다시 선택/);
    await assert.rejects(publish(stack,[pinned],oldStack.revision),/다른 곳/);
    assert.deepEqual(await get(second),otherStack);
    await role("service_role");
    const manifest = (await resolve(shared.shareToken!))!;
    assert.deepEqual(manifest.items.map(i=>i.source),["post","certificate"]);
    const [photoHandle,videoHandle] = manifest.items.map(i=>i.id);
    assert.ok(manifest.items.every(i=>!("credential" in i) && !("sourceId" in i) && !("imagePath" in i)));
    const scoped = (await resolve(shared.shareToken!,photoHandle))!.items[0];
    assert.equal(scoped.stackScoped,true);
    assert.equal(scoped.sourceId,privatePost.id);
    assert.equal(scoped.imagePath,privatePost.id+".jpg");
    assert.equal(scoped.mimeType,"image/jpeg");
    assert.equal((await resolve(shared.shareToken!,videoHandle))!.items[0].stackScoped,true);
    assert.deepEqual((await resolve(otherStack.shareToken!,photoHandle))!.items,[]);
    assert.equal(await query("select count(*)::int v from public.resolve_post_share($1)",[oldStandalone]),0);
    assert.equal(await query("select count(*)::int v from public.resolve_post_share($1)",[activeStandalone]),1);
    assert.equal(await query("select share_hash v from public.media_certificates where id=$1",[video.id]),null);
    await login(actor);
    await link(later,true);
    const reordered = await save(stack,[video,later,pinned,privatePost],shared.revision);
    assert.deepEqual(reordered.items.map(i=>i.inShare),[true,false,false,true]);
    // Both editors saw the same revision. Exactly one can publish its entire selection.
    const writes = await Promise.allSettled([publish(stack,[video],reordered.revision),publish(stack,[pinned],reordered.revision)]);
    assert.equal(writes.filter(w=>w.status==="fulfilled").length,1);
    assert.ok(writes.some(w=>w.status==="rejected" && /다른 곳/.test(String(w.reason))));
    let current = await get(stack);
    assert.equal(current.items.filter(i=>i.inShare).length,1);
    current = await publish(stack,[pinned,privatePost,video],current.revision);
    await link(pinned,false);
    await link(pinned,true);
    await assert.rejects(publish(stack,[pinned,privatePost,video],current.revision),/다른 곳/);
    assert.deepEqual((await get(stack)).items.filter(i=>i.inShare).map(i=>i.id),[video.id,privatePost.id]);
    await link(privatePost,true);
    await link(privatePost,false);
    assert.deepEqual((await get(stack)).items.filter(i=>i.inShare).map(i=>i.id),[video.id]);
    await db.exec("reset role");
    await db.query("update public.media_certificates set share_hash=repeat('6',64),share_nonce='one' where id=$1",[video.id]);
    await db.query("update public.media_certificates set share_hash=null,share_nonce=null where id=$1",[video.id]);
    await role("service_role");
    assert.deepEqual((await resolve(shared.shareToken!))!.items,[]);
    await login(actor);
    current = await get(stack);
    const off = await toggle(stack,false,current.revision);
    const again = await publish(stack,[video],off.revision);
    assert.notEqual(again.shareToken,shared.shareToken);
    await role("service_role");
    assert.equal(await resolve(shared.shareToken!),null);
    assert.equal((await resolve(again.shareToken!))!.items.length,1);
  } finally {
    await db.close();
  }
});
