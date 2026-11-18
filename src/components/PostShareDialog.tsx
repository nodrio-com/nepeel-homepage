import { useEffect, useRef, useState } from "react";
import { Check, Link2Off, LoaderCircle, Send } from "lucide-react";
import { Dialog } from "../App";
import { deliverMediaLink } from "../lib/share-link";
import { supabase } from "../lib/supabase";

export function PostShareDialog({ url, close }: { url: string; close: () => void }) {
  return <Dialog title="공유 링크" close={close}>
    <label className="manual-link">링크 복사
      <input type="url" value={url} readOnly onFocus={e => e.target.select()} autoFocus />
    </label>
  </Dialog>;
}

export function OwnerShareActions({ postId, manual, manage = true }: {
  postId: string; manual: (url: string) => void; manage?: boolean;
}) {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const request = ++current.current;
    if (manage && supabase) void supabase.rpc("has_own_post_share_link", { p_post: postId }).then(({ data }) => {
      if (current.current === request) setActive(data === true);
    });
    return () => { ++current.current; };
  }, [postId, manage]);

  async function change(enabled: boolean) {
    if (!supabase || busy.current) return;
    const request = ++current.current;
    busy.current = true;
    setPending(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("set_post_share_link", { p_post: postId, p_enabled: enabled });
      if (request !== current.current) return;
      if (error || (enabled && (typeof data !== "string" || !/^[\w-]{43}$/.test(data)))) throw new Error();
      setActive(enabled);
      if (!enabled) { setMessage("공유 해제됨"); return; }
      const url = new URL("/s/" + data, location.origin).href;
      const outcome = await deliverMediaLink(url, "nepeel · 게시물");
      if (request !== current.current) return;
      if (outcome === "copied") setMessage("링크 복사됨");
      if (outcome === "manual") manual(url);
    } catch {
      if (request === current.current) setMessage(enabled ? "공유하지 못했어요. 다시 시도해 주세요." : "링크를 끊지 못했어요. 다시 시도해 주세요.");
    } finally {
      if (request === current.current) { busy.current = false; setPending(false); }
    }
  }
  return <>
    <button type="button" className="icon-button" aria-label="공개 링크로 게시물 공유"
      disabled={pending} onClick={() => void change(true)}>
      {pending ? <LoaderCircle className="spin" /> : message === "링크 복사됨" ? <Check /> : <Send />}
    </button>
    {manage && active && <button type="button" className="text-button owner-unshare" disabled={pending}
      onClick={() => void change(false)}><Link2Off size={15} aria-hidden="true" />링크 끊기</button>}
    {message && <span className="owner-share-status" role="status">{message}</span>}
  </>;
}
