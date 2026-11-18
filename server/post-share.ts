type SharedPost = { image_path: string; caption: string; mime_type: string | null };

export interface PostShareSource {
  resolve(token: string): Promise<SharedPost | null>;
  media(path: string, request: Request): Promise<Response>;
}

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive, noimageindex",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function page(request: Request, status: number, title: string, content: string) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · nepeel</title>
<link rel="stylesheet" href="/post-share.css"><link rel="icon" href="/favicon.svg"></head>
<body><main><header><span class="brand">nepeel</span></header>${content}</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status, headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}

function unavailable(request: Request) {
  return page(request, 404, "공유가 종료된 게시물",
    "<h1>이 링크로 게시물을 볼 수 없어요</h1><p>작성자에게 새 공유 링크를 요청해 주세요.</p>");
}

const mediaTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "video/ogg"]);

function postMediaType(post: SharedPost) {
  return post.mime_type?.split(";")[0].trim().toLowerCase()
    || (/\.jpe?g$/i.test(post.image_path) ? "image/jpeg" : "");
}

// Both standalone and stack-scoped grants serve the same storage media types and ranges.
export async function servePostMedia(request: Request, post: SharedPost, media: PostShareSource["media"]) {
  const type = postMediaType(post);
  if (!mediaTypes.has(type)) return unavailable(request);
  const range = request.headers.get("range");
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
    return new Response(null, { status: 416, headers: privateHeaders });
  const file = await media(post.image_path, request);
  const headers = new Headers(privateHeaders);
  if (file.status === 416) {
    const span = file.headers.get("Content-Range");
    if (span) headers.set("Content-Range", span);
    return new Response(null, { status: 416, headers });
  }
  if (file.status === 404) return unavailable(request);
  if (file.status !== 200 && file.status !== 206) throw new Error("Media unavailable");
  headers.set("Content-Type", type);
  for (const name of ["Content-Length", "Accept-Ranges", "Content-Range"]) {
    const value = file.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : file.body, { status: file.status, headers });
}

export async function servePostShare(request: Request, source: PostShareSource) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: "GET, HEAD" } });
  }
  const match = /^\/s\/([\w-]{43})(\/media)?\/?$/.exec(new URL(request.url).pathname);
  if (!match) return unavailable(request);
  try {
    const post = await source.resolve(match[1]);
    if (!post) return unavailable(request);
    if (match[2]) return await servePostMedia(request, post, source.media);
    const type = postMediaType(post);
    if (!mediaTypes.has(type)) return unavailable(request);
    const src = `/s/${match[1]}/media`;
    const isVideo = type.startsWith("video/");
    const title = isVideo ? "공유된 영상" : "공유된 사진";
    const media = isVideo
      ? `<video src="${src}" aria-label="${title}" controls playsinline muted autoplay preload="metadata"></video>`
      : `<img class="photo" src="${src}" alt="${title}" fetchpriority="high">`;
    const caption = post.caption ? `<figcaption>${escapeText(post.caption)}</figcaption>` : "";
    return page(request, 200, title,
      `<h1 class="sr-only">${title}</h1><p class="status">촬영 인증 미확인</p><figure>${media}${caption}</figure>`);
  } catch {
    return page(request, 503, "게시물을 불러오지 못했어요",
      "<h1>게시물을 불러오지 못했어요</h1><p>잠시 후 페이지를 새로고침해 주세요.</p>");
  }
}
