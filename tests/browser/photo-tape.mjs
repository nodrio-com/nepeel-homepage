import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
let browser, server, origin;

before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL });
});
after(async () => { await browser?.close(); await server?.close(); });

async function visit(page, hash) {
  await page.route(url => url.origin !== origin, request => request.abort());
  await page.goto(origin + "/" + hash, { waitUntil: "domcontentloaded" });
}

test("peeling consumes the touch, preserves feed focus on Back, and dragging in detail leaves the post open", async () => {
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await visit(page, "#feed");
    const feed = page.locator(".feed-list article").first();
    const open = feed.locator('[data-post-id="sample-concert"]');
    const strip = feed.getByRole("button", { name: "테이프 떼기" });
    const bounds = await strip.boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.touchscreen.tap(x, y);
    await strip.waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).hash, "#feed");
    await page.touchscreen.tap(x, y);
    const viewer = page.locator(".media-viewer[open]");
    const detailStrip = viewer.getByRole("button", { name: "테이프 떼기" });
    const detailBounds = await detailStrip.boundingBox();
    const start = { x: detailBounds.x + detailBounds.width / 2, y: detailBounds.y + detailBounds.height / 2 };
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (const delta of [12, 32, 64]) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x - delta, y: start.y }] });
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await detailStrip.waitFor({ state: "hidden" });
    assert.match(page.url(), /open=sample-concert/);
    await page.goBack();
    await viewer.waitFor({ state: "hidden" });
    assert.ok(await open.evaluate(el => el === document.activeElement));
    assert.equal(await strip.count(), 0);
  } finally { await page.close(); }
});

test("the decorative thumbnail opens the photo and keyboard reveal hands focus to the image", async () => {
  const page = await browser.newPage();
  try {
    await visit(page, "#discover");
    const thumbnail = page.locator('.media-open[data-post-id="sample-concert"]');
    assert.equal(await thumbnail.locator("button, [tabindex]").count(), 0);
    await thumbnail.press("Enter");
    const viewer = page.locator(".media-viewer[open]");
    const strip = viewer.getByRole("button", { name: "테이프 떼기" });
    await strip.press("Space");
    await strip.waitFor({ state: "hidden" });
    assert.ok(await viewer.locator("img").evaluate(el => el === document.activeElement));
    await viewer.getByRole("button", { name: "다음 게시물" }).click();
    assert.ok(await viewer.locator("video[controls]").isVisible());
    assert.equal(await viewer.locator(".tape-strip").count(), 0);
    await viewer.getByRole("button", { name: "이전 게시물" }).click();
    await strip.waitFor();
  } finally { await page.close(); }
});
