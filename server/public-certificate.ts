import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { CAPTURE_CERT_MAX_BYTES, exampleToken, validShareToken } from "../shared/media-certificate.js";
import { certificateCommitment } from "./certificate-commitment.js";
import { exampleReader } from "./certificate-examples.js";
import { verifyMint } from "./nft-ledger.js";

const privateHeaders = {
  "Cache-Control": "private, no-store, no-transform",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const fields = "id,media_kind,source_hash,display_hash,salt,commitment,state,tx_hash,token_id,issuer,object_path,platform" as const;

export interface PublicCertificateRow {
  id: string;
  media_kind: "photo" | "video";
  source_hash: string;
  display_hash: string;
  salt: string;
  commitment: string;
  state: string;
  tx_hash: string | null;
  token_id: string | null;
  issuer: string | null;
  object_path: string;
  platform: string;
}

export interface CertificateReader {
  find(shareHash: string): Promise<PublicCertificateRow | null>;
  download(path: string): Promise<Blob>;
  stillShared(shareHash: string, row: PublicCertificateRow): Promise<boolean>;
  verifyMint: typeof verifyMint;
}

function storageReader(column: "share_hash" | "id"): CertificateReader {
  const deadline = AbortSignal.timeout(22_000);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Certificate storage is not configured");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, init) => fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
      }),
    },
  });
  return {
    async find(key) {
      const { data, error } = await client.from("media_certificates").select(fields)
        .eq(column, key).maybeSingle();
      if (error) throw error;
      return data;
    },
    async download(path) {
      const { data, error } = await client.storage.from("certificate-media").download(path);
      if (error) throw error;
      return data;
    },
    async stillShared(key, row) {
      let query = client.from("media_certificates").select("id")
        .eq(column, key).eq("commitment", row.commitment)
        .eq("platform", row.platform).eq("media_kind", row.media_kind).eq("source_hash", row.source_hash)
        .eq("display_hash", row.display_hash).eq("salt", row.salt);
      if (column !== "id") query = query.eq("id", row.id);
      // A queued certificate may finish minting during download. Already-minted
      // records must still carry the exact receipt we checked before delivery.
      query = row.state === "queued" ? query.in("state", ["queued", "minted"]) :
        query.eq("state", "minted").eq("tx_hash", row.tx_hash!).eq("token_id", row.token_id!).eq("issuer", row.issuer!);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    verifyMint,
  };
}

function unavailable(status: number) {
  return new Response(null, { status, headers: privateHeaders });
}

export async function publicCertificate(request: Pick<Request, "method" | "url">, reader?: CertificateReader): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET, HEAD" } });
  const tokens = new URL(request.url).searchParams.getAll("token");
  if (tokens.length !== 1 || !validShareToken(tokens[0])) return unavailable(404);
  const token = tokens[0];
  const key = createHash("sha256").update(token).digest("hex");
  return verifyCertificate(request.method, "share_hash", key, exampleToken(token) ? token : null, reader);
}

// Only the stack handler calls this after resolving a specific membership. It
// re-resolves that same membership before returning these verified bytes.
export function stackCertificate(method: string, sourceId: string) {
  return verifyCertificate(method, "id", sourceId, null);
}

async function verifyCertificate(method: string, column: "share_hash" | "id", key: string, example: "example-photo" | "example-video" | null, reader?: CertificateReader) {
  try {
    const store = reader ?? (example ? exampleReader(example) : storageReader(column));
    const row = await store.find(key);
    if (!row || row.state === "uploading") return unavailable(404);
    if (row.state !== "minted" && row.state !== "queued") return unavailable(409);
    const video = row.media_kind === "video";
    if ((!video && row.media_kind !== "photo") ||
        (example ? row.platform !== "example" || example !== `example-${row.media_kind}` || row.state !== "minted"
          : row.platform !== "android" && row.platform !== "ios") ||
        row.object_path !== `${row.id}/media.${video ? "mp4" : "jpg"}` ||
        certificateCommitment(row.id, row.media_kind, row.source_hash, row.display_hash, row.salt) !== row.commitment)
      return unavailable(409);

    const headers = new Headers(privateHeaders);
    if (row.state === "minted") {
      if (!row.tx_hash || !row.token_id || !row.issuer || !await store.verifyMint({
        txHash: row.tx_hash, tokenId: row.token_id, issuer: row.issuer, commitment: row.commitment,
      })) return unavailable(409);
      headers.set("X-Certificate-Tx", row.tx_hash);
      headers.set("X-Certificate-Token", row.token_id);
    }
    let bytes: ArrayBuffer | null = null;
    // HEAD authenticates the digest for a viewer that already holds the verified bytes.
    if (method === "GET") {
      const file = await store.download(row.object_path);
      if (!file.size || file.size > CAPTURE_CERT_MAX_BYTES) return unavailable(409);
      bytes = await file.arrayBuffer();
      if (createHash("sha256").update(Buffer.from(bytes)).digest("hex") !== row.display_hash) return unavailable(409);
    }
    // A revocation or link rotation can race the ledger/storage reads.
    if (!await store.stillShared(key, row)) return unavailable(404);

    headers.set("Content-Type", video ? "video/mp4" : "image/jpeg");
    headers.set("X-Certificate-State", row.state);
    headers.set("X-Certificate-Origin", row.platform);
    headers.set("X-Display-SHA256", row.display_hash);
    return new Response(bytes, { headers });
  } catch {
    return unavailable(503);
  }
}
