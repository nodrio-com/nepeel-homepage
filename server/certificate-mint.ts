import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareMint, submitOrCheckMint } from "./nft-ledger.js";
import { setTimeout as delay } from "node:timers/promises";
import { certificateService } from "./certificate-service.js";

// Provider-managed background work starts at capture time. The database queue
// survives any function timeout and is also drained by the scheduled worker.
export async function mintAfterCapture() {
  try {
    const client = certificateService();
    if (await runCertificateMint(client) === "pending") {
      await delay(6_000);
      await runCertificateMint(client);
    }
  } catch {
    console.warn("certificate_mint_retry_scheduled");
  }
}

export async function runCertificateMint(client: SupabaseClient) {
  const { data, error } = await client.rpc("lease_certificate_mint");
  if (error) throw new Error("certificate_mint_queue_unavailable");
  const row = data?.[0];
  if (!row) return "idle";
  const save = async (patch: Record<string, unknown>) => {
    const result = await client
      .from("media_certificates")
      .update(patch)
      .eq("id", row.id)
      .eq("state", "queued")
      .eq("lease", row.lease)
      .select("id")
      .maybeSingle();
    if (result.error || !result.data) throw new Error("certificate_lease_lost");
  };
  const release = { lease: null, lease_until: null };
  try {
    const prepared = row.tx_blob
      ? {
          blob: String(row.tx_blob),
          hash: String(row.tx_hash),
          lastLedger: Number(row.last_ledger),
        }
      : await prepareMint(row.commitment);
    if (!row.tx_blob)
      await save({
        tx_hash: prepared.hash,
        tx_blob: prepared.blob,
        last_ledger: prepared.lastLedger,
      });
    const result = await submitOrCheckMint(prepared, row.commitment);
    if (result.state === "minted") {
      await save({
        ...release,
        state: "minted",
        issuer: result.issuer,
        token_id: result.tokenId,
        tx_hash: result.txHash,
        tx_blob: null,
      });
    } else if (result.state === "expired") {
      await save({
        ...release,
        tx_hash: null,
        tx_blob: null,
        last_ledger: null,
        next_attempt: new Date().toISOString(),
      });
    } else {
      await save({
        ...release,
        next_attempt: new Date(Date.now() + 5_000).toISOString(),
      });
    }
    return result.state;
  } catch (error) {
    // Keep the identical signed transaction on any ambiguous network result.
    await save({
      ...release,
      next_attempt: new Date(Date.now() + 30_000).toISOString(),
    }).catch(() => {});
    throw error;
  }
}

export async function cleanupCertificates(client: SupabaseClient) {
  const expired = await client
    .from("media_certificates")
    .delete()
    .eq("state", "uploading")
    .lt("created_at", new Date(Date.now() - 86_400_000).toISOString());
  if (expired.error) throw new Error("certificate_expiry_unavailable");
  const jobs = await client
    .from("certificate_cleanup")
    .select("object_path")
    .lte("not_before", new Date().toISOString())
    .limit(100);
  if (jobs.error) throw new Error("certificate_cleanup_unavailable");
  const paths = (jobs.data ?? []).map((r) => String(r.object_path));
  if (paths.length) {
    const removed = await client.storage
      .from("certificate-media")
      .remove(paths);
    if (removed.error) throw new Error("certificate_delete_unavailable");
    const ack = await client
      .from("certificate_cleanup")
      .delete()
      .in("object_path", paths);
    if (ack.error) throw new Error("certificate_cleanup_unavailable");
  }
  return paths.length;
}
