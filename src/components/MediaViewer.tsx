import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, TouchEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowUpRight, ChevronLeft, ChevronRight, Film, Image, ListVideo, Pause, RotateCw, Send, X } from "lucide-react";
import { useComments } from "../../shared/useComments";
import type { CommentDrafts } from "../../shared/commentDrafts";
import type { Post } from "../../shared/types";
import { Avatar } from "../App";
import { supabase } from "../lib/supabase";
import PhotoPlace from "./PhotoPlace";
import { sampleMeta } from "../lib/samples";
import { TranslatedText } from "./TranslatedText";
import { TapedPhoto } from "./TapedPhoto";
import "./media-viewer.css";

interface ViewerProps {
  post: Post;
  actions: ReactNode;
  userId?: string;
  commentDrafts?: CommentDrafts;
  focusComments?: boolean;
  close: () => void;
  login: () => void;
  onComment: () => void;
  client?: SupabaseClient | null;
  onDetails?: (patch: Partial<Post>) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  position?: number;
  total?: number;
  editorialTitle?: string;
  credit?: { label: string; url?: string };
}

const nativeKeys = 'input, textarea, select, video, audio, [contenteditable]:not([contenteditable="false"]), [role="slider"]';
const swipeControls = `${nativeKeys}, button, a, label, summary, .viewer-panel`;
const newCommentId = () => crypto.randomUUID();
const phoneViewport = "(max-width: 720px), (pointer: coarse) and (max-height: 540px)";

function isolateViewer(viewer: HTMLDialogElement) {
  const changed: HTMLElement[] = [];
  for (let branch: HTMLElement | null = viewer; branch && branch !== document.body; branch = branch.parentElement) {
    for (const sibling of branch.parentElement!.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.inert || sibling.matches("dialog, script, style, link")) continue;
      sibling.inert = true;
      changed.push(sibling);
    }
  }
  return () => { for (const element of changed) element.inert = false; };
}

function Frame({ post, playThrough, onReady, onEnded, onFailure }: {
  post: Post; playThrough: boolean; onReady: () => void; onEnded: () => void; onFailure: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const video = post.media_type === "video";
  const description = post.caption || `${post.sample ? "예시" : post.display_name + "의"} ${video ? "영상" : "사진"}`;
  function fail() {
    setFailed(true);
    onFailure();
  }
  if (failed) return (
    <div className="viewer-media-error">
      <p role="status">{video ? "영상을" : "사진을"} 불러오지 못했어요.</p>
      <button type="button" onClick={() => setFailed(false)}><RotateCw size={16} aria-hidden="true" />다시 시도</button>
    </div>
  );
  if (video) return (
    <video src={post.image_url} poster={post.poster_url || undefined}
      controls playsInline muted autoPlay={playThrough || !window.matchMedia("(prefers-reduced-motion: reduce)").matches}
      preload="metadata" aria-label={description} onEnded={onEnded} onError={fail} />
  );
  if (post.tape) return <TapedPhoto src={post.image_url} alt={description} position={post.tape} fit="contain" onLoad={onReady} onError={fail} />;
  return <img src={post.image_url} alt={description} draggable={false} onLoad={onReady} onError={fail} />;
}

export function PostDialog({
  post, actions, userId, commentDrafts, focusComments = false, close, login, onComment, client = supabase, onDetails,
  onPrevious, onNext, position, total, editorialTitle, credit,
}: ViewerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const commentsBox = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number } | null>(null);
  const [continuous, setContinuous] = useState(false);
  const [loadedPhoto, setLoadedPhoto] = useState("");
  const thread = useComments({ client, userId, postId: post.id, enabled: !post.sample, makeId: newCommentId, drafts: commentDrafts });
  const isVideo = post.media_type === "video";
  const kind = isVideo ? "영상" : "사진";
  const KindIcon = isVideo ? Film : Image;
  const title = post.sample ? editorialTitle || `예시 ${kind}` : `${post.display_name}의 순간`;
  const navigable = !!(onPrevious || onNext || (total && total > 1));
  const hasNext = !!onNext;
  const mediaKey = post.id + "|" + post.image_url;

  useLayoutEffect(() => {
    const el = dialog.current!;
    const opener = document.activeElement;
    const viewport = window.matchMedia(phoneViewport);
    let release: (() => void) | undefined;
    let covering: HTMLDialogElement | null = null;
    function present() {
      const routed = viewport.matches;
      if (el.open && routed === !!release) return;
      // A report, share, or confirmation dialog keeps its place during rotation.
      const top = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].find(other => other !== el);
      if (top) {
        covering?.removeEventListener("close", present);
        covering = top;
        covering.addEventListener("close", present, { once: true });
        return;
      }
      const active = document.activeElement;
      const focusTarget = active instanceof HTMLElement && el.contains(active) ? active : closeButton.current;
      if (el.open) el.close();
      release?.();
      release = undefined;
      el.toggleAttribute("data-routed", routed);
      if (routed) {
        // Browser Back should traverse the post route without a native modal dismiss step.
        el.open = true;
        release = isolateViewer(el);
      } else {
        el.showModal();
      }
      focusTarget?.focus({ preventScroll: true });
    }
    present();
    viewport.addEventListener("change", present);
    el.addEventListener("focusin", present);
    return () => {
      viewport.removeEventListener("change", present);
      el.removeEventListener("focusin", present);
      covering?.removeEventListener("close", present);
      release?.();
      el.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    gesture.current = null;
    layout.current?.scrollTo(0, 0);
  }, [post.id]);

  useLayoutEffect(() => {
    if (!focusComments || !client || !userId || post.sample) return;
    composer.current?.focus({ preventScroll: true });
    composer.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusComments, client, userId, post.id, post.sample]);

  useLayoutEffect(() => {
    // Loading the first page can push the focused field below the phone viewport.
    if (composer.current && document.activeElement === composer.current)
      composer.current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [thread.loading]);

  useEffect(() => {
    const cancel = () => { gesture.current = null; };
    const onVisibility = () => {
      if (document.hidden) {
        cancel();
        setContinuous(false);
        dialog.current?.querySelector("video")?.pause();
      }
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  function advanceIfPlaying() {
    if (continuous && !thread.posting && !document.hidden) onNext?.();
  }
  const advancePhoto = useEffectEvent(advanceIfPlaying);
  useEffect(() => {
    if (!hasNext) {
      setContinuous(false);
      return;
    }
    if (!continuous || isVideo || loadedPhoto !== mediaKey) return;
    const timeout = window.setTimeout(advancePhoto, 6000);
    return () => window.clearTimeout(timeout);
  }, [continuous, hasNext, isVideo, loadedPhoto, mediaKey]);

  function toggleContinuous() {
    if (continuous) return setContinuous(false);
    if (!onNext || thread.posting) return;
    setContinuous(true);
    const video = dialog.current?.querySelector("video");
    if (video?.ended) onNext();
    else if (video?.paused) void video.play().catch(() => setContinuous(false));
  }

  function requestClose() {
    if (!thread.posting) close();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.currentTarget.hasAttribute("data-routed") && !e.defaultPrevented && !e.nativeEvent.isComposing && !document.fullscreenElement) {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key === "Tab") {
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, video[controls], [tabindex]')]
          .filter(control => !control.matches(":disabled, [tabindex='-1']") && control.getClientRects().length > 0);
        const edge = e.shiftKey ? controls[0] : controls.at(-1);
        if (edge && document.activeElement === edge) {
          e.preventDefault();
          (e.shiftKey ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
        }
        return;
      }
    }
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    if (!(e.target instanceof Element) || e.target.closest(nativeKeys)) return;
    const move = e.key === "ArrowLeft" ? onPrevious : e.key === "ArrowRight" ? onNext : undefined;
    if (!move || thread.posting) return;
    e.preventDefault();
    move();
  }

  function startSwipe(e: TouchEvent) {
    gesture.current = null;
    if (!navigable || thread.posting || e.touches.length !== 1) return;
    if (!(e.target instanceof Element) || e.target.closest(swipeControls)) return;
    const touch = e.touches[0];
    gesture.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }

  function trackSwipe(e: TouchEvent) {
    const start = gesture.current;
    if (!start) return;
    const touch = e.touches[0];
    if (e.touches.length !== 1 || touch.identifier !== start.id ||
      (Math.abs(touch.clientY - start.y) > 12 && Math.abs(touch.clientY - start.y) > Math.abs(touch.clientX - start.x))) {
      gesture.current = null;
    }
  }

  function endSwipe(e: TouchEvent) {
    const start = gesture.current;
    gesture.current = null;
    if (!start || thread.posting || e.touches.length !== 0) return;
    const touch = e.changedTouches[0];
    if (!touch || touch.identifier !== start.id) return;
    const end = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!end || end.closest(swipeControls) || !dialog.current?.contains(end)) return;
    const dx = touch.clientX - start.x;
    if (Math.abs(dx) >= 52 && Math.abs(dx) >= 1.6 * Math.abs(touch.clientY - start.y)) {
      (dx < 0 ? onNext : onPrevious)?.();
    }
  }

  return (
    <dialog className="media-viewer" ref={dialog} aria-label={title} aria-modal="true"
      onCancel={e => { e.preventDefault(); requestClose(); }}
      onClick={e => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={onKeyDown}>
      <div className="viewer-shell" onTouchStart={startSwipe} onTouchMove={trackSwipe} onTouchEnd={endSwipe}
        onTouchCancel={() => { gesture.current = null; }}>
        <header className="viewer-toolbar">
          <h2><KindIcon size={19} aria-hidden="true" /><span>{post.sample ? title : kind}</span></h2>
          {navigable && (
            <nav className="viewer-paging" aria-label="게시물 이동">
              <button type="button" aria-label="이전 게시물" aria-keyshortcuts="ArrowLeft" aria-disabled={!onPrevious || thread.posting}
                onClick={() => { if (!thread.posting) onPrevious?.(); }}><ChevronLeft aria-hidden="true" /></button>
              {position != null && total != null && (
                <span className="viewer-position" role="status" aria-atomic="true">
                  <b>{position}</b><span> / </span>{total}
                </span>
              )}
              <button type="button" aria-label="다음 게시물" aria-keyshortcuts="ArrowRight" aria-disabled={!onNext || thread.posting}
                onClick={() => { if (!thread.posting) onNext?.(); }}><ChevronRight aria-hidden="true" /></button>
            </nav>
          )}
          <button type="button" className="viewer-close" ref={closeButton} aria-label="닫기" aria-keyshortcuts="Escape" disabled={thread.posting} onClick={requestClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div ref={layout} className={`viewer-layout${post.sample ? " viewer-layout-sample" : ""}`}>
          <figure className="viewer-stage">
            <div className="viewer-media" onFocusCapture={post.tape && !isVideo ? () => setContinuous(false) : undefined}
              onPointerDownCapture={post.tape && !isVideo ? () => setContinuous(false) : undefined}>
              <Frame key={mediaKey} post={post} playThrough={continuous} onReady={() => setLoadedPhoto(mediaKey)}
              onFailure={() => setContinuous(false)} onEnded={advanceIfPlaying} /></div>
            {(post.sample || navigable) && (
              <figcaption className="viewer-caption">
                {post.sample && <div className="viewer-caption-copy">
                  {post.caption && <p onFocus={() => setContinuous(false)}><TranslatedText text={post.caption} sourceLanguage="ko"
                    englishText={sampleMeta.find(item => item.id === post.id)?.englishCaption}/></p>}
                  {(credit || editorialTitle) && <div className="viewer-credit">
                    {editorialTitle && <small>에디터 픽</small>}
                    {credit && (credit.url ? (
                      <a href={credit.url} target="_blank" rel="noopener noreferrer" onFocus={() => setContinuous(false)}>
                        {credit.label}<ArrowUpRight size={15} aria-hidden="true" />
                      </a>
                    ) : <small>{credit.label}</small>)}
                  </div>}
                </div>}
                <div className="viewer-caption-actions">
                  {navigable && <button type="button" className="viewer-continuous" aria-pressed={continuous}
                    aria-disabled={!hasNext || thread.posting} onClick={toggleContinuous}>
                    {continuous ? <Pause size={17} aria-hidden="true" /> : <ListVideo size={18} aria-hidden="true" />}연속 보기
                  </button>}
                  {post.sample && actions && <div className="viewer-editorial-actions" onPointerDownCapture={() => setContinuous(false)} onFocusCapture={() => setContinuous(false)}>{actions}</div>}
                </div>
              </figcaption>
            )}
          </figure>
          {!post.sample && (
            <section className="viewer-panel" key={post.id} aria-label="게시물 정보와 댓글" onPointerDownCapture={() => setContinuous(false)} onFocusCapture={() => setContinuous(false)}>
              <div className="viewer-author">
                <Avatar name={post.display_name} />
                <div><h3>{post.display_name}</h3><small>@{post.username}</small></div>
              </div>
              {post.caption && <p className="viewer-body"><TranslatedText text={post.caption}/></p>}
              {actions}
              <PhotoPlace post={post} userId={userId} onChange={onDetails} client={client} />
              <h3 className="viewer-comments-title">댓글 <span>{post.comment_count}</span></h3>
              <div className="comments" ref={commentsBox} aria-busy={thread.loading}>
                {thread.loading ? <p className="muted" role="status">댓글을 불러오는 중…</p> : thread.comments.map(c => (
                  <div className="comment" key={c.id}>
                    <Avatar name={c.profiles.display_name} size="small" />
                    <p><b>{c.profiles.display_name}</b><TranslatedText text={c.body}/></p>
                  </div>
                ))}
                {!thread.loading && !thread.comments.length && !thread.loadError && <p className="muted">첫 번째 댓글을 남겨보세요.</p>}
              </div>
              {thread.loadError && <p className="form-error" role="alert">댓글을 불러오지 못했어요.{" "}
                <button className="text-button" type="button" onClick={thread.reload}>다시 시도</button></p>}
              {thread.moreError && <p className="form-error" role="alert">이전 댓글을 불러오지 못했어요. 다시 시도해 주세요.</p>}
              {thread.hasMore && <button type="button" className="outline-button full" disabled={thread.loadingMore} aria-busy={thread.loadingMore}
                onClick={() => void thread.loadMore()}>{thread.loadingMore ? "이전 댓글을 불러오는 중…" : "이전 댓글 더 보기"}</button>}
              {thread.postError && <p className="form-error" role="alert">댓글을 남기지 못했어요. 작성한 내용으로 다시 시도해 주세요.</p>}
              <form className="comment-form" onSubmit={async e => {
                e.preventDefault();
                if (!userId) return login();
                if (await thread.submit()) {
                  onComment();
                  commentsBox.current?.scrollTo({ top: 0 });
                }
              }}>
                <input ref={composer} id="viewer-comment-input" aria-label="댓글" placeholder="댓글 남기기…" maxLength={500} value={thread.body}
                  onChange={e => thread.setBody(e.target.value)} readOnly={thread.posting} />
                <button className="icon-button" aria-label="댓글 게시" disabled={thread.posting || thread.loading || !thread.body.trim()} aria-busy={thread.posting}>
                  <Send size={19} aria-hidden="true" />
                </button>
              </form>
            </section>
          )}
        </div>
      </div>
    </dialog>
  );
}
