export const views = ["feed", "discover", "stacks", "hi", "profile", "saved", "about"] as const;
export type View = typeof views[number];
export type MediaFilter = "all" | "photo" | "video";

export type BrowseRoute = {
  view: View;
  audience?: "following";
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
  const f = params.get("show");
  const filter = f === "photo" || f === "video" ? f : "all";
  const following = path === "feed" && (params.get("audience") === "following" || f === "following");
  const view = path === "feed" && params.get("layout") === "grid" && !following
    ? "discover" : views.find(v => v === path) ?? "feed";
  return { view, filter, ...(following ? { audience: "following" as const } : {}),
    search: view === "discover" || view === "saved" ? (params.get("q") ?? "").slice(0, 80) : "",
    open: params.get("open")?.slice(0, 100) ?? "", postId: path.startsWith("post/") ? path.slice(5, 105) : "" };
}

export function browseHash(route: BrowseRoute) {
  const params = new URLSearchParams();
  if (route.view === "feed" && !route.postId && route.audience === "following") params.set("audience", "following");
  if (route.search && (route.view === "discover" || route.view === "saved")) params.set("q", route.search);
  if (route.filter !== "all") params.set("show", route.filter);
  if (route.open) params.set("open", route.open);
  const query = params.toString();
  return "#" + (route.postId ? "post/" + route.postId : route.view) + (query ? "?" + query : "");
}
