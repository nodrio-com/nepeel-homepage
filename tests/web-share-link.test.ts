import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { deliverMediaLink } from "../src/lib/share-link";

const url = "https://nepeel.example/s/photo";
const title = "게시물";

function browser(t: TestContext, userAgent: string, coarsePointer = false) {
  const calls: string[] = [];
  const nav = {
    userAgent,
    maxTouchPoints: coarsePointer ? 5 : 0,
    canShare: (_data: ShareData) => true,
    async share(data: ShareData) {
      assert.deepEqual(data, { url, title });
      calls.push("share");
    },
    clipboard: { async writeText(value: string) {
      assert.equal(value, url);
      calls.push("copy");
    } },
  };
  for (const [key, value] of Object.entries({
    window: { matchMedia: () => ({ matches: coarsePointer }) }, navigator: nav,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { nav, calls };
}

test("desktop browsers copy exactly once, including touch-capable Windows", async t => {
  for (const [agent, touch] of [["Windows NT 10.0", true], ["Macintosh", false], ["Linux x86_64", false]] as const) {
    await t.test(agent, async t => {
      const { calls } = browser(t, agent, touch);
      assert.equal(await deliverMediaLink(url, title), "copied");
      assert.deepEqual(calls, ["copy"]);
    });
  }
});

test("mobile browsers invoke the OS sheet during the click and skip the clipboard", async t => {
  for (const [agent, touch] of [["Android", false], ["iPhone", true], ["Macintosh", true], ["Tablet", true]] as const) {
    await t.test(agent, async t => {
      const { calls } = browser(t, agent, touch);
      const delivery = deliverMediaLink(url, title);
      assert.deepEqual(calls, ["share"]);
      assert.equal(await delivery, "shared");
      assert.deepEqual(calls, ["share"]);
    });
  }
});

test("dismissing the OS sheet never copies the link or requests manual delivery", async t => {
  const { nav, calls } = browser(t, "Android", true);
  nav.share = async () => { throw { name: "AbortError" }; };
  assert.equal(await deliverMediaLink(url, title), "cancelled");
  assert.deepEqual(calls, []);
});

test("unsupported share data or rejected sheet uses the clipboard", async t => {
  const { nav, calls } = browser(t, "iPhone", true);
  nav.canShare = () => false;
  assert.equal(await deliverMediaLink(url, title), "copied");
  nav.canShare = () => true;
  nav.share = async () => { throw new DOMException("Unavailable", "NotAllowedError"); };
  assert.equal(await deliverMediaLink(url, title), "copied");
  assert.deepEqual(calls, ["copy", "copy"]);
});

test("unavailable or denied clipboard requests manual delivery", async t => {
  const { nav, calls } = browser(t, "Windows NT", false);
  nav.clipboard.writeText = async () => { throw new DOMException("Denied", "NotAllowedError"); };
  assert.equal(await deliverMediaLink(url, title), "manual");
  Reflect.deleteProperty(nav, "clipboard");
  assert.equal(await deliverMediaLink(url, title), "manual");
  assert.deepEqual(calls, []);
});
