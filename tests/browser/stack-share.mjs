import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { serveStackShare } from "../../server/stack-share.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");

test("public Peel accepts keyboard, direct dragging and cancellation at phone and desktop widths", async () => {
  const token = "x".repeat(43);
  const members = ["pottery.webp", "pottery-rim.webp", "skate.mp4"].map((file, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`, source: "post",
    sourceId: `00000000-0000-4000-8000-00000000001${index}`,
    mediaKind: index === 2 ? "video" : "photo", caption: ["첫 작업", "완성", "움직임"][index],
    credential: "only-for-test", file,
  }));
  let active = true;
  const css = await readFile(new URL("../../public/stack-share.css", import.meta.url));
  const source = {
    async resolve(value, id) {
      return active && value === token ? { title: "작업실의 기록", items: members.filter(item => !id || item.id === id) } : null;
    },
    async media(_request, item) {
      return new Response(await readFile(new URL("../../public/images/" + item.file, import.meta.url)), {
        headers: { "Content-Type": item.mediaKind === "photo" ? "image/webp" : "video/mp4" },
      });
    },
  };
  const http = createServer(async (req, res) => {
    if (req.url === "/stack-share.css") { res.writeHead(200, { "Content-Type": "text/css" }); res.end(css); return; }
    const response = await serveStackShare(new Request("http://localhost" + req.url, { headers: req.headers, method: req.method }), source);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => http.listen(0,"127.0.0.1",resolve));
  const url = `http://127.0.0.1:${http.address().port}/stack/${token}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL });
    for (const width of [360, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width === 360, locale:"ko-KR" });
      const errors = [];
      page.on("pageerror",e => errors.push(e.message));
      await page.goto(url);
      const slider = page.getByRole("slider", { name: "마지막 사진이 보이는 비율" });
      await page.waitForFunction(() => document.querySelector(".comparison img")?.naturalWidth > 0);
      await slider.focus();
      await slider.press("End");
      assert.equal(await slider.inputValue(),"100");
      assert.equal(await slider.getAttribute("aria-valuetext"),"100퍼센트");
      assert.equal(await page.locator(".reveal").evaluate(e => getComputedStyle(e).clipPath),"inset(0px 0% 0px 0px)");
      await slider.press("Home");
      assert.equal(await slider.inputValue(),"0");
      const frame = await page.locator(".comparison").boundingBox();
      if (width === 360) {
        const session = await page.context().newCDPSession(page);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart",
          touchPoints: [{ x: frame.x + frame.width / 4, y: frame.y + frame.height / 2 }] });
        await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        assert.ok(Math.abs(Number(await slider.inputValue())-25) <= 1);
      }
      await page.mouse.move(frame.x+8, frame.y+frame.height/2);
      await page.mouse.down();
      await page.mouse.move(frame.x+frame.width*.75, frame.y+frame.height/2, { steps: 4 });
      await page.mouse.up();
      assert.ok(Math.abs(Number(await slider.inputValue())-75) <= 1);
      assert.ok(await page.locator("video").evaluate(e => e.controls));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth),width);
      if (process.env.STACK_SCREENSHOTS)
        await page.screenshot({ path: process.env.STACK_SCREENSHOTS + "/stack-public-" + width + ".png" });
      assert.deepEqual(errors,[]);
      active = false;
      assert.equal((await page.reload()).status(),404);
      assert.equal(await page.locator("img,video,input").count(),0);
      active = true;
      await page.close();
    }
  } finally {
    await browser?.close();
    http.closeAllConnections();
    await new Promise(resolve=>http.close(resolve));
  }
});
