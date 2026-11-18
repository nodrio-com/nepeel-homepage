import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import sharp from "sharp";
import { createServer, preview } from "vite";
import { serveStackShare } from "../../server/stack-share.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const token = "v".repeat(43);
const handle = "00000000-0000-4000-8000-000000000001";
const digest = buffer => createHash("sha256").update(buffer).digest("hex");
let server, browser, origin, photo;
before(async () => {
  server = process.env.CERTIFICATE_BUILD
    ? await preview({ build: { outDir: process.env.CERTIFICATE_BUILD }, preview: { host: "127.0.0.1", port: 0 } })
    : await createServer({ server: { host: "127.0.0.1", port: 0 } });
  if ("listen" in server) await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  // Vite may still be optimizing dependencies when its socket first starts listening.
  const document = await fetch(`${origin}/verify/${token}`, { signal: AbortSignal.timeout(90_000) });
  assert.equal(document.status, 200);
  assert.match(await document.text(), /name="referrer" content="no-referrer"/);
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
  photo = await sharp("public/images/ocean.webp").resize(560, 420, { fit: "cover" }).jpeg().toBuffer();
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function viewer(width, scoped = false) {
  const page = await browser.newPage({ viewport: { width, height: 870 }, locale: "ko-KR" });
  page.setDefaultTimeout(20_000);
  const state = { status: 200, media: photo, mime: "image/jpeg", chain: "minted", expected: digest(photo), delay: 0 };
  const errors = [];
  const externals = [];
  const methods = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const { pathname, origin: target, searchParams } = new URL(route.request().url());
    if (target !== origin) { externals.push(target); return route.abort(); }
    if (scoped && pathname === "/stack/" + token) {
      const response = await serveStackShare(new Request(route.request().url()), {
        async resolve() { return { title: "사진 기록", items: [{ id: handle, source: "certificate", mediaKind: "photo", caption: "" }] }; },
      });
      return route.fulfill({ status:response.status, headers:Object.fromEntries(response.headers), body:await response.text() });
    }
    const mediaPath = "/stack/" + token + "/media/" + handle;
    if (scoped && pathname === "/api/certificate") throw new Error("Independent certificate link requested");
    if (pathname !== (scoped ? mediaPath : "/api/certificate")) return route.continue();
    if (scoped && !searchParams.has("certificate")) return route.fulfill({ contentType:"image/jpeg",body:photo });
    methods.push(route.request().method());
    if (scoped) assert.equal(searchParams.toString(),"certificate=1");
    else assert.equal(searchParams.get("token"), token);
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    await route.fulfill({
      status: state.status,
      headers: {
        "Content-Type": state.mime, "X-Certificate-State": state.chain, "X-Display-SHA256": state.expected,
        "X-Certificate-Origin": "ios",
        ...(state.chain === "minted" && { "X-Certificate-Tx": "A".repeat(64), "X-Certificate-Token": "B".repeat(64) }),
      },
      body: state.status === 200 && route.request().method() === "GET" ? state.media : "",
    });
  });
  return { page, state, errors, externals, methods, open: () => page.goto(origin + (scoped ? "/stack/" : "/verify/") + token, { waitUntil: "commit" }) };
}
async function capture(page, name) {
  if (process.env.CERTIFICATE_SCREENSHOTS)
    await page.screenshot({ path: resolve(process.env.CERTIFICATE_SCREENSHOTS, name + ".png"), fullPage: true });
}

test("a stack recipient opens its verified photo, inspects the receipt and loses access after scoped revocation", async () => {
  const { page, state, methods, externals, errors, open } = await viewer(390,true);
  try {
    await page.clock.install();
    await open();
    const link = page.getByRole("link",{name:"1번째 사진 촬영 인증서 보기"});
    await link.focus();
    await link.press("Enter");
    await page.getByRole("heading",{name:"공유 파일 일치 · XRPL 테스트넷"}).waitFor();
    assert.equal(new URL(page.url()).pathname,`/verify/stack/${token}/${handle}`);
    await page.locator(".certificate-details summary").click();
    await page.getByText(state.expected,{exact:true}).waitFor();
    await page.getByRole("link",{name:/XRPL 테스트넷에서 보기/}).waitFor();
    await capture(page,"390-stack-certificate");
    state.status=404;
    await page.clock.fastForward(61_000);
    await page.getByText(/공유가 종료되었거나/).waitFor();
    assert.equal(await page.locator(".certificate-media,.certificate-details").count(),0);
    assert.ok(methods.includes("GET") && methods.includes("HEAD"));
    assert.deepEqual(externals,[]);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("anonymous token renders the same hashed photo, compares matching and changed files locally", async () => {
  const { page, errors, externals, open } = await viewer(320);
  try {
    await open();
    await page.getByRole("heading", { name: "공유 파일 일치 · XRPL 테스트넷" }).waitFor();
    await page.waitForFunction(() => document.querySelector(".certificate-media img")?.naturalWidth > 0);
    const image = page.getByRole("img", { name: "공유된 촬영 사진" });
    const actual = await image.evaluate(async img => {
      const bytes = await (await fetch(img.src)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    });
    assert.equal(actual, digest(photo));
    const details = page.locator(".certificate-details summary");
    await details.focus();
    await page.keyboard.press("Enter");
    await page.locator("#certificate-compare").setInputFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer: photo });
    await page.getByText("선택한 파일이 공유본과 일치합니다.").waitFor();
    await page.locator("#certificate-compare").setInputFiles({ name: "edited.jpg", mimeType: "image/jpeg", buffer: Buffer.from("changed") });
    await page.getByText("선택한 파일이 공유본과 다릅니다.").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
    assert.deepEqual(externals, []);
    await capture(page, "320-photo-comparison");
    await page.getByRole("link", { name: "nepeel 홈" }).click();
    assert.equal(new URL(page.url()).pathname, "/");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("pending video keeps playing as the NFT is issued automatically, without downloading it again", async () => {
  const { page, state, errors, methods, open } = await viewer(1000);
  try {
    state.media = await readFile("server/certificate-examples/video.mp4");
    state.expected = digest(state.media); state.chain = "queued"; state.mime = "video/mp4";
    const pendingCheck = page.waitForResponse(r => r.request().method() === "HEAD" && r.url().includes("/api/certificate"));
    await open();
    await page.getByRole("heading", { name: "공유 파일 일치 · NFT 발급 대기 중" }).waitFor();
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
    const video = await page.locator("video").elementHandle();
    assert.equal(await video.evaluate(v => v.controls && v.autoplay && v.muted && v.playsInline && v.preload === 'auto'), true);
    const source = await video.evaluate(async v => {
      v.addEventListener("pause", () => { v.dataset.paused = "true"; });
      v.loop = true;
      await v.play();
      return v.currentSrc;
    });
    const downloads = methods.filter(method => method === "GET").length;
    assert.equal(await page.getByRole("button", { name: "다시 확인" }).count(), 0);
    await capture(page, "1000-pending-video");
    await pendingCheck;
    state.chain = "minted";
    await page.getByRole("heading", { name: "공유 파일 일치 · XRPL 테스트넷" }).waitFor();
    assert.equal(await video.evaluate((v, src) =>
      document.querySelector("video") === v && v.currentSrc === src && !v.paused && !v.dataset.paused && v.currentTime > 0, source), true);
    assert.ok(methods.filter(method => method === "HEAD").length >= 2);
    assert.equal(methods.filter(method => method === "GET").length, downloads);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const revoked of [false, true]) {
  test(`pending status checks clear a ${revoked ? "revoked link" : "mismatched file digest"}`, async () => {
    const { page, state, open } = await viewer(390);
    try {
      state.chain = "queued";
      await open();
      await page.getByRole("heading", { name: "공유 파일 일치 · NFT 발급 대기 중" }).waitFor();
      state.chain = "minted";
      if (revoked) state.status = 404;
      else state.expected = digest(Buffer.from("different display bytes"));
      await page.getByText(revoked ? /공유가 종료되었거나/ : /인증 기록이 일치하지 않아/).waitFor();
      assert.equal(await page.locator(".certificate-media").count(), 0);
      assert.equal(await page.getByRole("heading", { name: "공유 파일 일치 · XRPL 테스트넷" }).count(), 0);
    } finally { await page.close(); }
  });
}

test("a hidden pending viewer stops polling and revalidates the link on return", async () => {
  const { page, state, methods, open } = await viewer(390);
  try {
    await page.clock.install();
    state.chain = "queued";
    await open();
    await page.getByRole("heading", { name: "공유 파일 일치 · NFT 발급 대기 중" }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText("촬영 파일과 인증 기록을 확인하고 있습니다.").waitFor();
    const before = methods.length;
    await page.clock.fastForward(125_000);
    assert.equal(methods.length, before);
    state.status = 404;
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText(/공유가 종료되었거나/).waitFor();
    assert.equal(await page.locator(".certificate-media").count(), 0);
    assert.equal(methods.at(-1), "GET");
  } finally { await page.close(); }
});

test("loading, altered bytes, transient errors and revocation fail closed", async () => {
  const { page, state, errors, open } = await viewer(390);
  try {
    state.expected = "0".repeat(64); state.delay = 300;
    await open();
    await page.getByText("촬영 파일과 인증 기록을 확인하고 있습니다.").waitFor();
    await page.getByText("인증 기록이 일치하지 않아 이 파일을 표시할 수 없습니다.").waitFor();
    assert.equal(await page.locator(".certificate-media").count(), 0);
    state.status = 503; state.delay = 0;
    await page.reload();
    await page.getByText(/지금은 인증 기록을 확인할 수 없습니다/).waitFor();
    state.status = 200; state.expected = digest(photo);
    await page.getByRole("button", { name: "다시 확인" }).click();
    await page.getByRole("heading", { name: "공유 파일 일치 · XRPL 테스트넷" }).waitFor();
    state.status = 404;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.getByText("공유가 종료되었거나 링크가 올바르지 않습니다.").waitFor();
    assert.equal(await page.locator(".certificate-media").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "공유 파일 일치 · XRPL 테스트넷" }).count(), 0);
    await capture(page, "390-revoked");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
