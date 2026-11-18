import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import cbor from "cbor";
import ffmpeg from "ffmpeg-static";
import sharp from "sharp";
import { certifyMedia } from "../server/certify-media.js";
import { certificateCommitment } from "../server/certificate-commitment.js";
import { ApiError, decodeCaptureBytes, sha256 } from "../server/validation.js";
import { sanitizeVideo } from "../server/video-media.js";
import { CAPTURE_CERT_MAX_BYTES, CAPTURE_CERT_VIDEO_SECONDS, certificationPayload, type CertificateMediaKind } from "../shared/media-certificate.js";
import { capturePayload } from "../shared/types.js";

const run = promisify(execFile);
const alice = randomUUID();
const challenge = { id: randomUUID(), nonce: "test-nonce", expires_at: "" };
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const oldTeam = process.env.APPLE_TEAM_ID;
const oldBundle = process.env.IOS_BUNDLE_ID;
let directory: string, photo: Buffer;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "nepeel-certificate-test-"));
  photo = await sharp({ create: { width: 180, height: 300, channels: 3, background: "#cb945b" } })
    .jpeg().withMetadata().toBuffer();
  process.env.APPLE_TEAM_ID = "TESTTEAMID";
  process.env.IOS_BUNDLE_ID = "test.example.nepeel";
});
after(async () => {
  if (oldTeam === undefined) delete process.env.APPLE_TEAM_ID;
  else process.env.APPLE_TEAM_ID = oldTeam;
  if (oldBundle === undefined) delete process.env.IOS_BUNDLE_ID;
  else process.env.IOS_BUNDLE_ID = oldBundle;
  await rm(directory, { recursive: true, force: true });
});

async function movie(format: "mov" | "mp4", seconds = 0.5) {
  const path = join(directory, `${randomUUID()}.${format}`);
  await run(ffmpeg!, [
    "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=800", "-t", String(seconds), "-c:v", "libx264",
    "-threads", "1", "-c:a", "aac", "-metadata", "title=private-test-title",
    "-metadata", "location=+37.5000+127.0000/", "-f", format, path,
  ]);
  return readFile(path);
}

// The assertion is verified by the same node-app-attest implementation the
// endpoint calls in production. Only the registered public key is a fixture.
function request(bytes: Buffer, kind: CertificateMediaKind, signedPayload?: string) {
  const payload = signedPayload ?? certificationPayload(alice, challenge, sha256(bytes), kind);
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest();
  const authenticatorData = Buffer.alloc(37);
  digest("TESTTEAMID.test.example.nepeel").copy(authenticatorData);
  authenticatorData.writeUInt32BE(1, 33);
  const nonce = digest(Buffer.concat([authenticatorData, digest(payload)]));
  const assertion = cbor.encode({ authenticatorData, signature: sign("sha256", nonce, keys.privateKey) });
  return { mediaBase64: bytes.toString("base64"), mediaKind: kind, challengeId: challenge.id,
    proof: { platform: "ios", keyId: "test-key", assertion: assertion.toString("base64") } };
}

function backend(loseUploadResponse = false) {
  const objects = new Map<string, Buffer>();
  let receipt: Record<string, unknown> | undefined;
  let checks = 0;
  const client = createClient("https://example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = url.pathname.split("/").at(-1);
      if (method === "media_certificates") {
        assert.equal(url.searchParams.get("user_id"), "eq." + alice);
        assert.equal(url.searchParams.get("challenge_id"), "eq." + challenge.id);
        return Response.json(receipt ? [receipt] : []);
      }
      if (method === "device_keys") return Response.json({
        environment: "production", public_key: keys.publicKey.export({ type: "spki", format: "pem" }), sign_count: 0,
      });
      if (url.pathname.startsWith("/storage/v1/object/")) {
        assert.ok(receipt);
        const path = String(receipt.object_path);
        assert.ok(url.pathname.endsWith("/certificate-media/" + path));
        if (init?.method === "GET") return new Response(Uint8Array.from(objects.get(path)!));
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init.headers).get("x-upsert"), "false");
        if (objects.has(path)) return Response.json({ code: "ResourceAlreadyExists", message: "exists" }, { status: 409 });
        objects.set(path, Buffer.from(await new Response(init.body).arrayBuffer()));
        if (loseUploadResponse) return Response.json({ message: "lost response" }, { status: 503 });
        return Response.json({ Key: path });
      }
      const args = JSON.parse(String(init?.body));
      switch (method) {
        case "begin_capture_attempt":
          checks++;
          assert.deepEqual(args, { p_id: challenge.id, p_user: alice, p_purpose: "certify" });
          return Response.json([challenge]);
        case "reserve_media_certificate":
          assert.equal(args.p_previous, 0);
          assert.equal(args.p_next, 1);
          assert.equal(args.p_key, "test-key");
          assert.equal(args.p_commitment, certificateCommitment(args.p_id, args.p_kind, args.p_source_hash, args.p_display_hash, args.p_salt));
          receipt = {
            id: args.p_id, user_id: args.p_user, challenge_id: args.p_challenge, media_kind: args.p_kind,
            source_hash: args.p_source_hash, display_hash: args.p_display_hash, platform: args.p_platform,
            object_path: args.p_id + (args.p_kind === "photo" ? "/media.jpg" : "/media.mp4"), state: "uploading",
          };
          return Response.json([receipt]);
        case "finish_media_certificate":
          assert.ok(receipt);
          assert.deepEqual(args, { p_user: alice, p_id: receipt.id });
          receipt.state = "queued";
          return Response.json([receipt]);
        default:
          throw Error("Unexpected call " + method);
      }
    } },
  });
  return { client, objects, receipt: () => receipt, checks: () => checks };
}

test("verifies photo bytes and reserves an immutable private JPEG before queueing", async () => {
  const b = backend(true);
  const body = request(photo, "photo");
  await assert.rejects(certifyMedia(b.client, alice, body), { status: 503 });
  const receipt = b.receipt()!;
  assert.equal(receipt.state, "uploading");
  const [display] = b.objects.values();
  assert.equal(receipt.source_hash, sha256(photo));
  assert.equal(receipt.display_hash, sha256(display));
  assert.notDeepEqual(photo, display);
  assert.equal((await sharp(display).metadata()).exif, undefined);
  const saved = await certifyMedia(b.client, alice, body);
  assert.deepEqual(saved, { id: receipt.id, status: "queued" });
  assert.deepEqual(await certifyMedia(b.client, alice, body), saved);
  assert.deepEqual(await certifyMedia(b.client, alice, { ...body, challengeId: challenge.id.toUpperCase() }), saved);
  assert.equal(b.checks(), 1);
  assert.equal(b.objects.size, 1);
  await assert.rejects(certifyMedia(b.client, alice, { ...body, mediaKind: "video" }), { status: 409 });
});

test("a conflicting stored object cannot queue a certificate", async () => {
  const b = backend(true);
  const body = request(photo, "photo");
  await assert.rejects(certifyMedia(b.client, alice, body), { status: 503 });
  for (const key of b.objects.keys()) b.objects.set(key, Buffer.from("wrong bytes"));
  await assert.rejects(certifyMedia(b.client, alice, body), { status: 503 });
  assert.equal(b.receipt()!.state, "uploading");
});

test("signals the background worker after durable acceptance and keeps the receipt on scheduler failure", async () => {
  const b = backend();
  const body = request(photo, "photo");
  const statesAtStart: unknown[] = [];
  function interruptedScheduler() {
    statesAtStart.push(b.receipt()?.state);
    throw new Error("Host scheduler disconnected");
  }
  const accepted = await certifyMedia(b.client, alice, body, interruptedScheduler);
  assert.equal(accepted.status, "queued");
  assert.deepEqual(await certifyMedia(b.client, alice, body, interruptedScheduler), accepted);
  assert.deepEqual(statesAtStart, ["queued"]);
});

test("rejects unrelated or altered proof payloads before processing or storing media", async () => {
  for (const signed of [capturePayload(alice, challenge, sha256(photo), ""),
    certificationPayload(alice, challenge, sha256(photo), "video"),
    certificationPayload(alice, challenge, sha256("altered"), "photo")]) {
    const b = backend();
    await assert.rejects(certifyMedia(b.client, alice, request(photo, "photo", signed)), { status: 403 });
    assert.equal(b.receipt(), undefined);
    assert.equal(b.objects.size, 0);
  }
  const b = backend();
  await assert.rejects(certifyMedia(b.client, alice, request(Buffer.from("<html>"), "video")), { status: 400 });
  assert.equal(b.receipt(), undefined);
});

for (const format of ["mov", "mp4"] as const) {
  test(`certifies ${format} camera footage as a muted, metadata-stripped H.264 MP4`, async () => {
    const b = backend();
    const source = await movie(format);
    assert.ok(source.includes("private-test-title"));
    const result = await certifyMedia(b.client, alice, request(source, "video"));
    const display = b.objects.get(result.id + "/media.mp4")!;
    assert.equal(result.status, "queued");
    assert.equal(b.receipt()!.source_hash, sha256(source));
    assert.equal(b.receipt()!.display_hash, sha256(display));
    assert.ok(display.includes("avc1"));
    assert.ok(!display.includes("soun"));
    assert.ok(!display.includes("private-test-title"));
    assert.ok(!display.includes("+37.5000+127.0000/"));
    assert.deepEqual(await sanitizeVideo(source), display);
  });
}

test("rejects excessive clip duration, broken containers and invalid or oversized base64", async () => {
  const long = await movie("mp4", CAPTURE_CERT_VIDEO_SECONDS + 1.5);
  await assert.rejects(sanitizeVideo(long), { status: 400 });
  await assert.rejects(sanitizeVideo(long.subarray(0, long.length - 20)), { status: 400 });
  const broken = await movie("mp4");
  const media = broken.indexOf("mdat");
  assert.ok(media >= 4);
  const end = media - 4 + broken.readUInt32BE(media - 4);
  broken.fill(0, media + 4, end);
  await assert.rejects(sanitizeVideo(broken), { status: 400 });
  for (const value of ["", "AAA", "AA=A", "AQ/=", "%%%%"]) {
    assert.throws(() => decodeCaptureBytes(value, CAPTURE_CERT_MAX_BYTES, "촬영"), ApiError);
  }
  const large = Buffer.alloc(CAPTURE_CERT_MAX_BYTES);
  assert.deepEqual(decodeCaptureBytes(large.toString("base64"), CAPTURE_CERT_MAX_BYTES, "촬영"), large);
  assert.throws(() => decodeCaptureBytes(Buffer.alloc(CAPTURE_CERT_MAX_BYTES + 1).toString("base64"), CAPTURE_CERT_MAX_BYTES, "촬영"), { status: 413 });
});

test("certifies the entire fifteen-second recording within the private object size limit", async () => {
  const b = backend();
  const source = await movie("mp4", CAPTURE_CERT_VIDEO_SECONDS);
  const saved = await certifyMedia(b.client, alice, request(source, "video"));
  const display = b.objects.get(saved.id + "/media.mp4")!;
  assert.ok(display.length > 0 && display.length <= CAPTURE_CERT_MAX_BYTES);
  const header = display.indexOf("mvhd") + 4;
  assert.equal(display[header], 0);
  const seconds = display.readUInt32BE(header + 16) / display.readUInt32BE(header + 12);
  assert.equal(seconds, CAPTURE_CERT_VIDEO_SECONDS);
});
