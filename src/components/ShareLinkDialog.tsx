import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Dialog } from "../App";
import { copyMediaLink } from "../lib/share-link";
import "./share-link-dialog.css";

export function ShareLinkDialog({ url, close, opener }: {
  url: string; close: () => void; opener?: HTMLElement | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [result, setResult] = useState<"ready" | "copied" | "manual">("ready");
  function selectLink() {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }
  useLayoutEffect(() => {
    setResult("ready");
    selectLink();
  }, [url]);
  useEffect(() => {
    if (result !== "copied") return;
    const timeout = window.setTimeout(close, 1200);
    return () => window.clearTimeout(timeout);
  }, [result, close]);
  async function retryCopy() {
    if (working.current || result === "copied") return;
    working.current = true;
    const outcome = await copyMediaLink(url);
    working.current = false;
    if (input.current?.value !== url) return;
    setResult(outcome);
    if (outcome === "manual") selectLink();
  }
  return <Dialog title="공유 링크" close={close} opener={opener}>
    <div className="share-link-field">
      <input ref={input} type="url" aria-label="공유할 주소" readOnly dir="ltr" value={url}
        onFocus={event => event.target.select()} />
      <p role="status">{result === "copied" ? "링크 복사됨"
        : result === "manual" ? "선택된 링크를 직접 복사해 주세요." : ""}</p>
      <button className="dark-button" type="button" onClick={() => void retryCopy()} aria-disabled={result === "copied"}>
        <Copy size={17} aria-hidden="true" />링크 복사
      </button>
    </div>
  </Dialog>;
}
