import type { Challenge } from "./types";

export type CertificateMediaKind = "photo" | "video";
export const CAPTURE_CERT_MAX_BYTES = 2 * 1024 * 1024;
export const CAPTURE_CERT_VIDEO_SECONDS = 15;

export function exampleToken(token: string): token is "example-photo" | "example-video" {
  return token === "example-photo" || token === "example-video";
}

export function validShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token) || exampleToken(token);
}

export function certificationPayload(
  userId: string,
  challenge: Pick<Challenge, "id" | "nonce">,
  hash: string,
  kind: CertificateMediaKind,
): string {
  return JSON.stringify([
    "nepeel.certify.v1",
    userId,
    challenge.id,
    challenge.nonce,
    kind,
    hash,
  ]);
}
