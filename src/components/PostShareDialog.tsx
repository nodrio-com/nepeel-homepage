import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Link2Off, LoaderCircle, Send } from "lucide-react";
import { postShareUrl, setOwnPostShare } from "../../shared/post-share";
import { deliverMediaLink } from "../lib/share-link";
import { supabase } from "../lib/supabase";

export { ShareLinkDialog as PostShareDialog } from "./ShareLinkDialog";

export function OwnerShareActions({ postId, manual, manage = true }: {
  postId: string; manual: (url: string, opener: HTMLButtonElement) => void; manage?: boolean;
}) {
  const [linkState, setLinkState] = useState<"inactive" | "active" | "unknown">("inactive");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef(0);
  const linkRevision = useRef(0);
  const busy = useRef(false);
  useLayoutEffect(() => {
    const revision = ++linkRevision.current;
    const readState = (state: "inactive" | "active" | "unknown") => {
      if (linkRevision.current === revision) setLinkState(state);
    };
    busy.current = false;
    setPending(false);
    setLinkState("inactive");
    setMessage("");
    if (manage && supabase) void Promise.resolve(supabase.rpc("has_own_post_share_link", { p_post: postId }))
      .then(({ data, error }) => readState(error ? "unknown" : data === true ? "active" : "inactive"))
      .catch(() => readState("unknown"));
    return () => { ++current.current; ++linkRevision.current; };
  }, [postId, manage]);
  useEffect(() => {
    if (message !== "링크 복사됨") return;
    const timeout = window.setTimeout(() => setMessage(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [message]);

  async function change(enabled: boolean, opener: HTMLButtonElement) {
    if (!supabase || busy.current) return;
    const request = ++current.current;
    const route = location.hash;
    busy.current = true;
    setPending(true);
    setMessage("");
    try {
      const token = await setOwnPostShare(supabase, postId, enabled);
      if (request !== current.current) return;
      ++linkRevision.current;
      setLinkState(enabled ? "active" : "inactive");
      if (location.hash !== route || !opener.isConnected) return;
      if (token === null) { setMessage("공유 해제됨"); return; }
      const url = postShareUrl(token, location.origin);
      const outcome = await deliverMediaLink(url, "nepeel · 게시물");
      if (request !== current.current || location.hash !== route || !opener.isConnected) return;
      if (outcome === "copied") setMessage("링크 복사됨");
      if (outcome === "manual") manual(url, opener);
    } catch {
      if (request === current.current && location.hash === route && opener.isConnected)
        setMessage(enabled ? "공유하지 못했어요. 다시 시도해 주세요." : "링크를 끊지 못했어요. 다시 시도해 주세요.");
    } finally {
      if (request === current.current) { busy.current = false; setPending(false); }
    }
  }
  return <>
    <button type="button" className="icon-button" aria-label="공개 링크로 게시물 공유"
      aria-disabled={pending} onClick={event => void change(true, event.currentTarget)}>
      {pending ? <LoaderCircle className="spin" /> : message === "링크 복사됨" ? <Check /> : <Send />}
    </button>
    {linkState !== "inactive" && <button type="button" className="text-button owner-unshare" disabled={pending}
      onClick={event => void change(false, event.currentTarget)}><Link2Off size={15} aria-hidden="true" />공유 링크 끊기</button>}
    <span className={message ? "owner-share-status" : "visually-hidden"} role="status">{message}</span>
  </>;
}
