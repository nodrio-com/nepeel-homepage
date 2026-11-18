export const views = ["feed", "discover", "stacks", "hi", "profile", "saved", "about"] as const;
export type View = typeof views[number];
export type MediaFilter = "all" | "photo" | "video" | "following";

export type BrowseRoute = {
  view: View;
  filter: MediaFilter;
  search: string;
  open: string;
  postId: string;
};

export function readBrowseRoute(hash: string): BrowseRoute {
  const raw = hash.replace(/^#/, "");
  const split = raw.indexOf("?");
  const path = split < 0 ? raw : raw.slice(0, split);
  const params = new URLSearchParams(split < 0 ? "" : raw.slice(split + 1));
  const view = views.find(v => v === path) ?? "feed";
  const f = params.get("show");
  const filter = f === "photo" || f === "video" || (f === "following" && view === "feed") ? f : "all";
  return { view, filter, search: view === "discover" ? (params.get("q") ?? "").slice(0, 80) : "",
    open: params.get("open")?.slice(0, 100) ?? "", postId: path.startsWith("post/") ? path.slice(5, 105) : "" };
}

export function browseHash(route: BrowseRoute) {
  const params = new URLSearchParams();
  if (route.search && route.view === "discover") params.set("q", route.search);
  if (route.filter !== "all") params.set("show", route.filter);
  if (route.open) params.set("open", route.open);
  const query = params.toString();
  return "#" + (route.postId ? "post/" + route.postId : route.view) + (query ? "?" + query : "");
}
