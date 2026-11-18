import { CAPTURE_CERT_MAX_BYTES, exampleToken, validShareToken } from "../../shared/media-certificate";

export interface CertificateLink {
  mediaPath: string;
  example: "example-photo" | "example-video" | null;
}

export function certificateLink(path: string): CertificateLink | null {
  const stack = /^\/verify\/stack\/([A-Za-z0-9_-]{43})\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/?$/.exec(path);
  if (stack) return { mediaPath: `/stack/${stack[1]}/media/${stack[2]}?certificate=1`, example: null };
  const token = /^\/verify\/([^/]+)\/?$/.exec(path)?.[1];
  if (!token || !validShareToken(token)) return null;
  return { mediaPath: "/api/certificate?token=" + encodeURIComponent(token), example: exampleToken(token) ? token : null };
}

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

function requestCertificate(link: CertificateLink, method: "GET" | "HEAD", signal: AbortSignal) {
  return fetch(link.mediaPath, {
    method, signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
  });
}

function readStatus(response: Response, link: CertificateLink): CertificateStatus | CertificateProblem {
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
  if (link.example ? origin !== "example" || link.example !== `example-${video ? "video" : "photo"}` || state !== "minted"
    : origin === "example") return "mismatch";
  if ((state !== "queued" && state !== "minted") || !hash || !/^[a-f0-9]{64}$/.test(hash) ||
      (state === "minted" ? !/^[A-F0-9]{64}$/.test(txHash ?? "") || !/^[A-F0-9]{64}$/.test(tokenId ?? "")
        : txHash !== null || tokenId !== null))
    return "unavailable";
  return { state, hash, txHash, tokenId, origin, video };
}

export async function getCertificateStatus(link: CertificateLink, signal: AbortSignal) {
  return readStatus(await requestCertificate(link, "HEAD", signal), link);
}

export async function loadCertificate(link: CertificateLink, signal: AbortSignal): Promise<CertificateProblem | (CertificateStatus & { file: Blob })> {
  const response = await requestCertificate(link, "GET", signal);
  const status = readStatus(response, link);
  if (typeof status === "string") return status;
  const file = await response.blob();
  if ((file.type !== "image/jpeg" && file.type !== "video/mp4") || !file.size ||
      file.size > CAPTURE_CERT_MAX_BYTES || await sha256(file) !== status.hash) return "mismatch";
  return { ...status, file };
}
