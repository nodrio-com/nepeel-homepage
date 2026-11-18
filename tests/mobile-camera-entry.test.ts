import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeCameraLinks } from "../mobile/lib/camera-entry.js";

function linking() {
  let finish!: (url: string | null) => void;
  let listener: ((event: { url: string }) => void) | undefined;
  let opens = 0;
  const initial = new Promise<string | null>(resolve => { finish = resolve; });
  const stop = subscribeCameraLinks({
    getInitialURL: () => initial,
    addEventListener(_type, receive) {
      listener = receive;
      return { remove: () => { listener = undefined; } };
    },
  }, () => { opens++; });
  return {
    live: (url: string) => listener?.({ url }),
    async launch(url: string | null) { finish(url); await initial; },
    opens: () => opens,
    stop,
  };
}

test("the camera link opens on launch and on later visits and ignores unrelated addresses", async () => {
  const app = linking();
  await app.launch("nepeel://camera");
  assert.equal(app.opens(), 1);
  for (const url of ["nepeel://camera-other", "nepeel://camera/path", "nepeel://camera@elsewhere", "https://camera"]) app.live(url);
  assert.equal(app.opens(), 1);
  app.live("nepeel://camera/");
  assert.equal(app.opens(), 2);
  app.stop();
  app.live("nepeel://camera");
  assert.equal(app.opens(), 2);
});

test("a live camera link supersedes a late cold-start response and disposal cancels it", async () => {
  const app = linking();
  app.live("nepeel://camera");
  await app.launch("nepeel://camera");
  assert.equal(app.opens(), 1);
  const closed = linking();
  closed.stop();
  await closed.launch("nepeel://camera");
  assert.equal(closed.opens(), 0);
});
