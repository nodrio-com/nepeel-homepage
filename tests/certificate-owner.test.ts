import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { changeCertificateShare } from "../server/certificate-owner.js";

test("the owner's share URL survives retries and changes only after revocation", async (t) => {
  const originalOrigin = process.env.CERTIFICATE_PUBLIC_ORIGIN;
  const originalSecret = process.env.CERTIFICATE_LINK_SECRET;
  process.env.CERTIFICATE_PUBLIC_ORIGIN = "https://example.test";
  process.env.CERTIFICATE_LINK_SECRET = randomBytes(32).toString("hex");
  t.after(() => {
    if (originalOrigin === undefined) delete process.env.CERTIFICATE_PUBLIC_ORIGIN;
    else process.env.CERTIFICATE_PUBLIC_ORIGIN = originalOrigin;
    if (originalSecret === undefined) delete process.env.CERTIFICATE_LINK_SECRET;
    else process.env.CERTIFICATE_LINK_SECRET = originalSecret;
  });
  const owner = randomUUID();
  const id = "96ed64ef-7642-4240-ad1b-27a69e7360b6";
  const record = { id, share_hash: null as string | null, share_nonce: null as string | null };
  const client = createClient("https://example.test", "public-test-key", {
    global: { fetch: async (input, init) => {
      const query = new URL(String(input)).searchParams;
      assert.equal(query.get("id")?.toLowerCase(), "eq." + id);
      const owns = query.get("user_id") === "eq." + owner;
      if (init?.method === "GET") {
        assert.equal(query.get("state"), "neq.uploading");
        return Response.json(owns ? [record] : []);
      }
      assert.equal(init?.method, "PATCH");
      assert.ok(owns);
      const patch = JSON.parse(String(init.body));
      if (patch.share_hash !== null)
        assert.equal(query.get("share_hash"), record.share_hash ? "eq." + record.share_hash : "is.null");
      Object.assign(record, patch);
      return Response.json({ id });
    } },
  });
  const share = async (value: string) => {
    const result = await changeCertificateShare(client, owner, value, false);
    assert.ok(result.url);
    return new URL(result.url);
  };
  const first = await share(id);
  assert.equal(first.origin, "https://example.test");
  assert.match(first.pathname, /^\/verify\/[A-Za-z0-9_-]{43}$/);
  const token = first.pathname.split("/").at(-1)!;
  assert.equal(createHash("sha256").update(token).digest("hex"), record.share_hash);
  assert.equal((await share(id.toUpperCase())).href, first.href);
  await assert.rejects(changeCertificateShare(client, randomUUID(), id, false), { status: 404 });
  assert.deepEqual(await changeCertificateShare(client, owner, id, true), { revoked: true });
  assert.equal(record.share_hash, null);
  assert.equal(record.share_nonce, null);
  assert.notEqual((await share(id)).href, first.href);
});
