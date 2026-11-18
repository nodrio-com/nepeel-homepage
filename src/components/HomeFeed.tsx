import { Aperture, Maximize2 } from "lucide-react";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import type { Post } from "../../shared/types";
import { sampleMeta } from "../lib/samples";
import { mediaTitle } from "./MediaGrid";
import { browseHash } from "../lib/browse-route";

type Props = {
  posts: Post[];
  onOpen: (post: Post) => void;
  onTopic: (event: MouseEvent<HTMLAnchorElement>, topic: string) => void;
  actions: (post: Post) => ReactNode;
  viewerOpen: boolean;
};

export function HomeFeed({ posts, onOpen, onTopic, actions, viewerOpen }: Props) {
  const playing = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (viewerOpen) playing.current?.pause();
  }, [viewerOpen]);
  const next = posts.slice(1, 4);
  return <div className="home-stream">
    <div className="feed-list">
      {posts.map((post, index) => {
        const meta = post.sample ? sampleMeta.find(item => item.id === post.id) : undefined;
        const title = mediaTitle(post);
        const video = post.media_type === "video";
        return <article className="post" key={post.id}>
          <header className="post-header">
            <span aria-hidden="true" className={meta ? "sample-avatar" : "avatar tone-" + index % 4}>
              {meta ? <Aperture size={20}/> : post.display_name.slice(0, 1)}
            </span>
            <div className="post-person"><b>{post.display_name}</b>
              <small>{meta ? <><a className="post-topic" id={"post-topic-" + post.id} href={browseHash({ view: "discover", filter: "all", search: meta.category, open: "", postId: "" })}
                onClick={event => onTopic(event, meta.category)}>{meta.category}</a>{meta.creator && <span>· {meta.creator}</span>}</> : "@" + post.username}</small>
            </div>
            {video && <button type="button" className="icon-button" aria-label={title + " 동영상 크게 보기"}
              onClick={() => onOpen(post)}><Maximize2 size={18}/></button>}
          </header>
          {video ? <video className="stream-video" src={post.image_url} poster={post.poster_url}
            controls muted playsInline preload={post.poster_url ? "none" : "metadata"} aria-label={title}
            onPlay={event => {
              if (playing.current !== event.currentTarget) playing.current?.pause();
              playing.current = event.currentTarget;
            }}/> :
            <button type="button" className="post-photo" data-post-id={post.id} aria-label={title + " 사진 보기"}
              onClick={event => { event.currentTarget.focus({ preventScroll: true }); onOpen(post); }}>
              <img src={post.image_url} alt={post.caption || title} loading={index === 0 ? "eager" : "lazy"} decoding="async"/>
            </button>}
          {actions(post)}
          <div className="post-copy">
            {Number(post.like_count) > 0 && <strong className="like-count">좋아요 {Number(post.like_count).toLocaleString()}개</strong>}
            {meta && <b>{meta.title}</b>}
            {post.caption && <p>{post.caption}</p>}
          </div>
        </article>;
      })}
    </div>
    {next.length > 0 && <aside className="stream-next" aria-label="이어서 보기">
      <h2>이어서 보기</h2>
      {next.map(post => {
        const cover = post.media_type === "video" ? post.poster_url : post.image_url;
        return <button className="rail-moment" key={post.id} onClick={() => onOpen(post)}>
          {cover && <img src={cover} alt="" loading="lazy"/>}
          <span><b>{mediaTitle(post)}</b><small>{post.media_type === "video" ? "동영상" : "사진"} · {post.display_name}</small></span>
        </button>;
      })}
    </aside>}
  </div>;
}
