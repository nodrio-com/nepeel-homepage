import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { preview } from "vite";
import { servePostShare } from "../../server/post-share.ts";
import { serveStackShare } from "../../server/stack-share.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const token = "p".repeat(43), legacy = "l".repeat(43);
const caption = "이것은 오늘 아침에 찍은 사진입니다.";
const items = ["post", "certificate", "post"].map((source, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`, source, sourceId: String(index),
  credential: "private", mediaKind: "photo", caption: index === 0 ? caption : "",
  tape: index === 2 ? null : "bottom",
}));
let browser, server, origin, photo;
const file = () => new Response(photo, { headers: { "Content-Type": "image/webp" } });
const postSource = {
  async resolve(key) {
    if (![token, legacy].includes(key)) return null;
    return { image_path: "private/file.webp", mime_type: "image/webp",
      caption: key === token ? caption : "", ...(key === token ? { tape: "top" } : {}) };
  },
  media: file,
};
const stackSource = {
  async resolve(key, id) {
    return key === token ? { title: "사진 모음", items: items.filter(item => !id || item.id === id) } : null;
  },
  media: file,
};

before(async () => {
  photo = await sharp(await readFile(new URL("../../public/images/pottery.webp", import.meta.url)))
    .resize(320, 720).webp().toBuffer();
  server = await preview({
    build: { outDir: process.env.PUBLIC_SHARE_BUILD || "dist" }, preview: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "public-share-test-fixture", configurePreviewServer(instance) {
      instance.middlewares.use(async (req, res, next) => {
        const request = new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers });
        const path = new URL(request.url).pathname;
        const response = path.startsWith("/s/") ? await servePostShare(request, postSource)
          : path.startsWith("/stack/") ? await serveStackShare(request, stackSource) : null;
        if (!response) return next();
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    } }],
  });
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

test("public photo and stack preserve their originals with JavaScript disabled", async () => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    for (const route of ["/s/", "/stack/"]) {
      await page.goto(origin + route + token);
      const figure = page.locator("figure").first();
      assert.equal(await figure.locator("figcaption").textContent(), caption);
      assert.ok(await figure.locator("img").evaluate(img => img.complete && img.naturalWidth > 0));
      assert.equal(await page.getByRole("button").count(), 0);
    }
    await page.goto(origin + "/s/" + legacy);
    assert.equal(await page.locator("img[data-share-tape], script, figcaption").count(), 0);
  } finally { await page.close(); }
});

test("a portrait's strip remains anchored to the photograph and restores keyboard focus", async () => {
  for (const [route, width, anchor] of [["/s/", 360, .25], ["/stack/", 1024, .75]]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width === 360, locale: "ko-KR", reducedMotion: "reduce" });
    try {
      const violations = [];
      let photoRequests = 0;
      page.on("request", request => { if (request.url() === origin + route + token + "/media") photoRequests++; });
      await page.exposeFunction("recordViolation", value => violations.push(value));
      await page.addInitScript(() => addEventListener("securitypolicyviolation", event => window.recordViolation(event.violatedDirective)));
      await page.goto(origin + route + token);
      const tape = page.getByRole("button", { name: "테이프 떼기" });
      await tape.waitFor();
      assert.equal(await tape.count(), 1);
      const image = page.locator("figure img[data-share-tape]");
      const bounds = await image.boundingBox();
      const plane = await page.locator(".tape-plane").boundingBox();
      const strip = await tape.boundingBox();
      assert.ok(Math.abs(plane.width - bounds.height * 320 / 720) < 1);
      assert.ok(Math.abs(strip.x + strip.width / 2 - (bounds.x + bounds.width / 2)) < 1);
      assert.ok(Math.abs(strip.y + strip.height / 2 - (plane.y + plane.height * anchor)) < 1);
      assert.equal(await page.locator(".tape-paper").evaluate(el => getComputedStyle(el).transitionDuration), "0s");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (route === "/stack/") {
        const slider = page.getByRole("slider");
        await slider.press("End");
        assert.equal(await slider.inputValue(), "100");
      }
      await tape.scrollIntoViewIfNeeded();
      if (process.env.SHARE_SCREENSHOTS) await page.screenshot({ path: process.env.SHARE_SCREENSHOTS + "/tape-" + width + ".png" });
      if (route === "/stack/") {
        const box = await tape.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
        await page.mouse.up();
      } else {
        await tape.press("Enter");
        assert.ok(await image.evaluate(el => el === document.activeElement));
      }
      await tape.waitFor({ state: "hidden" });
      assert.ok(await image.evaluate(el => el.naturalWidth > 0 && getComputedStyle(el).opacity === "1"));
      if (route === "/s/") {
        assert.equal(photoRequests, 1);
        await page.reload();
        await tape.tap();
        await tape.waitFor({ state: "hidden" });
      }
      assert.deepEqual(violations, []);
    } finally { await page.close(); }
  }
});

test("both public pages can show a local translation and toggle the original", async () => {
  const page = await browser.newPage({ locale: "en-US" });
  try {
    await page.addInitScript(() => Object.defineProperty(window, "Translator", { configurable: true, value: {
      availability: async () => "available",
      create: async () => ({ translate: async () => "A photo from this morning.", destroy() {} }),
    } }));
    const network = [];
    page.on("request", request => network.push(request.url()));
    for (const route of ["/s/", "/stack/"]) {
      await page.goto(origin + route + token);
      const original = page.getByRole("button", { name: "Show original" });
      await original.waitFor();
      assert.equal(await page.locator("figcaption span").first().textContent(), "A photo from this morning.");
      await original.click();
      assert.equal(await page.locator("figcaption span").first().textContent(), caption);
      await page.getByRole("button", { name: "Show translation" }).press("Enter");
      await original.waitFor();
    }
    assert.ok(network.every(url => new URL(url).origin === origin));
  } finally { await page.close(); }
});

test("a public model download sends neither caption nor bearer URL", async () => {
  const page = await browser.newPage({ locale: "en-US" });
  try {
    await page.addInitScript(() => Object.defineProperty(window, "Translator", { configurable: true, value: undefined }));
    const remote = [];
    page.context().on("request", request => {
      if (new URL(request.url()).origin !== origin) remote.push(request);
    });
    if (!process.env.PUBLIC_SHARE_LIVE_MODEL) await page.context().route(/^https:\/\//, route => route.abort());
    await page.goto(origin + "/s/" + token);
    const download = page.getByRole("button", { name: /Download translation/ });
    await download.waitFor();
    assert.equal(remote.length, 0);
    await download.click();
    if (process.env.PUBLIC_SHARE_LIVE_MODEL) {
      await page.getByRole("button", { name: "Show original" }).waitFor({ timeout: 240_000 });
      const translated = await page.locator("figcaption span").textContent();
      assert.ok(translated !== caption && /[A-Za-z]/.test(translated));
      await page.getByRole("button", { name: "Show original" }).click();
    } else {
      await page.getByRole("button", { name: "Retry translation" }).waitFor({ timeout: 45_000 });
    }
    assert.equal(await page.locator("figcaption span").textContent(), caption);
    assert.ok(remote.length > 0);
    for (const request of remote) {
      const headers = await request.allHeaders();
      const url = new URL(request.url());
      assert.ok(url.hostname === "huggingface.co" || url.hostname.endsWith(".hf.co"));
      assert.equal(headers.referer, undefined);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(request.method(), "GET");
      assert.equal(request.postData(), null);
      assert.ok(!decodeURIComponent(url.href).includes(caption) && !url.href.includes(token));
    }
  } finally { await page.close(); }
});
