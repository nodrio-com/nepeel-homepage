import { isTapePosition, type TapePosition } from "../shared/capture-context.js";

export type ShareFeatures = { tape?: boolean; captions?: boolean; comparisonHash?: string };

export function sharePolicy({ tape, captions, comparisonHash }: ShareFeatures = {}) {
  const scripts = [
    ...(comparisonHash ? [`'sha256-${comparisonHash}'`] : []),
    ...(tape || captions ? ["'self'"] : []),
    ...(captions ? ["'wasm-unsafe-eval'"] : []),
  ];
  return [
    "default-src 'none'", "img-src 'self'", "media-src 'self'", "style-src 'self'",
    ...(scripts.length ? ["script-src " + scripts.join(" ")] : []),
    ...(captions ? ["worker-src 'self'", "connect-src 'self' https://huggingface.co/midudev/firefox-translations/ https://*.hf.co"] : []),
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
  ].join("; ");
}

export const privateShareHeaders = {
  "Cache-Control": "private, no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive, noimageindex",
  "Content-Security-Policy": sharePolicy(),
};

export function shareModule({ tape, captions }: ShareFeatures) {
  if (!tape && !captions) return "";
  const style = tape ? '<link rel="stylesheet" href="/share-tape.css">' : "";
  return style + '<script type="module" src="/share-enhancements.js" referrerpolicy="no-referrer"></script>';
}

export function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function shareCaption(caption: string) {
  return caption.trim() ? `<figcaption data-share-caption>${escapeHtml(caption)}</figcaption>` : "";
}

export function tapeAttribute(position: TapePosition | null | undefined) {
  return isTapePosition(position) ? ` data-share-tape="${position}" tabindex="-1"` : "";
}
