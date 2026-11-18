import test from "node:test";
import assert from "node:assert/strict";
import { browseHash, readBrowseRoute } from "../src/lib/browse-route";
test("home defaults to a stream and the explicit grid survives filters and viewer history", () => {
  assert.equal(readBrowseRoute("").layout, undefined);
  assert.equal(readBrowseRoute("#feed").layout, undefined);
  const hash = "#feed?layout=grid&show=video&open=sample-skate";
  assert.equal(browseHash(readBrowseRoute(hash)), hash);
  for (const other of ["#discover", "#post/abc", "#unknown"])
    assert.equal(readBrowseRoute(other + "?layout=grid").layout, undefined);
});
test("a viewer URL preserves its gallery and Korean search across reload or back", () => {
  const route = { view: "discover", filter: "video", search: "스케이트 & 공연", open: "sample-kickflip", postId: "" } as const;
  assert.deepEqual(readBrowseRoute(browseHash(route)), route);
});
test("legacy private links stay private post routes and unknown filters reset", () => {
  assert.equal(readBrowseRoute("#post/abc?open=abc").postId, "abc");
  assert.equal(readBrowseRoute("#saved?show=following").filter, "all");
  assert.equal(readBrowseRoute("#feed?show=following").filter, "following");
  assert.equal(readBrowseRoute("#garbage").view, "feed");
});
