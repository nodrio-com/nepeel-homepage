import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CAPTURE_CERT_MAX_BYTES, certificationPayload, type CertificateMediaKind,
} from "../shared/media-certificate.js";
import { certificateCommitment } from "./certificate-commitment.js";
import { verifyCaptureProof } from "./publication.js";
import { ApiError, decodeCaptureBytes, sanitizePhoto, sha256, uuid } from "./validation.js";
import { sanitizeVideo } from "./video-media.js";

interface Receipt {
  id: string;
  challenge_id: string;
  user_id: string;
  media_kind: CertificateMediaKind;
  source_hash: string;
  display_hash: string;
  platform: string;
  state: "uploading" | "queued" | "minted";
  object_path: string;
}

const unavailable = () => new ApiError(503, "인증 결과를 확인할 수 없습니다. 같은 촬영으로 다시 시도해 주세요.");

export async function certifyMedia(
  client: SupabaseClient, userId: string, body: Record<string, unknown>, onQueued?: () => void,
): Promise<{ id: string; status: "queued" | "minted" }> {
  const challengeId = uuid(body.challengeId).toLowerCase();
  const kind = body.mediaKind;
  if (kind !== "photo" && kind !== "video") throw new ApiError(400, "촬영 형식이 올바르지 않습니다.");
  const proof = body.proof as Record<string, unknown> | undefined;
  if (!proof || (proof.platform !== "ios" && proof.platform !== "android"))
    throw new ApiError(403, "공식 nepeel 앱에서 촬영해 주세요.");

  const source = decodeCaptureBytes(body.mediaBase64, CAPTURE_CERT_MAX_BYTES, "촬영");
  const sourceHash = sha256(source);
  async function previousReceipt(): Promise<Receipt | null> {
    const { data, error } = await client.from("media_certificates")
      .select("id,challenge_id,user_id,media_kind,source_hash,display_hash,platform,state,object_path")
      .eq("challenge_id", challengeId).eq("user_id", userId).maybeSingle();
    if (error) throw unavailable();
    return data;
  }
  let clean: Buffer | undefined;
  async function render(): Promise<Buffer> {
    if (!clean) clean = kind === "photo" ? await sanitizePhoto(source) : await sanitizeVideo(source);
    if (clean.length > CAPTURE_CERT_MAX_BYTES) throw new ApiError(413, "처리된 촬영 파일이 너무 큽니다.");
    return clean;
  }

  let receipt = await previousReceipt();
  if (!receipt) {
    try {
      const attempts = await client.rpc("begin_capture_attempt", {
        p_id: challengeId, p_user: userId, p_purpose: "certify",
      });
      if (attempts.error && attempts.error.code !== "P0001") throw unavailable();
      const challenge = attempts.data?.[0];
      if (!challenge) throw new ApiError(409, "촬영 요청이 만료되었거나 사용되었습니다. 다시 촬영해 주세요.");
      const counter = await verifyCaptureProof(client, userId, proof, certificationPayload(userId, challenge, sourceHash, kind));
      const displayHash = sha256(await render());
      const id = randomUUID();
      const salt = randomBytes(32).toString("hex");
      const reserved = await client.rpc("reserve_media_certificate", {
        p_challenge: challengeId, p_user: userId, p_id: id, p_kind: kind,
        p_source_hash: sourceHash, p_display_hash: displayHash, p_salt: salt,
        p_commitment: certificateCommitment(id, kind, sourceHash, displayHash, salt),
        p_platform: proof.platform, ...counter,
      });
      if (reserved.error || !reserved.data?.[0]) throw unavailable();
      receipt = reserved.data[0] as Receipt;
    } catch (error) {
      // A concurrent verified request can win the nonce/counter, or the
      // reservation can commit before its response is lost.
      receipt = await previousReceipt();
      if (!receipt) throw error;
    }
  }
  if (receipt.user_id !== userId || receipt.challenge_id !== challengeId ||
      receipt.source_hash !== sourceHash || receipt.media_kind !== kind || receipt.platform !== proof.platform)
    throw new ApiError(409, "인증을 시작한 촬영은 변경할 수 없습니다.");
  if (receipt.state === "queued" || receipt.state === "minted") return { id: receipt.id, status: receipt.state };
  if (receipt.state !== "uploading") throw new ApiError(410, "촬영 인증이 종료되었습니다.");

  const bucket = client.storage.from("certificate-media");
  const bytes = await render();
  let verifyStoredBytes = sha256(bytes) !== receipt.display_hash;
  if (!verifyStoredBytes) {
    const uploaded = await bucket.upload(receipt.object_path, bytes, {
      contentType: kind === "photo" ? "image/jpeg" : "video/mp4", upsert: false,
    });
    if (uploaded.error) {
      const code = "code" in uploaded.error ? uploaded.error.code : undefined;
      if (!["409", "ResourceAlreadyExists", "KeyAlreadyExists", "already_exists"].includes(String(code)) &&
          String(uploaded.error.statusCode) !== "409") throw unavailable();
      verifyStoredBytes = true;
    }
  }
  if (verifyStoredBytes) {
    // Also recovers an upload whose response was lost before an encoder update.
    const stored = await bucket.download(receipt.object_path);
    if (stored.error || !stored.data || stored.data.size > CAPTURE_CERT_MAX_BYTES ||
        sha256(Buffer.from(await stored.data.arrayBuffer())) !== receipt.display_hash) throw unavailable();
  }
  const finished = await client.rpc("finish_media_certificate", { p_id: receipt.id, p_user: userId });
  const row = finished.data?.[0] as Receipt | undefined;
  if (finished.error || row?.id !== receipt.id || (row.state !== "queued" && row.state !== "minted")) throw unavailable();
  if (row.state === "queued" && onQueued) {
    try { onQueued(); } catch { console.warn("certificate_mint_retry_scheduled"); }
  }
  return { id: row.id, status: row.state };
}
