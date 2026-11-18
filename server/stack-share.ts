import { createHash } from "node:crypto";

export interface PublicStackItem {
  id: string;
  source: "post" | "certificate";
  mediaKind: "photo" | "video";
  caption: string;
  sourceId?: string;
  credential?: string;
}

export interface PublicStack {
  title: string;
  items: PublicStackItem[];
}

export interface StackShareSource {
  resolve(token: string, item: string | null): Promise<PublicStack | null>;
  media(request: Request, item: PublicStackItem): Promise<Response>;
}

const peelScript = `const slider = document.querySelector('#peel');
const frame = document.querySelector('.comparison');
slider.closest('section').hidden = false;
function paint() {
  slider.closest('section').style.setProperty('--peel', slider.value + '%');
  slider.setAttribute('aria-valuetext', slider.value + '퍼센트');
}
function drag(event) {
  const bounds = frame.getBoundingClientRect();
  slider.value = String(Math.round((event.clientX - bounds.left) * 100 / bounds.width));
  paint();
}
slider.addEventListener('input', paint);
frame.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  frame.setPointerCapture(event.pointerId);
  drag(event);
});
frame.addEventListener('pointermove', event => {
  if (frame.hasPointerCapture(event.pointerId)) drag(event);
});`;
const scriptDigest = createHash("sha256").update(peelScript).digest("base64");
export const stackHeaders = {
  "Cache-Control": "private, no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive, noimageindex",
  "Content-Security-Policy": `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'sha256-${scriptDigest}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function page(request: Request, status: number, title: string, body = "", script = false) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · nepeel</title>
<link rel="stylesheet" href="/stack-share.css"><link rel="icon" href="/favicon.svg"></head>
<body><main><header><span class="brand">nepeel</span></header><h1>${escapeHtml(title)}</h1>${body}</main>
${script ? `<script>${peelScript}</script>` : ""}</body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status, headers: { ...stackHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderStack(request: Request, stack: PublicStack, token: string) {
  const path = (item: PublicStackItem) => `/stack/${token}/media/${item.id}`;
  const photos = stack.items.filter(item => item.mediaKind === "photo");
  const compare = photos.length >= 2;
  const first = photos[0];
  const last = photos.at(-1)!;
  const peel = compare ? `<section class="peel" hidden><h2><label for="peel">Peel 비교</label></h2>
    <div class="comparison"><img src="${path(first)}" alt="첫 사진"><img class="reveal" src="${path(last)}" alt="마지막 사진">
    <span class="divider" aria-hidden="true"></span></div>
    <div class="slider"><span>첫 사진</span><input id="peel" type="range" min="0" max="100" value="50" aria-label="마지막 사진이 보이는 비율" aria-valuetext="50퍼센트"><span>마지막 사진</span></div></section>` : "";
  const items = stack.items.map((item, index) => {
    const label = (index + 1) + "번째 " + (item.mediaKind === "video" ? "영상" : "사진");
    const media = item.mediaKind === "video"
      ? `<video src="${path(item)}" controls playsinline preload="metadata" aria-label="${label}"></video>`
      : `<img src="${path(item)}" alt="${label}" loading="${index === 0 && !compare ? "eager" : "lazy"}">`;
    const caption = item.caption ? `<figcaption>${escapeHtml(item.caption)}</figcaption>` : "";
    const certificate = item.source === "certificate"
      ? `<a class="certificate-link" href="/verify/stack/${token}/${item.id}" aria-label="${label} 촬영 인증서 보기">촬영 인증서 보기</a>` : "";
    return `<li><figure>${media}${caption}</figure>${certificate}</li>`;
  }).join("");
  return page(request, 200, stack.title, peel + (items ? `<ol aria-label="작업 순서">${items}</ol>` : "<p>공개된 항목이 없어요.</p>"), compare);
}

export async function serveStackShare(request: Request, source: StackShareSource): Promise<Response> {
  const missing = () => page(request, 404, "이 링크로 묶음을 볼 수 없어요");
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { ...stackHeaders, Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  const match = /^\/stack\/([A-Za-z0-9_-]{43})(?:\/media\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}))?\/?$/.exec(url.pathname);
  if (!match) return missing();
  const [, token, itemId] = match;
  try {
    const stack = await source.resolve(token, itemId ?? null);
    if (!stack) return missing();
    if (!itemId) return renderStack(request, stack, token);
    const item = stack.items[0];
    if (item?.id !== itemId || !item.credential || !item.sourceId) return missing();
    if (url.searchParams.has("certificate") && item.source !== "certificate") return missing();
    const result = await source.media(request, item);
    if (result.status !== 200 && result.status !== 206 && result.status !== 416) {
      await result.body?.cancel();
      return result.status === 404 ? missing() : new Response(null, { status: result.status, headers: stackHeaders });
    }
    // Ledger and storage calls can outlive either grant. Check the specific
    // stack and member again before handing back the first byte.
    const latest = (await source.resolve(token, itemId))?.items[0];
    if (latest?.id !== itemId || latest.credential !== item.credential || latest.sourceId !== item.sourceId || latest.source !== item.source) {
      await result.body?.cancel();
      return missing();
    }
    const headers = new Headers(stackHeaders);
    const allowed = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"];
    // Only complete responses from the certificate verifier attest a digest.
    if (item.source === "certificate" && result.status === 200)
      allowed.push("X-Certificate-State", "X-Certificate-Origin", "X-Display-SHA256", "X-Certificate-Tx", "X-Certificate-Token");
    for (const name of allowed) {
      const value = result.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : result.body, { status: result.status, headers });
  } catch {
    return page(request, 503, "묶음을 불러오지 못했어요", "<p>잠시 후 새로고침해 주세요.</p>");
  }
}

// The certificate verifier checks the digest of the complete, bounded file.
// Apply browser video ranges only after receiving those verified bytes.
export async function certificateRange(request: Request, verified: Response) {
  const range = request.headers.get("range");
  if (!range || !verified.ok) return verified;
  const bytes = await verified.arrayBuffer();
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(range);
  const start = match?.[1] === undefined ? Math.max(0, bytes.byteLength - Number(match?.[3])) : Number(match[1]);
  const end = match?.[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  if (!match || !Number.isSafeInteger(start) || start > end || start >= bytes.byteLength)
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + bytes.byteLength } });
  const headers = new Headers(verified.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : bytes.slice(start, end + 1), { status: 206, headers });
}
