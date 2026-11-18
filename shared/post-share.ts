import type { SupabaseClient } from "@supabase/supabase-js";

const postToken = /^[A-Za-z0-9_-]{43}$/;

export function postShareUrl(token: string, origin = "https://nepeel.com"): string {
  if (!postToken.test(token)) throw new Error("게시물 공유 링크가 올바르지 않아요.");
  return new URL("/s/" + token, origin).href;
}

export function setOwnPostShare(client: SupabaseClient, postId: string, enabled: true): Promise<string>;
export function setOwnPostShare(client: SupabaseClient, postId: string, enabled: false): Promise<null>;
export function setOwnPostShare(client: SupabaseClient, postId: string, enabled: boolean): Promise<string | null>;
export async function setOwnPostShare(client: SupabaseClient, postId: string, enabled: boolean) {
  const { data, error } = await client.rpc("set_post_share_link", { p_post: postId, p_enabled: enabled });
  if (error) throw error;
  if (!enabled) return null;
  if (typeof data !== "string" || !postToken.test(data)) throw new Error("게시물 공유 링크를 만들지 못했어요.");
  return data;
}
