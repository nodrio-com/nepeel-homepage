import assert from "node:assert/strict";
import test from "node:test";
import { contentLanguage, sourceOf, translationPlan } from "../src/lib/on-device-translation";
import { localPack } from "../src/lib/translation-packs";
import { sampleMeta, samplePosts } from "../src/lib/samples";

test("reader language honors an explicit Hi preference and otherwise follows the browser", () => {
  assert.equal(contentLanguage("ko", "en-US"), "ko");
  assert.equal(contentLanguage("en", "ko-KR"), "en");
  assert.equal(contentLanguage(null, "de-DE"), "de");
  assert.equal(contentLanguage(null, "zh-TW"), "zh-Hant");
  assert.equal(contentLanguage(null, "???"), "ko");
});

test("identifies general foreign input on-device and keeps nonlinguistic and same-language content", async () => {
  for (const [source, language] of [
    ["처음 보는 풍경이에요.", "ko"], ["Nice photo!", "en"], ["Beautiful sunset!", "en"],
    ["Hello!", "en"], ["다음에 또 만나요", "ko"], ["La estación está cerca de mi casa.", "es"],
    ["とてもきれいな景色ですね。", "ja"],
  ]) assert.equal(await sourceOf(source), language, source);
  assert.equal(await sourceOf("😊 123 @hello https://example.com/en"), undefined);
  assert.equal(await translationPlan("Where are you going?", "en"), undefined);
});

test("an available or downloadable native pair takes priority without starting a download during inspection", async () => {
  const pair = { sourceLanguage: "ko", targetLanguage: "fr" };
  let creates = 0;
  let state = "downloadable";
  const native = {
    async availability(options: unknown) { assert.deepEqual(options, pair); return state; },
    async create() { creates++; throw new Error("Should require activation"); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Translator");
  Object.defineProperty(globalThis, "Translator", { configurable: true, value: native });
  try {
    assert.equal((await translationPlan("산에 올랐어요.", "fr"))?.download, true);
    state = "available";
    assert.equal((await translationPlan("산에 올랐어요.", "fr"))?.download, false);
    state = "unavailable";
    assert.equal(await translationPlan("산에 올랐어요.", "fr"), undefined);
    assert.equal(creates, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "Translator", previous);
    else Reflect.deleteProperty(globalThis, "Translator");
  }
});

test("portable packs are directional and guest captions carry a maintained translation", () => {
  assert.equal(localPack("en", "ko")?.from, "en");
  assert.equal(localPack("ko", "en")?.to, "en");
  assert.equal(localPack("en", "de"), undefined);
  for (const post of samplePosts) {
    const entry = sampleMeta.find(sample => sample.id === post.id);
    assert.equal(entry?.caption, post.caption);
    assert.ok(entry?.englishCaption && entry.englishCaption !== post.caption);
  }
});
