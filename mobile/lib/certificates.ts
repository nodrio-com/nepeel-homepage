import { AppState, Platform, Share } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { CAPTURE_CERT_MAX_BYTES } from "../../shared/media-certificate";
import type { Challenge } from "../../shared/types";
import { captureApi, CaptureApiError, certifyFile, type CertificateReceipt, type MediaKind } from "./capture";

export type Certificate = CertificateReceipt & {
  mediaKind: MediaKind;
  createdAt: string;
  shared: boolean;
};
export type PendingCapture = {
  challenge: Challenge;
  mediaKind: MediaKind;
  createdAt: string;
  error?: string;
  hasOriginal?: boolean;
};
type QueueEvent = { owner: string; challengeId?: string; receipt?: CertificateReceipt; error?: string };
const listeners = new Set<(event: QueueEvent) => void>();
export function observeCertificates(listener: (event: QueueEvent) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function announce(event: QueueEvent) {
  for (const listener of listeners) listener(event);
}

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const writing = new Set<string>();
function folder(owner: string) {
  if (!uuid.test(owner)) throw new Error("계정을 확인해 주세요.");
  return new Directory(Paths.document, "certificate-queue", owner);
}
function jobFolder(owner: string, id: string) {
  if (!uuid.test(id)) throw new Error("촬영 인증 번호를 확인해 주세요.");
  return new Directory(folder(owner), id);
}
function originalFile(directory: Directory, kind: MediaKind) {
  const extension = kind === "photo" ? "jpg" : Platform.OS === "ios" ? "mov" : "mp4";
  return new File(directory, `original.${extension}`);
}

// The directory becomes visible to the worker only after the bytes and metadata
// are both present. Persist relative names so an iOS container move is harmless.
export async function saveCapture(owner: string, challenge: Challenge, mediaKind: MediaKind, uri: string) {
  const source = new File(uri);
  if (!source.exists || !source.size) throw new Error("촬영 파일을 읽지 못했어요. 다시 촬영해 주세요.");
  const sizeError = source.size > CAPTURE_CERT_MAX_BYTES ? "2MB를 초과해 인증할 수 없어요. 원본은 이 기기에 저장했어요." : undefined;
  const directory = folder(owner);
  const destination = jobFolder(owner, challenge.id);
  directory.create({ idempotent: true, intermediates: true });
  if (destination.exists) return;
  const staging = new Directory(directory, `saving-${challenge.id}`);
  staging.create();
  const stagingUri = staging.uri;
  writing.add(stagingUri);
  try {
    new File(staging, "capture.json").write(JSON.stringify({
      challenge, mediaKind, createdAt: new Date().toISOString(), size: source.size,
    }));
    await source.copy(originalFile(staging, mediaKind));
    if (sizeError) new File(staging, "failure.txt").write(sizeError);
    staging.rename(challenge.id);
  } catch (error) {
    if (staging.exists) staging.delete();
    throw error;
  } finally {
    writing.delete(stagingUri);
  }
  announce({ owner, challengeId: challenge.id, error: sizeError });
  retryCertificates(owner);
}

export function pendingCaptures(owner: string): PendingCapture[] {
  const root = folder(owner);
  if (!root.exists) return [];
  return root.list().flatMap(entry => {
    if (!(entry instanceof Directory)) return [];
    // A crash after the copy but before the final rename can still be recovered.
    if (entry.name.startsWith("saving-") && !writing.has(entry.uri)) {
      const id = entry.name.slice(7);
      const meta = new File(entry, "capture.json");
      if (!uuid.test(id)) return [];
      let saved: (PendingCapture & { size: number }) | undefined;
      try { saved = JSON.parse(meta.textSync()); } catch { /* interrupted write */ }
      if (!saved?.size || originalFile(entry, saved.mediaKind).size !== saved.size || jobFolder(owner, id).exists) {
        entry.delete();
        return [];
      }
      entry.rename(id);
    }
    if (!uuid.test(entry.name)) return [];
    const job: PendingCapture = JSON.parse(new File(entry, "capture.json").textSync());
    if (job.challenge.id !== entry.name) return [];
    const failure = new File(entry, "failure.txt");
    return [{ ...job, error: failure.exists ? failure.textSync() : undefined, hasOriginal: originalFile(entry, job.mediaKind).exists }];
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function dismissFailedCapture(owner: string, id: string) {
  const directory = jobFolder(owner, id);
  if (new File(directory, "failure.txt").exists) directory.delete();
  announce({ owner });
}

export function removeAccountCaptures(owner: string) {
  const root = folder(owner);
  if (root.exists) root.delete();
}

export async function shareFailedOriginal(owner: string, job: PendingCapture, stillCurrent: () => boolean) {
  const directory = jobFolder(owner, job.challenge.id);
  const file = originalFile(directory, job.mediaKind);
  if (!new File(directory, "failure.txt").exists || !file.exists)
    throw new Error("저장한 원본을 찾지 못했어요.");
  if (!(await Sharing.isAvailableAsync())) throw new Error("이 기기에서 공유할 수 없어요.");
  if (!stillCurrent()) return;
  const mimeType = job.mediaKind === "photo" ? "image/jpeg" : Platform.OS === "ios" ? "video/quicktime" : "video/mp4";
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: "촬영 원본 공유" });
}

let wake: { owner: string; run: () => void } | null = null;
export function retryCertificates(owner: string) {
  if (wake?.owner === owner) wake.run();
}

export function watchCertificateQueue(owner: string) {
  let active = true;
  let running = false;
  let requested = false;
  let delay = 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const foreground = () => active && AppState.currentState === "active";
  async function drain() {
    if (running || !foreground()) return;
    running = true;
    let retry = false;
    try {
      do {
        requested = false;
        retry = false;
        for (const job of pendingCaptures(owner)) {
          if (!foreground()) break;
          if (job.error) continue;
          const id = job.challenge.id;
          const directory = jobFolder(owner, id);
          try {
            const receipt = await certifyFile(owner, job.challenge, job.mediaKind, originalFile(directory, job.mediaKind));
            // An uploading reservation still needs the original bytes for recovery.
            if (!uuid.test(receipt?.id) || !["queued", "minted"].includes(receipt.status)) {
              retry = true;
              continue;
            }
            directory.delete();
            announce({ owner, challengeId: id, receipt });
          } catch (error) {
            if (error instanceof CaptureApiError && [400, 403, 409, 410, 413, 415, 422].includes(error.status)) {
              new File(directory, "failure.txt").write(error.message);
              announce({ owner, challengeId: id, error: error.message });
            } else retry = true;
          }
        }
      } while (requested && foreground());
    } catch {
      retry = true;
    } finally {
      running = false;
      if (foreground() && retry) {
        timer = setTimeout(() => { void drain(); }, delay);
        delay = Math.min(delay * 2, 60_000);
      } else delay = 5000;
    }
  }
  function run() {
    clearTimeout(timer);
    requested = true;
    void drain();
  }
  wake = { owner, run };
  const listener = AppState.addEventListener("change", state => {
    if (state === "active") run();
    else clearTimeout(timer);
  });
  run();
  return () => {
    active = false;
    if (wake?.run === run) wake = null;
    clearTimeout(timer);
    listener.remove();
  };
}

export async function shareCertificate(owner: string, id: string, stillCurrent: () => boolean) {
  const { url } = await captureApi<{ url: string }>({ action: "shareCertificate", id }, owner);
  if (!stillCurrent()) return;
  await Share.share(Platform.OS === "ios" ? { url } : { message: url });
}
