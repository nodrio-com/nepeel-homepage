import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { CAPTURE_CERT_MAX_BYTES } from "../../shared/media-certificate.js";
import { required } from "../../server/env.js";
import { stackHeaders } from "../../server/stack-share.js";

export const config = { path: "/api/stack-preview/*" };
let client: SupabaseClient | undefined;

export default async function stackPreview(request: Request) {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...stackHeaders, Allow: "GET" } });
  const failure = (status: number) => new Response(null, { status, headers: stackHeaders });
  const match = /^\/api\/stack-preview\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/.exec(new URL(request.url).pathname);
  if (!match) return failure(404);
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer) return failure(401);
  try {
    client ??= createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const member = await client.auth.getUser(bearer[1]);
    if (member.error || !member.data.user) return failure(401);
    const { data: row, error } = await client.from("media_certificates")
      .select("object_path,media_kind,display_hash").eq("id", match[1]).eq("user_id", member.data.user.id)
      .in("state", ["queued", "minted"]).maybeSingle();
    if (error) return failure(503);
    if (!row) return failure(404);
    const { data, error: storageError } = await client.storage.from("certificate-media").download(row.object_path);
    if (storageError || !data) return failure(503);
    if (!data.size || data.size > CAPTURE_CERT_MAX_BYTES) return failure(409);
    const bytes = await data.arrayBuffer();
    if (createHash("sha256").update(Buffer.from(bytes)).digest("hex") !== row.display_hash) return failure(409);
    return new Response(bytes, {
      headers: { ...stackHeaders, "Content-Type": row.media_kind === "video" ? "video/mp4" : "image/jpeg" },
    });
  } catch {
    return failure(503);
  }
}
