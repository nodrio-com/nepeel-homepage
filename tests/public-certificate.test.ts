import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { certificateCommitment } from "../server/certificate-commitment.js";
import { publicCertificate, type PublicCertificateRow } from "../server/public-certificate.js";
import { exampleReader } from "../server/certificate-examples.js";

const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const token = "t".repeat(43);
const url = `https://example.test/api/certificate?token=${token}`;
const id = "d00658c6-031f-4674-9602-452fd2ed88a4";
function fixture(kind: "photo" | "video" = "photo") {
  const bytes = "file delivered to viewer";
  const sourceHash = digest("original capture");
  const displayHash = digest(bytes);
  const salt = "2".repeat(64);
  const row = {
    id, media_kind: kind, source_hash: sourceHash, display_hash: displayHash, salt, platform: "ios",
    commitment: certificateCommitment(id, kind, sourceHash, displayHash, salt),
    state: "minted", tx_hash: "A".repeat(64), token_id: "B".repeat(64), issuer: "test-issuer",
    object_path: `${id}/media.${kind === "photo" ? "jpg" : "mp4"}`,
  };
  const calls: string[] = [];
  const reader = {
    async find(hash: string) {
      calls.push("find");
      assert.equal(hash, digest(token));
      return row;
    },
    async download(path: string) {
      calls.push("download");
      assert.equal(path, row.object_path);
      return new Blob([bytes]);
    },
    async verifyMint(proof: { txHash: string; tokenId: string; issuer: string; commitment: string }) {
      calls.push("verify");
      assert.deepEqual(proof, { txHash: row.tx_hash, tokenId: row.token_id, issuer: row.issuer, commitment: row.commitment });
      return true;
    },
    async stillShared(hash: string, snapshot: PublicCertificateRow) {
      calls.push("recheck");
      assert.equal(hash, digest(token));
      assert.deepEqual(snapshot, row);
      return true;
    },
  };
  return { row, reader, calls, bytes };
}

for (const kind of ["photo", "video"] as const) {
  test(`minted ${kind} serves exactly authenticated bytes without disclosing private fields`, async () => {
    const { row, reader, calls, bytes } = fixture(kind);
    const result = await publicCertificate({ method: "GET", url }, reader);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("X-Certificate-State"), "minted");
    assert.equal(result.headers.get("X-Certificate-Origin"), "ios");
    assert.equal(result.headers.get("X-Display-SHA256"), row.display_hash);
    assert.equal(result.headers.get("X-Certificate-Tx"), row.tx_hash);
    assert.equal(result.headers.get("Content-Type"), kind === "photo" ? "image/jpeg" : "video/mp4");
    assert.match(result.headers.get("Cache-Control")!, /no-store/);
    const visible = new Map<string, string>();
    result.headers.forEach((value, name) => visible.set(name, value));
    for (const privateValue of [row.source_hash, row.salt, row.issuer, id, row.commitment])
      assert.equal([...visible.values()].some(value => value.includes(privateValue)), false);
    assert.equal(await result.text(), bytes);
    assert.deepEqual(calls, ["find", "verify", "download", "recheck"]);
  });
}

test("queued media checks the file and commitment without claiming ledger confirmation", async () => {
  const { row, reader, calls, bytes } = fixture();
  row.state = "queued";
  const result = await publicCertificate({ method: "GET", url }, reader);
  assert.equal(result.headers.get("X-Certificate-State"), "queued");
  assert.equal(result.headers.get("X-Certificate-Token"), null);
  assert.equal(result.headers.get("X-Certificate-Tx"), null);
  assert.equal(await result.text(), bytes);
  assert.deepEqual(calls, ["find", "download", "recheck"]);
});

test("HEAD rechecks sharing and verifies a newly minted proof without fetching the media again", async () => {
  const { row, reader, calls } = fixture("video");
  row.state = "queued";
  const req = { method: "HEAD", url };
  const pending = await publicCertificate(req, reader);
  assert.equal(pending.body, null);
  assert.equal(pending.headers.get("X-Certificate-State"), "queued");
  assert.equal(pending.headers.get("X-Display-SHA256"), row.display_hash);
  assert.deepEqual(calls.splice(0), ["find", "recheck"]);
  row.state = "minted";
  const minted = await publicCertificate(req, reader);
  assert.equal(minted.body, null);
  assert.equal(minted.headers.get("X-Certificate-Tx"), row.tx_hash);
  assert.equal(minted.headers.get("X-Certificate-State"), "minted");
  assert.equal(minted.headers.get("X-Display-SHA256"), row.display_hash);
  assert.deepEqual(calls.splice(0), ["find", "verify", "recheck"]);
  const revoked = await publicCertificate(req, { ...reader, stillShared: async () => false });
  assert.equal(revoked.status, 404);
  assert.equal(revoked.headers.get("X-Certificate-Tx"), null);
  assert.equal((await publicCertificate(req, { ...reader, verifyMint: async () => false })).status, 409);
  row.source_hash = digest("changed");
  assert.equal((await publicCertificate(req, reader)).status, 409);
  assert.ok(!calls.includes("download"));
});

test("missing and duplicated capability parameters are rejected before private reads", async () => {
  const { reader, calls } = fixture();
  for (const query of ["", "?token=short", `?token=${token}&token=${token}`]) {
    const result = await publicCertificate({ method: "GET", url: `https://example.test/api/certificate${query}` }, reader);
    assert.equal(result.status, 404);
  }
  assert.equal((await publicCertificate({ method: "POST", url }, reader)).status, 405);
  assert.deepEqual(calls, []);
});

test("unshared, incomplete and revoked records return no media", async () => {
  const { row, reader, calls } = fixture();
  const missing = await publicCertificate({ method: "GET", url }, { ...reader, find: async () => null });
  assert.equal(missing.status, 404);
  row.state = "uploading";
  assert.equal((await publicCertificate({ method: "GET", url }, reader)).status, 404);
  assert.deepEqual(calls, ["find"]);
  row.state = "minted";
  const revoked = await publicCertificate({ method: "GET", url }, { ...reader, stillShared: async () => false });
  assert.equal(revoked.status, 404);
  assert.equal(revoked.body, null);
  assert.equal(revoked.headers.get("X-Certificate-State"), null);
});

test("tampered manifest, storage path, media or on-chain record cannot produce a certificate", async () => {
  for (const change of ["hash", "path", "bytes", "ledger", "terminal"]) {
    const { row, reader } = fixture();
    if (change === "hash") row.source_hash = digest("forged");
    if (change === "path") row.object_path = "someone-else/media.jpg";
    if (change === "terminal") row.state = "failed";
    if (change === "bytes") reader.download = async () => new Blob(["forged"]);
    if (change === "ledger") reader.verifyMint = async () => false;
    const result = await publicCertificate({ method: "GET", url }, reader);
    assert.equal(result.status, 409, change);
    assert.equal(result.body, null);
    assert.equal(result.headers.get("X-Certificate-State"), null);
  }
});

test("a ledger outage fails closed without leaking upstream errors", async () => {
  const { reader, calls } = fixture();
  reader.verifyMint = async () => { throw new Error("internal rpc details"); };
  const result = await publicCertificate({ method: "GET", url }, reader);
  assert.equal(result.status, 503);
  assert.equal(result.body, null);
  assert.equal(result.headers.get("X-Certificate-State"), null);
  assert.deepEqual(calls, ["find"]);
});

for (const key of ["example-photo", "example-video"] as const) {
  test(`${key} pins both the published media and NFT commitment independently of owner shares`, async () => {
    const store = exampleReader(key);
    const row = (await store.find(""))!;
    assert.equal(row.commitment, certificateCommitment(row.id, row.media_kind, row.source_hash, row.display_hash, row.salt));
    let checked = false;
    store.verifyMint = async proof => {
      checked = true;
      assert.deepEqual(proof, { txHash: row.tx_hash, tokenId: row.token_id, issuer: row.issuer, commitment: row.commitment });
      return true;
    };
    const request = { method: "GET", url: `https://example.test/api/certificate?token=${key}` };
    const result = await publicCertificate(request, store);
    assert.equal(result.status, 200);
    assert.equal(checked, true);
    assert.equal(result.headers.get("X-Certificate-Origin"), "example");
    assert.equal(createHash("sha256").update(Buffer.from(await result.arrayBuffer())).digest("hex"), row.display_hash);
    assert.equal((await publicCertificate({ method: "GET", url }, store)).status, 409);
    store.verifyMint = async () => false;
    assert.equal((await publicCertificate(request, store)).status, 409);
    store.verifyMint = async () => { throw Error("unavailable"); };
    assert.equal((await publicCertificate(request, store)).status, 503);
  });
}
