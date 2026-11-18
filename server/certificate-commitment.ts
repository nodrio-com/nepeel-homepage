import { createHash } from "node:crypto";
import type { CertificateMediaKind } from "../shared/media-certificate.js";

export function certificateCommitment(
  id: string,
  kind: CertificateMediaKind,
  sourceHash: string,
  displayHash: string,
  salt: string,
): string {
  const manifest = JSON.stringify([
    "nepeel.media-certificate.v1",
    id,
    kind,
    sourceHash,
    displayHash,
    salt,
  ]);
  return createHash("sha256").update(manifest, "utf8").digest("hex");
}
