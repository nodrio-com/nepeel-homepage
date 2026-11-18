import test from "node:test";
import assert from "node:assert/strict";
import { browseHash, readBrowseRoute } from "../src/lib/browse-route";
test("home opens the stream and legacy public grid links resolve to Explore with their original media", () => {
  assert.equal(readBrowseRoute("").view, "feed");
  assert.equal(readBrowseRoute("#feed").view, "feed");
  assert.equal(browseHash(readBrowseRoute("#feed?layout=grid&show=video&open=sample-skate")),
    "#discover?show=video&open=sample-skate");
  assert.equal(browseHash(readBrowseRoute("#feed?show=photo&layout=grid")), "#discover?show=photo");
  assert.equal(browseHash(readBrowseRoute("#post/abc?layout=grid")), "#post/abc");
});
test("a viewer URL preserves its gallery and Korean search across reload or back", () => {
  const route = { view: "discover", filter: "video", search: "스케이트 & 공연", open: "sample-kickflip", postId: "" } as const;
  assert.deepEqual(readBrowseRoute(browseHash(route)), route);
});
test("legacy private links stay private post routes and unknown filters reset", () => {
  assert.equal(readBrowseRoute("#post/abc?open=abc").postId, "abc");
  assert.equal(readBrowseRoute("#saved?show=following").filter, "all");
  assert.equal(readBrowseRoute("#feed?show=following").audience, "following");
  assert.equal(readBrowseRoute("#garbage").view, "feed");
});
test("old following grids retain their home audience, media filter and detail; saved searches stay scoped", () => {
  const route = readBrowseRoute("#feed?layout=grid&audience=following&show=video&open=abc");
  assert.equal(route.filter, "video");
  assert.equal(route.audience, "following");
  assert.equal(route.view, "feed");
  assert.equal(browseHash(route), "#feed?audience=following&show=video&open=abc");
  assert.equal(browseHash(readBrowseRoute("#feed?show=following&layout=grid")), "#feed?audience=following");
  assert.deepEqual(readBrowseRoute(browseHash(route)), route);
  assert.equal(readBrowseRoute("#discover?audience=following").audience, undefined);
  assert.equal(readBrowseRoute("#feed?show=following").filter, "all");
  const saved = readBrowseRoute("#saved?q=공연&show=photo");
  assert.equal(saved.search, "공연");
  assert.deepEqual(readBrowseRoute(browseHash(saved)), saved);
});
