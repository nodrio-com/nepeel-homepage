import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readerLanguage, translationPlan, watchLanguage, watchModels } from "../lib/on-device-translation";
import "./translated-text.css";

type Props = { text: string; sourceLanguage?: string; targetLanguage?: string; englishText?: string };
type Plan = NonNullable<Awaited<ReturnType<typeof translationPlan>>>;

export function TranslatedText(props: Props) {
  const reader = useSyncExternalStore(watchLanguage, readerLanguage, () => "ko");
  const target = props.targetLanguage || reader;
  return <Text key={JSON.stringify([props.text, target, props.sourceLanguage, props.englishText])} {...props} target={target}/>;
}

function Text({ text, sourceLanguage, englishText, target }: Props & { target: string }) {
  const editorial = target === "en" ? englishText : undefined;
  const [translated, setTranslated] = useState(editorial);
  const [original, setOriginal] = useState(false);
  const [available, setAvailable] = useState<Plan>();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const action = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (editorial) return;
    let active = true;
    let running = false;
    let complete = false;
    async function translate(plan: Plan) {
      if (running || !active) return;
      running = true;
      setStatus("loading");
      try {
        const value = await plan.run(text);
        if (!active) return;
        complete = true;
        if (!value.trim() || value === text) setAvailable(undefined);
        setTranslated(value.trim() && value !== text ? value : undefined);
        setStatus("idle");
      } catch {
        if (active) {
          if (plan.mb === undefined) {
            // A browser can deny creation after reporting an available model.
            queueMicrotask(() => { void inspect(); });
          } else {
            action.current = () => { void inspect(true); };
            setStatus("error");
          }
        }
      } finally { running = false; }
    }
    async function inspect(retry = false) {
      if (!active || running || complete) return;
      try {
        const plan = await translationPlan(text, target, sourceLanguage);
        if (!active || running || complete) return;
        setAvailable(plan);
        if (!plan) { setStatus("idle"); return; }
        action.current = () => { void translate(plan); };
        if (!plan.download || (retry && plan.mb === availableMB)) await translate(plan);
        else setStatus("idle");
        availableMB = plan.mb;
      } catch {
        if (active) { action.current = () => { void inspect(true); }; setStatus("error"); }
      }
    }
    let availableMB: number | undefined;
    void inspect();
    const unsubscribe = watchModels(() => { void inspect(); });
    return () => { active = false; unsubscribe(); action.current = undefined; };
  }, [editorial, sourceLanguage, target, text]);

  const ko = target === "ko";
  const displayTranslation = !!translated && !original;
  const source = sourceLanguage || available?.source;
  let label = "";
  if (translated) label = original ? (ko ? "번역 보기" : "Show translation") : (ko ? "원문 보기" : "Show original");
  else if (status === "loading" && available?.download) label = ko ? "번역 준비 중…" : "Preparing translation…";
  else if (status === "error") label = ko ? "번역 다시 시도" : "Retry translation";
  else if (available?.download && status !== "loading") {
    label = ko ? "번역 다운로드" : "Download translation";
    if (available.mb) label += " · " + available.mb + " MB";
  }
  return <>
    <span lang={displayTranslation ? target : source} dir="auto">{displayTranslation ? translated : text}</span>
    {label && <button className="translation-action" type="button" lang={ko ? "ko" : "en"}
      aria-disabled={status === "loading" || undefined} aria-busy={status === "loading" || undefined}
      onClick={() => { if (translated) setOriginal(!original); else if (status !== "loading") action.current?.(); }}>{label}</button>}
  </>;
}
