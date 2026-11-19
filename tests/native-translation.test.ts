import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslationQueue, translationLanguage } from "../mobile/lib/local-translation";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("translation follows the device's primary language", () => {
  assert.equal(translationLanguage("ko-KR"), "ko");
  assert.equal(translationLanguage("en_US"), "en");
  assert.equal(translationLanguage("zh-Hant-TW"), "zh");
});

test("original text remains visible for unsupported, offline and unchanged results", async () => {
  const results: string[] = [];
  const engine = { translate: async (text: string) => {
    if (text === "offline") throw Error("offline");
    return text === "unsupported" ? null : text;
  } };
  const submit = createTranslationQueue(engine);
  for (const text of ["unsupported", "same", "offline"]) submit(text, "ko", result => results.push(result));
  createTranslationQueue(null)("Hello", "ko", result => results.push(result));
  await flush();
  assert.deepEqual(results, []);
});

test("rapid scrolling limits concurrent native work and ignores stale translations", async () => {
  const pending: Array<(text: string) => void> = [];
  const calls: string[] = [], shown: string[] = [];
  const submit = createTranslationQueue({ translate(text, target) {
    calls.push(text + "/" + target);
    return new Promise<string>(resolve => pending.push(resolve));
  } });
  const request = (text: string) => submit(text, "en", result => shown.push(result));
  const unmount = request("하나");
  request("둘");
  request("셋")();
  request("넷");
  request("🎉");
  assert.deepEqual(calls, ["하나/en", "둘/en"]);
  unmount();
  pending[0]("one");
  await flush();
  assert.deepEqual(calls, ["하나/en", "둘/en", "넷/en"]);
  pending[1]("two");
  pending[2]("four");
  await flush();
  assert.deepEqual(shown, ["two", "four"]);
});
