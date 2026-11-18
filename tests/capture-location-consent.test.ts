import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CaptureLocationConsent,
  newPhotoCaptureContext,
} from "../shared/capture-location-consent.js";
import { CaptureSubmission } from "../shared/capture-submission.js";
import type { PhotoPlace } from "../shared/capture-context.js";
import type { CaptureRequest } from "../shared/types.js";

const reference = {
  post_id: "a2628aee-2c7b-4f5b-98aa-4111cd2df284",
  latitude: 37.555,
  longitude: 126.999,
};
const place: PhotoPlace = {
  latitude: 37.566,
  longitude: 126.978,
  label: "서울",
  audience: "followers",
};

test("nearby reference coordinates cannot authorize publication location", () => {
  const consent = new CaptureLocationConsent();
  const context = newPhotoCaptureContext(reference.post_id);
  consent.startPhoto("photo-a");

  assert.equal(context.referencePostId, reference.post_id);
  assert.equal(context.place, null);
  assert.equal(consent.accepts(null), false);
  assert.equal(
    consent.accepts({ photoId: "photo-a", audience: "followers" }),
    false,
    "A discovery result or cached audience is not an explicit photo request",
  );
});

test("only an explicit action for the current photographed draft gets default follower consent", () => {
  const consent = new CaptureLocationConsent();
  assert.equal(consent.request("photo-a"), null);
  consent.startPhoto("photo-a");
  assert.equal(consent.request("different-photo"), null);
  const request = consent.request("photo-a");
  assert.equal(request?.audience, "followers");
  assert.equal(consent.accepts(request), true);
  const privateRequest = consent.request("photo-a", "private");
  assert.equal(privateRequest?.audience, "private");
  assert.equal(consent.accepts(request), false);
  assert.equal(consent.accepts(privateRequest), true);
});

test("removing a place invalidates a delayed result and requires another explicit action", () => {
  const consent = new CaptureLocationConsent();
  consent.startPhoto("photo-a");
  const removed = consent.request("photo-a");
  consent.cancel();
  assert.equal(consent.accepts(removed), false);
  const requestedAgain = consent.request("photo-a");
  assert.equal(consent.accepts(requestedAgain), true);
  assert.equal(consent.accepts(removed), false);
});

test("retake resets place and invalidates the previous draft even if its URI is reused", () => {
  const consent = new CaptureLocationConsent();
  consent.startPhoto("photo-a");
  const oldRequest = consent.request("photo-a", "members");
  const oldContext = { ...newPhotoCaptureContext(reference.post_id), place };

  consent.startPhoto(null);
  assert.equal(consent.request("photo-a"), null);
  consent.startPhoto("photo-a");
  const newContext = newPhotoCaptureContext(reference.post_id);
  assert.equal(consent.accepts(oldRequest), false);
  assert.equal(newContext.place, null);
  assert.equal(oldContext.place, place, "Reset must not mutate an existing draft");
  assert.equal(consent.request("photo-a")?.audience, "followers");
});

test("leaving the foreground cancels unfinished location work while preserving the same draft", () => {
  const consent = new CaptureLocationConsent();
  consent.startPhoto("photo-a");
  const context = {
    ...newPhotoCaptureContext(reference.post_id),
    filter: "film" as const,
    place: { ...place, audience: "private" as const },
  };
  const snapshot = structuredClone(context);
  const pending = consent.request("photo-a", "private");
  consent.cancel();

  assert.equal(consent.accepts(pending), false);
  assert.deepEqual(context, snapshot);
  assert.equal(consent.request("photo-a", context.place.audience)?.audience, "private");
});

test("prepared retries retain the exact chosen photo place after draft changes", async () => {
  const context = { ...newPhotoCaptureContext(reference.post_id), place: { ...place } };
  const original: CaptureRequest = {
    action: "publish",
    challengeId: "challenge-a",
    imageBase64: "jpeg",
    caption: "one moment",
    proof: { platform: "android", token: "proof" },
    context,
  };
  const sent: CaptureRequest[] = [];
  let prepares = 0;
  const submission = new CaptureSubmission(
    async () => {
      prepares++;
      return original;
    },
    async (request) => {
      sent.push(structuredClone(request));
      if (sent.length === 1) throw Error("response lost");
      return { id: "same-post" };
    },
  );

  await assert.rejects(submission.submit(), /response lost/);
  assert.equal(submission.prepared, true);
  context.place.latitude = 35;
  context.place.label = "changed after signing";
  context.place.audience = "members";
  await submission.submit();

  assert.equal(prepares, 1);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1].context?.place, place);
});
