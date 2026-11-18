import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { required } from "../../server/env.js";
import { servePostShare } from "../../server/post-share.js";

export const config = { path: "/s/*" };

let client: SupabaseClient | undefined;
function storageClient() {
  return client ??= createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function fetchPostMedia(path: string, incoming: Request) {
  const { data, error } = await storageClient().storage.from("captures").createSignedUrl(path, 30);
  if (error || !data?.signedUrl) throw error || new Error("Storage unavailable");
  const range = incoming.headers.get("range");
  return fetch(data.signedUrl, {
    method: incoming.method,
    headers: range ? { Range: range } : {},
    signal: incoming.signal,
    redirect: "error",
  });
}

export default function postShare(request: Request) {
  return servePostShare(request, {
    async resolve(token) {
      const { data, error } = await storageClient().rpc("resolve_post_share", { p_token: token }).maybeSingle();
      if (error) throw error;
      return data as { image_path: string; caption: string; mime_type: string | null } | null;
    },
    media: fetchPostMedia,
  });
}
