import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac, randomBytes } from "node:crypto";
import { ApiError, sha256, uuid } from "./validation.js";
import { required } from "./env.js";

export function shareToken(id: string, nonce: string) {
  const key = required("CERTIFICATE_LINK_SECRET");
  if (Buffer.byteLength(key) < 32)
    throw new Error("certificate_link_key_too_short");
  return createHmac("sha256", key)
    .update(`nepeel.share.v1:${id}:${nonce}`)
    .digest("base64url");
}

export async function listCertificates(
  client: SupabaseClient,
  userId: string,
  before?: unknown,
) {
  let query = client
    .from("media_certificates")
    .select("id,media_kind,state,created_at,share_hash")
    .eq("user_id", userId)
    .neq("state", "uploading")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  if (before !== undefined) {
    const cursor =
      typeof before === "object" && before !== null
        ? (before as Record<string, unknown>)
        : null;
    const timestamp = cursor ? cursor.createdAt : before;
    if (
      typeof timestamp !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(
        timestamp,
      ) ||
      !Number.isFinite(Date.parse(timestamp))
    )
      throw new ApiError(400, "조회 날짜를 확인해 주세요.");
    query = cursor
      ? query.or(
          `created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${uuid(cursor.id)})`,
        )
      : query.lt("created_at", timestamp);
  }
  const { data, error } = await query;
  if (error) throw new ApiError(503, "촬영 기록을 불러오지 못했어요.");
  return {
    items: (data ?? []).map((row) => ({
      id: row.id,
      mediaKind: row.media_kind,
      createdAt: row.created_at,
      status: row.state,
      shared: !!row.share_hash,
    })),
  };
}

export async function changeCertificateShare(
  client: SupabaseClient,
  userId: string,
  idValue: unknown,
  revoke: boolean,
) {
  const id = uuid(idValue).toLowerCase();
  if (revoke) {
    const { data, error } = await client
      .from("media_certificates")
      .update({ share_hash: null, share_nonce: null })
      .eq("user_id", userId)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) throw new ApiError(503, "링크를 해제하지 못했어요.");
    if (!data) throw new ApiError(404, "촬영 기록을 찾을 수 없어요.");
    return { revoked: true };
  }
  const origin = new URL(required("CERTIFICATE_PUBLIC_ORIGIN"));
  if (origin.protocol !== "https:" || origin.username || origin.password)
    throw new Error("invalid_certificate_origin");
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: row, error } = await client
      .from("media_certificates")
      .select("id,share_nonce,share_hash")
      .eq("user_id", userId)
      .eq("id", id)
      .neq("state", "uploading")
      .maybeSingle();
    if (error) throw new ApiError(503, "공유 링크를 만들지 못했어요.");
    if (!row) throw new ApiError(404, "촬영 기록을 찾을 수 없어요.");
    const nonce = row.share_nonce ?? randomBytes(32).toString("hex");
    const token = shareToken(id, nonce);
    const hash = sha256(token);
    const url = new URL("/verify/" + token, origin.origin).href;
    if (row.share_hash === hash) return { url };
    let update = client
      .from("media_certificates")
      .update({ share_nonce: nonce, share_hash: hash })
      .eq("id", id)
      .eq("user_id", userId);
    update = row.share_hash
      ? update.eq("share_hash", row.share_hash)
      : update.is("share_hash", null);
    const saved = await update.select("id").maybeSingle();
    if (saved.error) throw new ApiError(503, "공유 링크를 만들지 못했어요.");
    if (saved.data) return { url };
  }
  throw new ApiError(409, "링크가 변경되었어요. 다시 공유해 주세요.");
}
