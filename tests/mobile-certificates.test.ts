import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { CAPTURE_CERT_MAX_BYTES } from "../shared/media-certificate.js";
type Ticket = { id: string; expires_at: string; nonce: string };
type Job = { challenge: Ticket; mediaKind: "photo" | "video"; error?: string };
interface QueueHarness {
  watchCertificateQueue(owner: string): () => void;
  saveCapture(owner: string, ticket: Ticket, kind: Job["mediaKind"], uri: string): Promise<void>;
  pendingCaptures(owner: string): Job[];
  observeCertificates(listener: (event: { receipt?: { id: string } }) => void): () => void;
  retryCertificates(owner: string): void;
  shareFailedOriginal(owner: string, job: Job, stillCurrent: () => boolean): Promise<void>;
  removeAccountCaptures(owner: string): void;
  dismissFailedCapture(owner: string, id: string): void;
}

// Run the native queue against isolated real files. Replace the Expo bridge
// and the server boundary so transport failures and app restarts are controllable.
const code = ts.transpileModule(
  fs.readFileSync(new URL("../mobile/lib/certificates.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
class LocalPath {
  uri: string;
  constructor(...parts: (LocalPath | string)[]) { this.uri = path.join(...parts.map(part => typeof part === "string" ? part : part.uri)); }
  get exists() { return fs.existsSync(this.uri); }
  get name() { return path.basename(this.uri); }
  delete() { fs.rmSync(this.uri, { recursive: true }); }
}
class File extends LocalPath {
  get size() { return this.exists ? fs.statSync(this.uri).size : 0; }
  async copy(to: File) { await fs.promises.copyFile(this.uri, to.uri); }
  write(value: string) { fs.writeFileSync(this.uri, value); }
  textSync() { return fs.readFileSync(this.uri, "utf8"); }
}
class Directory extends LocalPath {
  create(options?: { intermediates?: boolean }) { fs.mkdirSync(this.uri, { recursive: !!options?.intermediates }); }
  list() {
    return fs.readdirSync(this.uri, { withFileTypes: true }).map(item =>
      item.isDirectory() ? new Directory(this, item.name) : new File(this, item.name));
  }
  rename(name: string) {
    const next = path.join(path.dirname(this.uri), name);
    fs.renameSync(this.uri, next);
    this.uri = next;
  }
}
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const alice = "00000000-0000-4000-8000-000000000001", bob = "00000000-0000-4000-8000-000000000002";
const challenge = { id: "00000000-0000-4000-8000-000000000003", expires_at: "2025-01-01", nonce: "one-shot" };
const receipt = { id: "00000000-0000-4000-8000-000000000004", status: "queued" };
function boot(root: string, certifyFile: (owner: string, challenge: { id: string }, kind: string, file: File) => Promise<unknown>) {
  const exports = {};
  const shares: string[] = [];
  const modules: Record<string, object> = {
    "react-native": { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Platform: { OS: "android" } },
    "expo-file-system": { File, Directory, Paths: { document: new Directory(root) } },
    "expo-sharing": { isAvailableAsync: async () => true, shareAsync: async (uri: string) => { shares.push(uri); } },
    "../../shared/media-certificate": { CAPTURE_CERT_MAX_BYTES },
    "./capture": { CaptureApiError: ApiError, certifyFile },
  };
  runInNewContext(code, { exports, require: (id: string) => modules[id], setTimeout, clearTimeout });
  return { queue: exports as QueueHarness, shares };
}

test("a lost upload response survives restart, another owner cannot consume it, and retries reuse the original challenge and bytes", async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "nepeel-cert-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new File(root, "camera.mp4");
  source.write("original video bytes");
  const requests: string[][] = [];
  const capture = async (owner: string, ticket: { id: string }, kind: string, file: File) => {
    requests.push([owner, ticket.id, kind, file.textSync()]);
    if (requests.length === 1) throw new Error("response lost");
    return receipt;
  };
  const first = boot(root, capture).queue;
  const stop = first.watchCertificateQueue(alice);
  await first.saveCapture(alice, challenge, "video", source.uri);
  await new Promise(resolve => setImmediate(resolve));
  stop();
  source.delete();
  assert.equal(first.pendingCaptures(alice).length, 1);
  const restarted = boot(root, capture).queue;
  const stopBob = restarted.watchCertificateQueue(bob);
  assert.equal(restarted.pendingCaptures(bob).length, 0);
  stopBob();
  const completed = new Promise<void>(resolve => restarted.observeCertificates(event => {
    if (event.receipt?.id === receipt.id) resolve();
  }));
  const stopAlice = restarted.watchCertificateQueue(alice);
  t.after(stopAlice);
  restarted.retryCertificates(alice);
  restarted.retryCertificates(alice);
  await completed;
  assert.equal(restarted.pendingCaptures(alice).length, 0);
  assert.deepEqual(requests, [
    [alice, challenge.id, "video", "original video bytes"],
    [alice, challenge.id, "video", "original video bytes"],
  ]);
});

test("a rejected certificate retains a shareable private original until its owner deletes it or their account", async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "nepeel-cert-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { queue, shares } = boot(root, async () => { throw new ApiError(410, "expired"); });
  const file = new File(root, "camera.jpg"); file.write("photo");
  const stop = queue.watchCertificateQueue(alice);
  t.after(stop);
  await queue.saveCapture(alice, challenge, "photo", file.uri);
  await new Promise(resolve => setImmediate(resolve));
  const [failed] = queue.pendingCaptures(alice);
  assert.equal(failed.error, "expired");
  await assert.rejects(queue.shareFailedOriginal(bob, failed, () => true));
  await queue.shareFailedOriginal(alice, failed, () => false);
  assert.equal(shares.length, 0);
  await queue.shareFailedOriginal(alice, failed, () => true);
  assert.equal(fs.readFileSync(shares[0], "utf8"), "photo");
  await queue.saveCapture(bob, challenge, "photo", file.uri);
  queue.removeAccountCaptures(alice);
  assert.equal(fs.existsSync(shares[0]), false);
  assert.equal(queue.pendingCaptures(bob).length, 1);
});

test("recover a complete staging copy after a crash; an oversized original is only available locally", async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "nepeel-cert-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new File(root, "camera.jpg");
  fs.writeFileSync(source.uri, Buffer.alloc(CAPTURE_CERT_MAX_BYTES + 1));
  let attempts = 0;
  const { queue } = boot(root, async () => { attempts++; return receipt; });
  await queue.saveCapture(alice, challenge, "photo", source.uri);
  const directory = new Directory(root, "certificate-queue", alice, challenge.id);
  directory.rename("saving-" + challenge.id);
  const [recovered] = queue.pendingCaptures(alice);
  assert.equal(recovered.challenge.id, challenge.id);
  assert.match(recovered.error!, /2MB/);
  const stop = queue.watchCertificateQueue(alice);
  t.after(stop);
  assert.equal(attempts, 0);
  queue.dismissFailedCapture(alice, recovered.challenge.id);
  assert.equal(queue.pendingCaptures(alice).length, 0);
});
