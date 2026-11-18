import assert from "node:assert/strict";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { Wallet, convertStringToHex, decode, decodeAccountID } from "xrpl";
import { prepareMint, submitOrCheckMint, verifyMint } from "../server/nft-ledger.js";

const wallet = Wallet.generate();
const issuer = wallet.classicAddress;
const commitment = "a1".repeat(32);
const uri = convertStringToHex(`urn:sha256:${commitment}`);
const tokenId = `00000000${Buffer.from(decodeAccountID(issuer)).toString("hex")}0000099B00000000`.toUpperCase();
const txHash = "7B".repeat(32);
const proof = { issuer, commitment, txHash, tokenId };
const originalSeed = process.env.XRPL_TESTNET_ISSUER_SEED;
const originalIssuer = process.env.XRPL_TESTNET_ISSUER;
beforeEach(() => {
  process.env.XRPL_TESTNET_ISSUER = issuer;
  process.env.XRPL_TESTNET_ISSUER_SEED = wallet.seed!;
});
afterEach(() => {
  if (originalIssuer === undefined) delete process.env.XRPL_TESTNET_ISSUER;
  else process.env.XRPL_TESTNET_ISSUER = originalIssuer;
  if (originalSeed === undefined) delete process.env.XRPL_TESTNET_ISSUER_SEED;
  else process.env.XRPL_TESTNET_ISSUER_SEED = originalSeed;
});

function mockLedger(t: TestContext) {
  const txJson = { Account: issuer, TransactionType: "NFTokenMint", NFTokenTaxon: 0, Flags: 0, URI: uri };
  const tx = { hash: txHash, validated: true, tx_json: txJson, meta: { TransactionResult: "tesSUCCESS", nftoken_id: tokenId } };
  const nft = { validated: true, nft_id: tokenId, issuer, owner: issuer, uri, flags: 0, nft_taxon: 0, is_burned: false, transfer_fee: 0 };
  const replies: Record<string, Record<string, unknown>> = {
    server_info: { info: { network_id: 1, validated_ledger: { seq: 1000 } } },
    account_info: { validated: true, account_data: { Account: issuer, Sequence: 7 } },
    fee: { drops: { open_ledger_fee: "12" } }, tx, nft_info: nft,
    submit: { engine_result: "tesSUCCESS" },
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    const { method, params: [params] } = JSON.parse(String(options.body));
    assert.equal(options.redirect, "error");
    assert.equal(input, ["tx", "nft_info"].includes(method) ? "https://clio.altnet.rippletest.net:51234/" : "https://s.altnet.rippletest.net:51234/");
    calls.push({ method, params });
    const reply = replies[method];
    assert.ok(reply, `Unexpected method ${method}`);
    return Response.json({ result: { status: "success", ...reply } });
  });
  return { replies, calls, tx, nft };
}

test("preparing signs the commitment without submitting and rejects a foreign network, issuer key or excessive fee", async (t) => {
  const { replies, calls } = mockLedger(t);
  const prepared = await prepareMint(commitment);
  assert.equal(prepared.lastLedger, 1020);
  const signed = decode(prepared.blob);
  assert.deepEqual(Object.keys(signed).sort(), [
    "Account", "Fee", "Flags", "LastLedgerSequence", "NFTokenTaxon", "Sequence",
    "SigningPubKey", "TransactionType", "TxnSignature", "URI",
  ]);
  assert.equal(signed.Flags, 0);
  assert.equal(signed.URI, uri);
  assert.equal(calls.some((call) => call.method === "submit"), false);
  await assert.rejects(prepareMint("bad"), /commitment/);
  replies.fee = { drops: { open_ledger_fee: "1001" } };
  await assert.rejects(prepareMint(commitment), /fee/);
  replies.server_info = { info: { network_id: 0, validated_ledger: { seq: 1000 } } };
  await assert.rejects(prepareMint(commitment), /ledger unavailable/);
  process.env.XRPL_TESTNET_ISSUER = Wallet.generate().classicAddress;
  await assert.rejects(prepareMint(commitment), /does not match/);
});

test("retries submit identical stored bytes, return pending for tentative success, and recover an already validated mint", async (t) => {
  const { replies, calls, tx } = mockLedger(t);
  const p = await prepareMint(commitment);
  replies.tx = { status: "error", error: "txnNotFound", searched_all: false };
  for (let i = 0; i < 2; i++) assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "pending" });
  assert.deepEqual(calls.filter((c) => c.method === "submit").map((c) => c.params.tx_blob), [p.blob, p.blob]);
  const lookup = calls.find((c) => c.method === "tx")!;
  assert.equal(lookup.params.min_ledger, 1001);
  assert.equal(lookup.params.max_ledger, 1020);
  replies.tx = { ...tx, hash: p.hash };
  assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "minted", issuer, tokenId, txHash: p.hash });
  await assert.rejects(submitOrCheckMint({ ...p, hash: txHash }, commitment), /does not match/);
  await assert.rejects(submitOrCheckMint(p, "c".repeat(64)), /does not match/);
  await assert.rejects(submitOrCheckMint({ ...p, lastLedger: 1021 }, commitment), /does not match/);
  const tagged = wallet.sign({
    TransactionType: "NFTokenMint", Account: issuer, NFTokenTaxon: 0, Flags: 0, URI: uri,
    Fee: "12", Sequence: 7, LastLedgerSequence: p.lastLedger, SourceTag: 123,
  });
  await assert.rejects(submitOrCheckMint({
    blob: tagged.tx_blob, hash: tagged.hash, lastLedger: p.lastLedger,
  }, commitment), /does not match/);
  assert.equal(calls.filter((c) => c.method === "submit").length, 2);
});

test("replacement requires definitive non-inclusion across the entire ledger window or a validated failure", async (t) => {
  const { replies, calls, tx } = mockLedger(t);
  const p = await prepareMint(commitment);
  replies.server_info = { info: { network_id: 1, validated_ledger: { seq: 1020 } } };
  replies.tx = { status: "error", error: "txnNotFound", searched_all: false };
  assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "pending" });
  replies.tx.searched_all = true;
  assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "expired" });
  replies.tx = { ...tx, hash: p.hash, validated: false, meta: { TransactionResult: "tecINSUFFICIENT_RESERVE" } };
  assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "pending" });
  replies.tx.validated = true;
  assert.deepEqual(await submitOrCheckMint(p, commitment), { state: "expired" });
  assert.equal(calls.some((c) => c.method === "submit"), false);
});

test("verification only accepts matching validated mint metadata and current issuer-held immutable NFT state", async (t) => {
  const { replies, tx, nft } = mockLedger(t);
  delete process.env.XRPL_TESTNET_ISSUER_SEED;
  assert.equal(await verifyMint(proof), true);
  for (const change of [
    { issuer: Wallet.generate().classicAddress }, { commitment: "b".repeat(64) },
    { tokenId: "AB".repeat(32) }, { txHash: "AB".repeat(32) },
  ]) assert.equal(await verifyMint({ ...proof, ...change }), false);
  for (const change of [
    { validated: false }, { meta: { TransactionResult: "tecFAILED" } },
    { tx_json: { ...tx.tx_json, Flags: 8 } }, { tx_json: { ...tx.tx_json, Memos: [] } },
  ]) {
    replies.tx = { ...tx, ...change };
    assert.equal(await verifyMint(proof), false);
  }
  replies.tx = tx;
  for (const change of [{ uri: "00" }, { validated: false }, { is_burned: true }, { owner: "" }, { flags: 16 }]) {
    replies.nft_info = { ...nft, ...change };
    assert.equal(await verifyMint(proof), false);
  }
  replies.tx = { status: "error", error: "txnNotFound" };
  assert.equal(await verifyMint(proof), false);
  replies.tx = { status: "error", error: "tooBusy" };
  await assert.rejects(verifyMint(proof), /tooBusy/);
});
