import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { certificateRange, serveStackShare, type PublicStackItem, type StackShareSource } from "../server/stack-share.js";
import stackPreview from "../netlify/functions/stack-preview.js";
import stackShare from "../netlify/functions/stack-share.js";
import { certificateCommitment } from "../server/certificate-commitment.js";
import { shareToken } from "../server/certificate-owner.js";

const token = "m".repeat(43), otherToken = "v".repeat(43);
const base = "https://nepeel.example/stack/" + token;
const member: PublicStackItem = { id: randomUUID(), source: "post", sourceId: randomUUID(), mediaKind: "photo",
  caption: '<img src=x onerror="injected">', credential: otherToken };
const picture = { ...member, id: randomUUID(), caption: "" };
const video: PublicStackItem = { ...member, id: randomUUID(), source: "certificate", mediaKind: "video", caption: "" };
const members = [member, video, picture];
const source: StackShareSource = {
  async resolve(value, id) {
    return value === token ? { title: "<우리 묶음>", items: id ? members.filter(item => item.id === id) : members } : null;
  },
  async media() {
    return new Response("abc", { headers: { "Content-Type": "image/jpeg", "Content-Location": "private-storage",
      "Content-Length": "3", "Set-Cookie": "private" } });
  },
};

test("anonymous viewer emits ordered escaped content, a gated Peel comparison, and native video without revealing lower grants", async () => {
  const response = await serveStackShare(new Request(base), source);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<h1>&lt;우리 묶음&gt;<\/h1>/);
  assert.match(html, /&lt;img src=x onerror=&quot;injected&quot;&gt;/);
  assert.ok(!html.includes(otherToken) && !html.includes(member.sourceId!));
  assert.doesNotMatch(html, /https?:\/\/|\/s\/|\/verify\/(?!stack\/)|<img src=x/);
  assert.deepEqual([...html.matchAll(/href="(\/verify\/[^"]+)"/g)].map(match => match[1]), [`/verify/stack/${token}/${video.id}`]);
  assert.match(html, /<video[^>]+controls playsinline/);
  assert.match(html, /type="range"/);
  const list = html.split("<ol")[1];
  assert.ok(list.indexOf(member.id) < list.indexOf(video.id) && list.indexOf(video.id) < list.indexOf(picture.id));
  assert.match(response.headers.get("Content-Security-Policy")!, /script-src 'sha256-/);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const one = await serveStackShare(new Request(base), { ...source, async resolve() { return { title: "A", items: [video] }; } });
  assert.doesNotMatch(await one.text(), /type="range"|<script>/);
  const empty = await serveStackShare(new Request(base), { ...source, async resolve() { return { title: "A", items: [] }; } });
  assert.match(await empty.text(), /공개된 항목이 없어요/);
});

test("tape enhances only post photos while legacy, certificate and video media stay intact", async () => {
  const items: PublicStackItem[] = [
    { ...member, tape: "bottom" }, { ...picture, source: "certificate", tape: "top" },
    { ...video, source: "post", tape: "center" }, { ...picture, id: randomUUID() },
  ];
  const page = await serveStackShare(new Request(base), {
    ...source, async resolve() { return { title: "공유", items }; },
  });
  const html = await page.text();
  assert.deepEqual(html.match(/data-share-tape="[^"]*"/g), ['data-share-tape="bottom"']);
  assert.equal(html.match(/data-share-caption/g)?.length, 1);
  assert.match(html, /<figcaption data-share-caption>&lt;img/);
  assert.match(html, /<script type="module" src="\/share-enhancements\.js" referrerpolicy="no-referrer"><\/script>/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const legacy = await serveStackShare(new Request(base), {
    ...source, async resolve() { return { title: "공유", items: [picture] }; },
  });
  assert.doesNotMatch(await legacy.text(), /data-share-tape|data-share-caption|share-enhancements\.js/);
  assert.doesNotMatch(legacy.headers.get("content-security-policy")!, /script-src|worker-src|connect-src/);
});

test("certificate views reject ordinary items and proof headers cannot cross over from ordinary media or error responses", async () => {
  const headers = { "Content-Type":"image/jpeg", "X-Certificate-State":"minted", "X-Certificate-Origin":"ios",
    "X-Display-SHA256":"a".repeat(64), "X-Certificate-Tx":"B".repeat(64), "X-Certificate-Token":"C".repeat(64) };
  let status = 200, calls = 0;
  const gate = { ...source, async media() { calls++; return new Response(null,{ status,headers }); } };
  const ordinary = base + "/media/" + member.id;
  const proof = base + "/media/" + video.id + "?certificate=1";
  assert.equal((await serveStackShare(new Request(ordinary + "?certificate=1"),gate)).status,404);
  assert.equal(calls,0);
  assert.equal((await serveStackShare(new Request(ordinary),gate)).headers.get("X-Certificate-State"),null);
  const verified = await serveStackShare(new Request(proof,{method:"HEAD"}),gate);
  for (const [key,value] of Object.entries(headers)) assert.equal(verified.headers.get(key),value);
  status = 409;
  const mismatch = await serveStackShare(new Request(proof),gate);
  assert.equal(mismatch.status,409);
  assert.equal(mismatch.headers.get("X-Display-SHA256"),null);
});

test("stack and member gates are rechecked after media verification including HEAD and byte ranges", async () => {
  const mediaURL = base + "/media/" + member.id;
  const good = await serveStackShare(new Request(mediaURL), source);
  assert.equal(await good.text(), "abc");
  assert.equal(good.headers.get("content-type"), "image/jpeg");
  assert.equal(good.headers.get("content-location"), null);
  assert.equal(good.headers.get("set-cookie"), null);
  assert.equal(good.headers.get("Netlify-CDN-Cache-Control"), "no-store");
  for (const ending of [null, { title: "A", items: [] }, { title: "A", items: [{ ...member, credential: "new" }] }]) {
    let checks = 0;
    const req = new Request(mediaURL, { method: "HEAD", headers: { Range: "bytes=0-1" } });
    const response = await serveStackShare(req, {
      async resolve(value, id) {
        assert.equal(value, token); assert.equal(id,member.id);
        return ++checks === 1 ? { title: "A", items: [member] } : ending;
      },
      async media(incoming) {
        assert.equal(incoming.method, "HEAD");
        assert.equal(incoming.headers.get("range"), "bytes=0-1");
        return new Response(null, { status: 206 });
      },
    });
    assert.equal(checks, 2);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }
  assert.equal((await serveStackShare(new Request(base, { method: "POST" }), source)).status, 405);
  assert.equal((await serveStackShare(new Request(base + "/media/bad"), source)).status, 404);
  assert.equal((await serveStackShare(new Request(base + "/media/" + randomUUID()), source)).status, 404);
  assert.equal((await serveStackShare(new Request(base), { ...source, async resolve() { throw Error("secret"); } })).status,503);
});

test("certificate video ranges preserve verified bytes and reject invalid or unsatisfiable ranges", async () => {
  const payload = () => new Response("12345678", { headers: { "Content-Type": "video/mp4" } });
  for (const [range, expected] of [["bytes=2-4","345"], ["bytes=5-","678"], ["bytes=-4","5678"], ["bytes=0-999","12345678"]]) {
    const response = await certificateRange(new Request(base, { headers: { Range: range } }), payload());
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Length"), String(expected.length));
    assert.equal(await response.text(), expected);
  }
  for (const range of ["bytes=8-10", "bytes=2-0", "bytes=-0", "bytes=0-1,3-4", "bad"])
    assert.equal((await certificateRange(new Request(base, { headers: { Range: range } }), payload())).status, 416);
  assert.equal((await certificateRange(new Request(base, { headers: { Range: "bytes=0-1" } }), new Response(null,{status:409}))).status,409);
});

test("private certificate previews validate the bearer, owner, state and object digest before sending media", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL, previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const owner = randomUUID(), id = randomUUID(), path = id + "/media.mp4";
  let found = true, damaged = false, downloads = 0;
  const endpoint = "https://stack.example/api/stack-preview/" + id;
  process.env.SUPABASE_URL = "https://stack-preview.supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(request.headers.get("authorization"), "Bearer user-test-token");
      return Response.json({ id: owner, aud: "authenticated" });
    }
    if (url.pathname === "/rest/v1/media_certificates") {
      assert.equal(url.searchParams.get("user_id"), "eq." + owner);
      assert.equal(url.searchParams.get("id"), "eq." + id);
      assert.match(url.searchParams.get("state")!, /queued.*minted/);
      return Response.json(found ? [{ object_path: path, media_kind:"video", display_hash: createHash("sha256").update("abcd").digest("hex") }] : []);
    }
    assert.ok(url.pathname.endsWith("/certificate-media/" + path));
    downloads++;
    return new Response(damaged ? "wrong" : "abcd");
  };
  try {
    assert.equal((await stackPreview(new Request(endpoint))).status, 401);
    const get = () => stackPreview(new Request(endpoint, { headers: { Authorization: "Bearer user-test-token" } }));
    const ok = await get();
    assert.equal(ok.status,200);
    assert.equal(ok.headers.get("content-type"),"video/mp4");
    assert.equal(ok.headers.get("cache-control"),"private, no-store");
    assert.equal(await ok.text(),"abcd");
    damaged = true;
    assert.equal((await get()).status,409);
    found = false;
    assert.equal((await get()).status,404);
    assert.equal(downloads,2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

test("the Netlify stack handler serves a queued camera video through the existing certificate verifier", async () => {
  const previousFetch = globalThis.fetch;
  const settings = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","CERTIFICATE_LINK_SECRET"] as const;
  const previous = settings.map(name => process.env[name]);
  process.env.SUPABASE_URL = "https://stack-public.supabase.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  process.env.CERTIFICATE_LINK_SECRET = "local-stack-test-secret".repeat(2);
  const id = randomUUID(), nonce = "owner-issued-nonce", endpoint = base + "/media/" + video.id;
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  const expectedHash = digest(shareToken(id,nonce));
  const bytes = "camera-video", input = digest("original"), display = digest(bytes), salt = "2".repeat(64);
  const row = { id,media_kind:"video",source_hash:input,display_hash:display,salt,platform:"ios",state:"queued",
    object_path:id+"/media.mp4",commitment:certificateCommitment(id,"video",input,display,salt) };
  let damaged = false, stillShared = true, downloads = 0;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname === "/rest/v1/rpc/resolve_work_stack") {
      assert.deepEqual(await req.json(), { p_token:token,p_item:video.id });
      return Response.json({ title:"작업",items:[{ ...video,sourceId:id,credential:nonce }] });
    }
    if (url.pathname === "/rest/v1/media_certificates") {
      assert.equal(url.searchParams.get("share_hash"),"eq." + expectedHash);
      if (url.searchParams.get("select") === "id") return Response.json(stillShared ? [{id}] : []);
      return Response.json([row]);
    }
    assert.ok(url.pathname.endsWith("/certificate-media/" + row.object_path));
    downloads++;
    return new Response(damaged ? "bad" : bytes);
  };
  try {
    const proof = endpoint + "?certificate=1";
    for (const method of ["GET","HEAD"]) {
      const checked = await stackShare(new Request(proof,{method}));
      assert.equal(checked.status,200);
      assert.equal(checked.headers.get("X-Certificate-State"),"queued");
      assert.equal(checked.headers.get("X-Certificate-Origin"),"ios");
      assert.equal(checked.headers.get("X-Display-SHA256"),display);
      assert.equal(checked.headers.get("X-Certificate-Tx"),null);
      assert.equal(checked.headers.get("X-Certificate-Token"),null);
      assert.equal(await checked.text(),method === "GET" ? bytes : "");
    }
    const get = () => stackShare(new Request(endpoint, { headers: { Range: "bytes=2-5" } }));
    const ok = await get();
    assert.equal(ok.status,206);
    assert.equal(ok.headers.get("content-range"),"bytes 2-5/12");
    assert.equal(ok.headers.get("content-type"),"video/mp4");
    assert.equal(ok.headers.get("X-Display-SHA256"),null);
    assert.equal(await ok.text(),bytes.slice(2,6));
    damaged = true;
    assert.equal((await get()).status,409);
    damaged = false;
    stillShared = false;
    assert.equal((await get()).status,404);
    assert.equal((await stackShare(new Request(proof,{method:"HEAD"}))).status,404);
    assert.equal(downloads,4);
  } finally {
    globalThis.fetch = previousFetch;
    settings.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    });
  }
});

test("stack-only media uses the authorized post path or verified certificate and rechecks the grant after storage", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL, previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = "https://stack-scoped.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-service-key";
  const path = "owner/photo.png", bytes = "checked";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const sourceId = randomUUID(), input = digest("capture"), display = digest(bytes), salt = "a".repeat(64);
  const row = { id:sourceId, media_kind:"video", source_hash:input, display_hash:display, salt, platform:"android",
    state:"queued", object_path:sourceId+"/media.mp4", commitment:certificateCommitment(sourceId,"video",input,display,salt) };
  const scopedPost = { ...member, credential:randomUUID(), stackScoped:true, imagePath:path, mimeType:"image/png" };
  const scopedCertificate = { ...video, sourceId, credential:randomUUID(), stackScoped:true };
  let revoked = false, revokeDuringDownload = false, corrupt = false, missingReceipt = false;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.pathname === "/rest/v1/rpc/resolve_work_stack") {
      const {p_token,p_item} = await req.json();
      assert.equal(p_token,token);
      return Response.json({title:"작업",items:revoked ? [] : [scopedPost,scopedCertificate].filter(i=>i.id===p_item)});
    }
    if (url.pathname === "/rest/v1/media_certificates") {
      assert.equal(url.searchParams.get("id"),"eq."+sourceId);
      assert.equal(url.searchParams.has("share_hash"),false);
      if (url.searchParams.get("select")==="id") {
        assert.equal(url.searchParams.get("display_hash"),"eq."+display);
        return Response.json([{ id:sourceId }]);
      }
      return Response.json([{...row, state:missingReceipt ? "minted" : "queued"}]);
    }
    if (url.pathname.endsWith("/certificate-media/"+row.object_path)) {
      if (revokeDuringDownload) revoked = true;
      return new Response(corrupt ? "wrong" : bytes);
    }
    assert.ok(url.pathname.endsWith("/object/sign/captures/"+path));
    if (req.method === "POST") return Response.json({ signedURL:"/object/sign/captures/"+path+"?token=internal" });
    assert.equal(req.headers.get("range"),"bytes=0-2");
    if (revokeDuringDownload) revoked = true;
    return new Response("png",{status:206,headers:{ "Content-Range":"bytes 0-2/9", "Content-Location":"forbidden" }});
  };
  try {
    const post = () => stackShare(new Request(base+"/media/"+scopedPost.id,{ headers:{ Range:"bytes=0-2" }}));
    const proof = () => stackShare(new Request(base+"/media/"+scopedCertificate.id+"?certificate=1"));
    const photo = await post();
    assert.equal(photo.status,206);
    assert.equal(photo.headers.get("Content-Type"),"image/png");
    assert.equal(photo.headers.get("Content-Location"),null);
    assert.equal(await photo.text(),"png");
    const verified = await proof();
    assert.equal(verified.headers.get("X-Display-SHA256"),display);
    assert.equal(await verified.text(),bytes);
    corrupt = true;
    assert.equal((await proof()).status,409);
    corrupt = false;
    missingReceipt = true;
    assert.equal((await proof()).status,409);
    missingReceipt = false;
    revokeDuringDownload = true;
    assert.equal((await proof()).status,404);
    revoked = false;
    assert.equal((await post()).status,404);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
