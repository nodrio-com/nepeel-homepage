import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { Dialog } from "../App";
import { supabase } from "../lib/supabase";
import { authError, authNotice } from "../../shared/auth";
import { useAuthForm } from "../../shared/useAuthForm";

export function AuthDialog({ close, onDone, client = supabase }: {
  close: () => void; onDone: () => void; client?: SupabaseClient | null;
}) {
  const [en, setEn] = useState(() => {
    try {
      const saved = localStorage.getItem("nepeel.hi.language");
      if (saved === "en" || saved === "ko") return saved === "en";
    } catch { /* Use the browser language when preferences are unavailable. */ }
    return !navigator.language.startsWith("ko");
  });
  const t = (ko: string, english: string) => en ? english : ko;
  const h = useAuthForm(client, location.origin, onDone);
  const emailOnly = h.mode === "reset" || h.mode === "resend";
  const title = h.mode === "signup" ? t("회원가입", "Create account")
    : h.mode === "reset" ? t("비밀번호 다시 설정하기", "Reset your password")
    : h.mode === "resend" ? t("인증메일 다시 받기", "Resend confirmation")
    : t("로그인", "Sign in");
  const submitLabel = h.mode === "signup" ? t("가입하기", "Create account")
    : h.mode === "reset" ? t("재설정 링크 받기", "Send recovery link")
    : h.mode === "resend" ? t("인증메일 보내기", "Send confirmation") : t("로그인", "Sign in");
  return <Dialog title={title} close={() => { if (!h.pending) close(); }}>
    <div lang={en ? "en" : "ko"}>
      <button className="text-button auth-reset" disabled={h.pending} onClick={() => {
        setEn(!en);
        try { localStorage.setItem("nepeel.hi.language", en ? "ko" : "en"); } catch { /* This dialog retains the selection. */ }
      }}>{en ? "한국어" : "English"}</button>
      {!emailOnly && <div className="auth-tabs">
        <button type="button" disabled={h.pending} aria-pressed={h.mode === "login"} className={h.mode === "login" ? "selected" : ""} onClick={() => h.change("login")}>{t("로그인", "Sign in")}</button>
        <button type="button" disabled={h.pending} aria-pressed={h.mode === "signup"} className={h.mode === "signup" ? "selected" : ""} onClick={() => h.change("signup")}>{t("회원가입", "Create account")}</button>
      </div>}
      <form className="form-stack" onSubmit={e => { e.preventDefault(); void h.submit(); }}>
        {h.mode === "signup" && <label>{t("이름", "Name")}
          <input autoComplete="nickname" value={h.name} onChange={e => h.setName(e.target.value)} maxLength={40} required disabled={h.pending} />
        </label>}
        <label>{t("이메일", "Email")}
          <input type="email" autoComplete="email" value={h.email} onChange={e => h.setEmail(e.target.value)} required disabled={h.pending} placeholder="you@example.com" />
        </label>
        {!emailOnly && <label>{t("비밀번호", "Password")}
          <input type="password" autoComplete={h.mode === "signup" ? "new-password" : "current-password"} minLength={h.mode === "signup" ? 8 : undefined} value={h.password} onChange={e => h.setPassword(e.target.value)} required disabled={h.pending} placeholder={h.mode === "signup" ? t("8자 이상", "At least 8 characters") : undefined} />
        </label>}
        {h.error != null && <p className="form-error" role="alert">{authError(h.error, en)}</p>}
        {h.notice && <p className="form-success" role="status">{authNotice(h.notice, en)}</p>}
        {!client && <div className="info-box">{t("서비스 연결을 준비 중이에요. 지금은 샘플 피드를 둘러볼 수 있어요.", "We're preparing the service. You can explore the sample feed for now.")}</div>}
        <button className="dark-button full" disabled={h.pending || !client || (h.mode !== "login" && h.remaining > 0) || (h.mode === "signup" && !h.name.trim())}>
          {h.pending ? <><LoaderCircle aria-hidden="true" className="spin" size={18}/>{t("처리 중…", "Please wait…")}</> : submitLabel}<ArrowRight aria-hidden="true" size={17}/>
        </button>
        {h.mode !== "login" && h.remaining > 0 && <small>{t(`${h.remaining}초 후 메일을 다시 요청할 수 있어요.`, `You can request another email in ${h.remaining}s.`)}</small>}
      </form>
      <div className="auth-help">
        {h.mode !== "resend" && <button className="text-button auth-reset" disabled={h.pending} onClick={() => h.change("resend")}>{t("인증메일이 안 왔나요?", "Didn't get a confirmation email?")}</button>}
        {h.mode !== "reset" && <button className="text-button auth-reset" disabled={h.pending} onClick={() => h.change("reset")}>{t("비밀번호를 잊으셨나요?", "Forgot your password?")}</button>}
        {emailOnly && <button className="text-button auth-reset" disabled={h.pending} onClick={() => h.change("login")}>{t("로그인으로 돌아가기", "Back to sign in")}</button>}
      </div>
    </div>
  </Dialog>;
}
