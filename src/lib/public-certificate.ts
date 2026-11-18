import { CAPTURE_CERT_MAX_BYTES, exampleToken } from "../../shared/media-certificate";

export type CertificateProblem = "missing" | "mismatch" | "unavailable";
type CertificateStatus = {
  state: "minted" | "queued";
  hash: string;
  txHash: string | null;
  tokenId: string | null;
  origin: "example" | "ios" | "android";
  video: boolean;
};

export async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function requestCertificate(token: string, method: "GET" | "HEAD", signal: AbortSignal) {
  return fetch(`/api/certificate?token=${encodeURIComponent(token)}`, {
    method, signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
  });
}

function readStatus(response: Response, token: string): CertificateStatus | CertificateProblem {
  if (response.status === 404) return "missing";
  if (response.status === 409) return "mismatch";
  if (!response.ok) return "unavailable";
  const state = response.headers.get("X-Certificate-State");
  const hash = response.headers.get("X-Display-SHA256");
  const txHash = response.headers.get("X-Certificate-Tx");
  const tokenId = response.headers.get("X-Certificate-Token");
  const origin = response.headers.get("X-Certificate-Origin");
  const mime = response.headers.get("Content-Type");
  const video = mime === "video/mp4";
  if ((!video && mime !== "image/jpeg") || (origin !== "example" && origin !== "android" && origin !== "ios"))
    return "unavailable";
  if (exampleToken(token) ? origin !== "example" || token !== `example-${video ? "video" : "photo"}` || state !== "minted"
    : origin === "example") return "mismatch";
  if ((state !== "queued" && state !== "minted") || !hash || !/^[a-f0-9]{64}$/.test(hash) ||
      (state === "minted" ? !/^[A-F0-9]{64}$/.test(txHash ?? "") || !/^[A-F0-9]{64}$/.test(tokenId ?? "")
        : txHash !== null || tokenId !== null))
    return "unavailable";
  return { state, hash, txHash, tokenId, origin, video };
}

export async function getCertificateStatus(token: string, signal: AbortSignal) {
  return readStatus(await requestCertificate(token, "HEAD", signal), token);
}

export async function loadCertificate(token: string, signal: AbortSignal): Promise<CertificateProblem | (CertificateStatus & { file: Blob })> {
  if (!token) return "missing";
  const response = await requestCertificate(token, "GET", signal);
  const status = readStatus(response, token);
  if (typeof status === "string") return status;
  const file = await response.blob();
  if ((file.type !== "image/jpeg" && file.type !== "video/mp4") || !file.size ||
      file.size > CAPTURE_CERT_MAX_BYTES || await sha256(file) !== status.hash) return "mismatch";
  return { ...status, file };
}
