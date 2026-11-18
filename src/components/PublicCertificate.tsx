import { useEffect, useState } from "react";
import { Aperture, Clock3, ShieldCheck } from "lucide-react";
import { CAPTURE_CERT_MAX_BYTES } from "../../shared/media-certificate";
import { getCertificateStatus, loadCertificate, sha256, type CertificateLink, type CertificateProblem } from "../lib/public-certificate";
import "./public-certificate.css";

type MediaView = {
  url: string;
  video: boolean;
  minted: boolean;
  hash: string;
  txHash: string | null;
  tokenId: string | null;
  origin: "example" | "ios" | "android";
};
const messages: Record<CertificateProblem | "loading", string> = {
  loading: "촬영 파일과 인증 기록을 확인하고 있습니다.",
  missing: "공유가 종료되었거나 링크가 올바르지 않습니다.",
  mismatch: "인증 기록이 일치하지 않아 이 파일을 표시할 수 없습니다.",
  unavailable: "지금은 인증 기록을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
};

function CertificateDetails({ media }: { media: MediaView | null }) {
  const [file, setFile] = useState<File>();
  const [comparison, setComparison] = useState("");
  const hash = media?.hash;
  useEffect(() => {
    if (!file || !hash) { setComparison(""); return; }
    let current = true;
    setComparison("파일을 비교하고 있습니다.");
    async function compare(selected: File) {
      try {
        const same = selected.size <= CAPTURE_CERT_MAX_BYTES && await sha256(selected) === hash;
        if (current) setComparison(same ? "선택한 파일이 공유본과 일치합니다." : "선택한 파일이 공유본과 다릅니다.");
      } catch {
        if (current) setComparison("파일을 읽을 수 없습니다. 다시 선택해 주세요.");
      }
    }
    void compare(file);
    return () => { current = false; };
  }, [file, hash]);
  return <details className="certificate-details" hidden={!media}>
    <summary>인증 정보와 파일 비교</summary>
    <dl>
      <dt>공유본 SHA-256</dt><dd>{hash}</dd>
      {media?.minted && <>
        <dt>XRPL 테스트넷 NFT ID</dt><dd>{media.tokenId}</dd>
        <dt>발급 트랜잭션</dt><dd>{media.txHash}</dd>
        <dt>원장 기록</dt><dd><a href={`https://testnet.xrpl.org/transactions/${media.txHash}`} target="_blank"
          rel="noopener noreferrer">XRPL 테스트넷에서 보기 <span aria-label="새 창">↗</span></a></dd>
      </>}
    </dl>
    <label htmlFor="certificate-compare">이 기기의 파일과 공유본 비교</label>
    <input id="certificate-compare" type="file" onChange={e => setFile(e.currentTarget.files?.[0])} />
    <p role="status">{comparison}</p>
  </details>;
}

export default function PublicCertificate({ link }: { link: CertificateLink | null }) {
  const [view, setView] = useState<"loading" | CertificateProblem | MediaView>("loading");
  const [attempt, setAttempt] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => {
    if (!link) { setView("missing"); return; }
    const currentLink = link;
    let active: AbortController | undefined;
    let url: string | undefined;
    let nextCheck: number | undefined;
    function clear() {
      window.clearTimeout(nextCheck);
      active?.abort();
      active = undefined;
      if (url) URL.revokeObjectURL(url);
      url = undefined;
    }
    function stopWith(problem: CertificateProblem) {
      clear();
      setView(problem);
    }
    function scheduleCheck(media: MediaView, controller: AbortController, delay: number) {
      nextCheck = window.setTimeout(async () => {
        if (active !== controller || document.hidden) return;
        const deadline = window.setTimeout(() => controller.abort(), 30_000);
        try {
          const status = await getCertificateStatus(currentLink, controller.signal);
          if (active !== controller) return;
          if (controller.signal.aborted) { stopWith("unavailable"); return; }
          if (typeof status === "string") { stopWith(status); return; }
          if (status.hash !== media.hash || status.origin !== media.origin || status.video !== media.video ||
              (media.minted && (status.state !== "minted" || status.txHash !== media.txHash || status.tokenId !== media.tokenId))) {
            stopWith("mismatch");
            return;
          }
          if (status.state === "minted") {
            const confirmed = { ...media, minted: true, txHash: status.txHash, tokenId: status.tokenId };
            setView(confirmed);
            if (media.origin !== "example") scheduleCheck(confirmed, controller, 60_000);
          } else {
            scheduleCheck(media, controller, Math.min(delay * 2, 120_000));
          }
        } catch {
          if (active === controller) stopWith("unavailable");
        } finally {
          window.clearTimeout(deadline);
        }
      }, delay);
    }
    async function refresh() {
      clear();
      setView("loading");
      setPlaybackError(false);
      if (document.hidden) return;
      const controller = new AbortController();
      active = controller;
      const timer = window.setTimeout(() => controller.abort(), 30_000);
      try {
        const result = await loadCertificate(currentLink, controller.signal);
        if (active !== controller) return;
        if (controller.signal.aborted) { setView("unavailable"); return; }
        if (typeof result === "string") { setView(result); return; }
        url = URL.createObjectURL(result.file);
        const media = {
          url, video: result.file.type === "video/mp4", minted: result.state === "minted",
          hash: result.hash, txHash: result.txHash, tokenId: result.tokenId, origin: result.origin,
        };
        setView(media);
        if (media.origin !== "example") scheduleCheck(media, controller, media.minted ? 60_000 : 4_000);
      } catch {
        if (active === controller) setView("unavailable");
      } finally {
        window.clearTimeout(timer);
      }
    }
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", restore);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", restore);
    };
  }, [link, attempt]);
  const media = typeof view === "object" ? view : null;
  const sample = Boolean(link?.example);
  const retry = <button className="certificate-retry" onClick={() => setAttempt(value => value + 1)}>다시 확인</button>;
  return <main className="certificate-page">
    <header>
      <a className="brand" href="/" referrerPolicy="no-referrer" aria-label="nepeel 홈">nepeel<Aperture aria-hidden="true" /></a>
      <h1>{sample ? "인증서 예시" : "촬영 인증서"}</h1>
    </header>
    {sample && <p className="certificate-provenance">테스트 예시 · 기기 촬영 미확인</p>}
    {media && <div className="certificate-media">
      {playbackError
        ? <p>이 브라우저에서 파일을 열 수 없습니다. <a href={media.url} download={media.video ? "capture.mp4" : "capture.jpg"}>파일 저장</a></p>
        : media.video
          ? <video src={media.url} controls autoPlay muted playsInline preload="auto" aria-label={sample ? "테스트 예시 동영상" : "공유된 촬영 동영상"} onError={() => setPlaybackError(true)} />
          : <img src={media.url} alt={sample ? "테스트 예시 사진" : "공유된 촬영 사진"} onError={() => setPlaybackError(true)} />}
    </div>}
    <div role="status" className="certificate-status">
      {media ? <>
        <h2>{media.minted ? <ShieldCheck aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
          {media.minted ? "공유 파일 일치 · XRPL 테스트넷" : "공유 파일 일치 · NFT 발급 대기 중"}</h2>
        {!sample && <p>촬영 요청 인증 · {media.origin === "ios" ? "iOS" : "Android"} 앱</p>}
      </> : <p>{typeof view === "string" && messages[view]}</p>}
    </div>
    {view === "unavailable" && retry}
    {(media || view === "loading") && <CertificateDetails media={media} />}
  </main>;
}
