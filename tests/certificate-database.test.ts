import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { certificateCommitment } from "../server/certificate-commitment.js";

const db = new PGlite();
const user = randomUUID();
const id = randomUUID();
const sha = "a".repeat(64);
const display = "b".repeat(64);
const salt = "c".repeat(64);
const commitment = certificateCommitment(id, "photo", sha, display, salt);

before(async () => {
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
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  await db.query("insert into auth.users values($1,'{}')", [user]);
});
after(() => db.close());

test("private attestations keep a separate bounded allowance from social photos", async () => {
  const owner = randomUUID();
  await db.query("insert into auth.users values($1,'{}')", [owner]);
  for (const purpose of ["certify", "capture"]) {
    for (let index = 0; index < 12; index++) {
      await db.query("select id from public.issue_challenge($1,$2,$3)", [owner, randomUUID(), purpose]);
    }
    await assert.rejects(
      db.query("select id from public.issue_challenge($1,$2,$3)", [owner, randomUUID(), purpose]),
      /Too many capture requests/,
    );
  }
});

test("private bucket and certificate worker never grant clients direct access", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      await assert.rejects(
        db.query("select * from public.media_certificates"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select public.lease_certificate_mint()"),
        /permission denied/,
      );
      await assert.rejects(
        db.query(
          "insert into storage.objects(bucket_id,name) values('certificate-media','demo')",
        ),
        /row-level security/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
  assert.equal(
    (
      await db.query<{ public: boolean }>(
        "select public from storage.buckets where id='certificate-media'",
      )
    ).rows[0].public,
    false,
  );
});

test("authorized capture is consumed once, survives challenge pruning, leases one mint and cleans up on deletion", async () => {
  const challenge = (
    await db.query<{ id: string }>(
      "select id from public.issue_challenge($1,$2,'certify')",
      [user, "single-use-test-nonce"],
    )
  ).rows[0].id;
  const params = [
    challenge,
    user,
    id,
    "photo",
    sha,
    display,
    salt,
    commitment,
    "android",
  ];
  const reserve =
    "select * from public.reserve_media_certificate($1,$2,$3,$4,$5,$6,$7,$8,$9)";
  let row = (
    await db.query<{ id: string; state: string; object_path: string }>(
      reserve,
      params,
    )
  ).rows[0];
  assert.equal(row.state, "uploading");
  assert.equal(row.object_path, id + "/media.jpg");
  assert.equal(
    (await db.query("select * from public.lease_certificate_mint()")).rows
      .length,
    0,
  );
  await db.query("delete from public.capture_challenges where id=$1", [
    challenge,
  ]);
  assert.equal(
    (await db.query<{ id: string }>(reserve, params)).rows[0].id,
    id,
  );
  await assert.rejects(
    db.query(
      reserve,
      params.map((v, i) => (i === 4 ? "d".repeat(64) : v)),
    ),
    /Capture content changed/,
  );
  assert.equal(
    (
      await db.query<{ state: string }>(
        "select * from public.finish_media_certificate($1,$2)",
        [id, user],
      )
    ).rows[0].state,
    "queued",
  );
  const lease = (
    await db.query<{ id: string; lease: string }>(
      "select * from public.lease_certificate_mint()",
    )
  ).rows[0];
  assert.equal(lease.id, id);
  assert.equal(
    (await db.query("select * from public.lease_certificate_mint()")).rows
      .length,
    0,
  );
  await db.query(
    "update public.media_certificates set tx_blob='signed',lease_until=now()-interval '1 second' where id=$1",
    [id],
  );
  const retry = (
    await db.query<{ lease: string; tx_blob: string }>(
      "select * from public.lease_certificate_mint()",
    )
  ).rows[0];
  assert.notEqual(retry.lease, lease.lease);
  assert.equal(retry.tx_blob, "signed");
  await db.query("delete from auth.users where id=$1", [user]);
  assert.equal(
    (await db.query("select 1 from public.media_certificates")).rows.length,
    0,
  );
  assert.equal(
    (
      await db.query<{ object_path: string }>(
        "select object_path from public.certificate_cleanup",
      )
    ).rows[0].object_path,
    row.object_path,
  );
});
