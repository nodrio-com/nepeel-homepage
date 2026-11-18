import { Play } from "lucide-react";
import type { Post } from "../../shared/types";
import { sampleMeta } from "../lib/samples";

export function mediaTitle(post: Post) {
  return sampleMeta.find(s => s.id === post.id)?.tag ?? (post.caption.trim() || post.display_name + "의 게시물");
}

export function MediaGrid({ posts, dense, onOpen }: {
  posts: Post[];
  dense: boolean;
  onOpen: (post: Post) => void;
}) {
  return <div className={"media-grid" + (dense ? " dense" : "")}>
    {posts.map((post, i) => {
      const video = post.media_type === "video";
      const title = mediaTitle(post);
      return <article className="media-tile" key={post.id}>
        <button className="media-open" data-post-id={post.id} aria-label={title + (video ? " 동영상 재생" : " 사진 보기")}
          onClick={event => { event.currentTarget.focus({ preventScroll: true }); onOpen(post); }}>
          <span className="media-cover">
            {video && !post.poster_url ? <video src={post.image_url} muted playsInline preload="metadata" aria-hidden="true" /> :
              <img src={video ? post.poster_url : post.image_url} alt="" loading={i < 6 ? "eager" : "lazy"} decoding="async" />}
            {video && <span className="clip-marker" aria-hidden="true"><Play size={15} fill="currentColor" /></span>}
          </span>
        </button>
      </article>;
    })}
  </div>;
}
