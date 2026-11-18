import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { shareToken } from "../../server/certificate-owner.js";
import { publicCertificate, stackCertificate } from "../../server/public-certificate.js";
import { servePostMedia } from "../../server/post-share.js";
import { required } from "../../server/env.js";
import { certificateRange, serveStackShare, type PublicStack } from "../../server/stack-share.js";
import postShare, { fetchPostMedia } from "./post-share.js";

export const config = { path: "/stack/*" };
let client: SupabaseClient | undefined;

export default function stackShare(request: Request) {
  return serveStackShare(request, {
    async resolve(token, itemId) {
      client ??= createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.rpc("resolve_work_stack", { p_token: token, p_item: itemId });
      if (error) throw error;
      return data as PublicStack | null;
    },
    async media(incoming, item) {
      if (item.source === "post") {
        if (item.stackScoped && item.imagePath)
          return servePostMedia(incoming, { image_path: item.imagePath, caption: item.caption, mime_type: item.mimeType ?? null }, fetchPostMedia);
        if (item.stackScoped) return new Response(null, { status: 404 });
        // Invoke the normal /s/ gate internally so the individual bearer is
        // neither embedded in recipient HTML nor sent as a redirect.
        const url = new URL("/s/" + item.credential + "/media", incoming.url);
        const range = incoming.headers.get("range");
        return postShare(new Request(url, {
          method: incoming.method, headers: range ? { Range: range } : {}, signal: incoming.signal,
        }));
      }
      const method = incoming.headers.has("range") ? "GET" : incoming.method;
      if (item.stackScoped) return certificateRange(incoming, await stackCertificate(method, item.sourceId!));
      const url = new URL("/api/certificate", incoming.url);
      url.searchParams.set("token", shareToken(item.sourceId!, item.credential!));
      const result = await publicCertificate({ url: url.href, method });
      return certificateRange(incoming, result);
    },
  });
}
