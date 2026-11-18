import type { SupabaseClient } from "@supabase/supabase-js";

export interface StackRef {
  source: "post" | "certificate";
  id: string;
}

export interface StackSource extends StackRef {
  mediaKind: "photo" | "video";
  caption: string;
  createdAt: string;
  imagePath: string | null;
  shared: boolean;
  inShare: boolean;
}

export interface StackCursor extends StackRef {
  createdAt: string;
}

export interface WorkStack {
  id: string;
  title: string;
  revision: number;
  shareToken: string | null;
  items: StackSource[];
}

async function stackRpc<T>(client: SupabaseClient, name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    if (["22023", "40001", "42501"].includes(error.code) && /[가-힣]/u.test(error.message))
      throw new Error(error.message);
    throw new Error("작업 묶음을 불러오지 못했어요. 다시 시도해 주세요.");
  }
  return data as T;
}

export function listStacks(client: SupabaseClient): Promise<WorkStack[]> {
  return stackRpc(client, "list_work_stacks");
}

export async function listStackSources(client: SupabaseClient, before?: StackCursor) {
  const rows = await stackRpc<StackSource[]>(client, "list_work_stack_sources", {
    p_before_at: before?.createdAt ?? null,
    p_before_id: before?.id ?? null,
    p_before_source: before?.source ?? null,
  });
  const items = rows.slice(0, 40);
  const last = items.at(-1);
  const next: StackCursor | null = last && rows.length > items.length
    ? { createdAt: last.createdAt, source: last.source, id: last.id } : null;
  return { items, next };
}

export function saveStack(client: SupabaseClient, draft: {
  id: string | null; title: string; items: StackRef[]; revision: number | null;
}): Promise<WorkStack> {
  return stackRpc(client, "save_work_stack", {
    p_stack: draft.id, p_title: draft.title, p_items: draft.items.map(({ id, source }) => ({ id, source })),
    p_revision: draft.revision,
  });
}

export function setStackShare(client: SupabaseClient, id: string, enabled: boolean, revision: number): Promise<WorkStack> {
  return stackRpc(client, "set_work_stack_share", { p_stack: id, p_enabled: enabled, p_revision: revision });
}

export function stackPublicPath(token: string) {
  return "/stack/" + encodeURIComponent(token);
}

async function authorization(client: SupabaseClient) {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error("로그인이 필요해요.");
  return "Bearer " + data.session.access_token;
}

export async function setStackSourceShare(client: SupabaseClient, item: StackRef, enabled: boolean): Promise<void> {
  if (item.source === "post") {
    const { error } = await client.rpc("set_post_share_link", { p_post: item.id, p_enabled: enabled });
    if (error) throw new Error("게시물 공유 상태를 바꾸지 못했어요. 다시 시도해 주세요.");
    return;
  }
  const response = await fetch("/api/capture", {
    method: "POST", headers: { Authorization: await authorization(client), "Content-Type": "application/json" },
    body: JSON.stringify({ action: enabled ? "shareCertificate" : "revokeCertificateShare", id: item.id }),
  });
  const result = await response.json().catch(() => null);
  const changed = enabled ? typeof result?.url === "string" && /\/verify\/[\w-]{43}$/.test(result.url)
    : result?.revoked === true;
  if (!response.ok || !changed) throw new Error("촬영 기록 공유 상태를 바꾸지 못했어요. 다시 시도해 주세요.");
}

export async function getStackPreview(client: SupabaseClient, item: StackSource): Promise<Blob> {
  if (item.source === "post" && item.imagePath) {
    const { data, error } = await client.storage.from("captures").download(item.imagePath);
    if (error || !data) throw new Error("미리보기를 불러오지 못했어요.");
    return data;
  }
  const response = await fetch("/api/stack-preview/" + encodeURIComponent(item.id), {
    headers: { Authorization: await authorization(client) }, cache: "no-store",
  });
  if (!response.ok || !/^(image\/jpeg|video\/mp4)(;|$)/i.test(response.headers.get("content-type") ?? ""))
    throw new Error("미리보기를 불러오지 못했어요.");
  return response.blob();
}
