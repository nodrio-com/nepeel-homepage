import { useState } from "react";
import { Copy, Link2Off, Send } from "lucide-react";
import { Dialog } from "../App";
import { supabase } from "../lib/supabase";

export async function deliverPostLink(url: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "nepeel · 공유된 게시물", url });
      return "공유를 마쳤어요.";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "링크를 복사했어요.";
  } catch {
    return "아래 링크를 선택해 복사할 수 있어요.";
  }
}

export interface SharedLink {
  postId: string;
  userId: string;
  url: string;
  status: string;
}

export function PostShareDialog({ link, close, onRevoked }: {
  link: SharedLink;
  close(): void;
  onRevoked(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function revoke() {
    if (!supabase || busy) return;
    setBusy(true);
    setError("");
    try {
      const { error } = await supabase.rpc("set_post_share_link", { p_post: link.postId, p_enabled: false });
      if (error) throw error;
      onRevoked();
    } catch {
      setError("링크를 끊지 못했어요. 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  return <Dialog title="게시물 공유" close={close}>
    <div className="form-stack">
      <p>링크를 받은 사람은 로그인 없이 이 게시물을 볼 수 있어요.</p>
      <label>공유 링크
        <input type="url" readOnly value={link.url} onFocus={e => e.target.select()} />
      </label>
      <button className="dark-button" disabled={busy} onClick={async () => {
        setBusy(true);
        try { setStatus(await deliverPostLink(link.url)); } finally { setBusy(false); }
      }}>
        {typeof navigator.share === "function" ? <Send size={16}/> : <Copy size={16}/>}
        {typeof navigator.share === "function" ? "링크 공유" : "링크 복사"}
      </button>
      <button className="outline-button" disabled={busy} onClick={() => void revoke()}>
        <Link2Off size={16}/> 공유 링크 끊기
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p role="status">{status || link.status}</p>
    </div>
  </Dialog>;
}
