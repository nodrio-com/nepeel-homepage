import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Aperture,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Camera,
  Check,
  ChevronRight,
  Compass,
  Flag,
  Heart,
  Home,
  Info,
  LoaderCircle,
  LogOut,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import { sampleMeta, samplePosts } from "./lib/samples";
import { getProfile, setFollowing, setReaction } from "../shared/data";
import { useFeed } from "./useFeed";
import type { FeedMode, Post, Profile } from "../shared/types";
import DeleteAccount from "./components/DeleteAccount";
import PhotoPlace from "./components/PhotoPlace";
import { accountAction } from "../shared/account";
import {
  About,
  AuthDialog,
  CameraDialog,
  EditProfile,
  PostDialog,
  Recovery,
  ReportDialog,
} from "./components/dialogs";

const Connections = lazy(() => import("./components/Connections"));
type View = "feed" | "discover" | "saved" | "profile" | "about" | "hi";
type Modal = "auth" | "camera" | "edit" | "recovery" | "deleteAccount" | null;
const navigation = [
  { id: "feed", label: "홈", icon: Home },
  { id: "discover", label: "탐색", icon: Compass },
  { id: "hi", label: "Hi 연결", icon: Send },
  { id: "saved", label: "저장", icon: Bookmark },
  { id: "profile", label: "프로필", icon: UserRound },
] as const;
const readView = (): View =>
  ["feed", "discover", "saved", "profile", "about", "hi"].includes(
    location.hash.slice(1),
  )
    ? (location.hash.slice(1) as View)
    : "feed";
const sampleTitle = (post: Post) => sampleMeta.find(item => item.id === post.id)?.tag ?? "예시 사진";
export function readableError(error: unknown) {
  const message =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "";
  if (/Invalid login/i.test(message))
    return "이메일 또는 비밀번호를 확인해 주세요.";
  if (/Email not confirmed/i.test(message))
    return "가입 이메일의 인증 링크를 먼저 눌러 주세요.";
  if (/rate limit|too many/i.test(message))
    return "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
  if (/already registered/i.test(message))
    return "이미 가입한 이메일입니다. 로그인해 주세요.";
  if (/password/i.test(message))
    return "비밀번호는 8자 이상으로 입력해 주세요.";
  return "연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
function timeLabel(post: Post) {
  if (post.sample) return "예시 사진";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(post.created_at)) / 60000),
  );
  return minutes < 1
    ? "방금 전"
    : minutes < 60
      ? `${minutes}분 전`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}시간 전`
        : new Date(post.created_at).toLocaleDateString("ko-KR");
}
export function Avatar({
  name,
  size = "",
  index = 0,
}: {
  name: string;
  size?: string;
  index?: number;
}) {
  return (
    <span aria-hidden="true" className={`avatar ${size} tone-${index % 4}`}>
      {name.slice(0, 1)}
    </span>
  );
}
function Brand() {
  return (
    <span className="brand">
      nepeel
      <Aperture aria-hidden="true" />
    </span>
  );
}
export function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "wide" : ""}`}
      aria-label={title}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="닫기" onClick={close}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [view, setView] = useState<View>(readView);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [profileState, setProfile] = useState<Profile | null>(null);
  const [mode, setMode] = useState<"all" | "following">("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [detail, setDetail] = useState<Post | null>(null);
  const [report, setReport] = useState<Post | null>(null);
  const [deleting, setDeleting] = useState<Post | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef(new Set<string>());
  const authUser = useRef<string | null>(null);
  const [postLink, setPostLink] = useState(() =>
    location.hash.startsWith("#post/") ? location.hash.slice(6) : "",
  );
  const preview = !session;
  const userId = session?.user.id;
  const profile = profileState?.id === userId ? profileState : null;
  const notify = (text: string) => setNotice(text);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    const onHash = () => {
      const nextView = readView();
      setView(nextView);
      if (nextView !== "discover") { setSearch(""); setSearchDraft(""); }
      setDetail(null);
      setPostLink(
        location.hash.startsWith("#post/") ? location.hash.slice(6) : "",
      );
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    let authEvent = false;
    supabase.auth.getSession().then(({ data, error: authError }) => {
      if (active && !authEvent) {
        authUser.current = data.session?.user.id ?? null;
        setSession(data.session);
        setAuthReady(true);
        if (authError) setNotice("로그인 상태를 확인할 수 없습니다.");
      }
    }).catch(() => {
      if (active) { setAuthReady(true); setNotice("로그인 상태를 불러오지 못했어요. 다시 로그인해 주세요."); }
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, next) => {
      authEvent = true;
      const changedAccount = !!authUser.current && authUser.current !== next?.user.id;
      authUser.current = next?.user.id ?? null;
      setSession(next);
      setAuthReady(true);
      if (event === "PASSWORD_RECOVERY") setModal("recovery");
      if (!next || changedAccount) {
        setProfile(null);
        setDetail(null);
        setReport(null);
        setDeleting(null);
        if (changedAccount) setModal(null);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!supabase || !userId) {
      setProfile(null);
      return;
    }
    let active = true;
    getProfile(supabase, userId)
      .then((data) => {
        if (active) setProfile(data);
      })
      .catch(() => {
        if (active)
          setNotice("프로필을 불러오지 못했습니다. 연결 설정을 확인해 주세요.");
      });
    return () => {
      active = false;
    };
  }, [userId, refresh]);
  const feedMode: FeedMode =
    view === "saved"
      ? "saved"
      : view === "profile"
        ? "profile"
        : view === "discover"
          ? "all"
          : mode;
  const feed = useFeed({
    client: supabase, userId, enabled: authReady && view !== "hi" && view !== "about",
    scope: view, mode: feedMode, search: view === "discover" ? search : "", postId: postLink, refresh,
  });
  const { setPosts, loading, hasMore, nextPage, loadingMore: loadMore } = feed;
  const reloadFeed = feed.reload;
  useEffect(() => {
    const resume = () => { if (document.visibilityState === "visible") void reloadFeed(4 * 60_000); };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [reloadFeed]);
  const error = feed.error ? "피드를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요." : "";
  const posts = !userId && authReady
    ? view === "saved" || view === "profile" || (mode === "following" && view === "feed")
      ? []
      : samplePosts.filter((post) => view !== "discover" || `${post.caption} ${post.display_name} ${post.username}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    : feed.posts;
  const go = (next: View) => {
    setSearch("");
    setSearchDraft("");
    setDetail(null);
    location.hash = next;
    setView(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const requireMember = (post?: Post) => {
    if (!session || post?.sample) {
      setModal("auth");
      return false;
    }
    return true;
  };
  async function run(key: string, action: () => Promise<void>) {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy([...busyRef.current]);
    try {
      await action();
    } catch (e) {
      notify(readableError(e));
    } finally {
      busyRef.current.delete(key);
      setBusy([...busyRef.current]);
    }
  }
  const patchPost = (id: string, patch: Partial<Post>) => {
    setPosts((old) => old.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setDetail((old) => (old?.id === id ? { ...old, ...patch } : old));
  };
  async function react(post: Post, kind: "likes" | "bookmarks") {
    if (!requireMember(post) || !supabase || !userId) return;
    const enabled = !(kind === "likes" ? post.liked : post.saved);
    await run(`${kind}-${post.id}`, async () => {
      await setReaction(supabase!, kind, userId, post.id, enabled);
      patchPost(
        post.id,
        kind === "likes"
          ? {
              liked: enabled,
              like_count: Math.max(
                0,
                Number(post.like_count) + (enabled ? 1 : -1),
              ),
            }
          : { saved: enabled },
      );
      if (view === "saved" && !enabled && kind === "bookmarks")
        setPosts((old) => old.filter((p) => p.id !== post.id));
    });
  }
  async function follow(post: Post) {
    if (!requireMember(post) || !supabase || !userId) return;
    await run(`follow-${post.user_id}`, async () => {
      await setFollowing(supabase!, userId, post.user_id, !post.following);
      setPosts((old) =>
        old.map((p) =>
          p.user_id === post.user_id ? { ...p, following: !post.following } : p,
        ),
      );
    });
  }
  async function share(post: Post) {
    if (post.sample)
      return notify("샘플 사진입니다. 실제 게시물은 링크로 공유할 수 있어요.");
    const url = `${location.origin}/#post/${post.id}`;
    try {
      if (navigator.share)
        await navigator.share({ title: "nepeel · 있는 그대로의 순간", url });
      else {
        await navigator.clipboard.writeText(url);
        notify("링크를 복사했어요. 로그인한 멤버에게만 사진이 보여요.");
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        notify("링크를 공유하지 못했어요. 다시 시도해 주세요.");
    }
  }
  function searchSubmit(e: FormEvent) {
    e.preventDefault();
    setSearch(searchDraft.trim());
    location.hash = "discover";
    setView("discover");
  }
  const reset = () => {
    setSearch("");
    setSearchDraft("");
    setMode("all");
    location.hash = "feed";
    setRefresh((v) => v + 1);
  };
  const actions = (post: Post) => post.sample ? null : (
    <div className="post-actions">
      <button
        className={`icon-button ${post.liked ? "liked" : ""}`}
        aria-label={post.liked ? "좋아요 취소" : "좋아요"}
        aria-pressed={post.liked}
        disabled={busy.includes(`likes-${post.id}`)}
        onClick={() => void react(post, "likes")}
      >
        <Heart fill={post.liked ? "currentColor" : "none"} />
      </button>
      <button
        className="icon-button"
        aria-label="댓글 보기"
        onClick={() => setDetail(post)}
      >
        <MessageCircle />
      </button>
      <button
        className="icon-button"
        aria-label="게시물 공유"
        onClick={() => void share(post)}
      >
        <Send />
      </button>
      <span className="action-spacer" />
      <span className="capture-label">
        <ShieldCheck size={13} /> 앱 촬영
      </span>
      <button
        className={`icon-button ${post.saved ? "saved" : ""}`}
        aria-label={post.saved ? "저장 취소" : "사진 저장"}
        aria-pressed={post.saved}
        disabled={busy.includes(`bookmarks-${post.id}`)}
        onClick={() => void react(post, "bookmarks")}
      >
        <Bookmark fill={post.saved ? "currentColor" : "none"} />
      </button>
    </div>
  );
  return (
    <>
      <a className="skip-link" href="#main" onClick={(event) => {
        event.preventDefault();
        document.getElementById("main")?.focus();
      }}>
        본문으로 건너뛰기
      </a>
      <div className="site-frame">
      <aside className="sidebar">
        <a
          className="brand-link"
          href="#feed"
          onClick={() => go("feed")}
          aria-label="nepeel 홈"
        >
          <Brand />
        </a>
        <nav aria-label="메인 메뉴">
          {navigation.map((item) => (
            <a
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(item.id);
              }}
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
            >
              <item.icon strokeWidth={view === item.id ? 2.5 : 1.7} />
              <span>{item.label}</span>
              {view === item.id && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <button className="capture-button" onClick={() => setModal("camera")}>
          <Camera size={21} />
          <span>앱에서 촬영</span>
          <ArrowUpRight size={17} />
        </button>
        <div className="sidebar-bottom">
          {session ? (
            <button className="account-button" onClick={() => go("profile")}>
              <Avatar name={profile?.display_name ?? "나"} />
              <span>
                <b>{profile?.display_name ?? "내 계정"}</b>
                <small>나의 기록</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ) : (
            <button className="account-button" onClick={() => setModal("auth")}>
              <span className="avatar neutral">
                <UserRound size={20} />
              </span>
              <span>
                <b>로그인</b>
                <small>또는 회원가입</small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          )}
          <div className="sidebar-foot">
            <span>© 2026 nepeel</span>
            <button onClick={() => go("about")}>서비스 소개</button>
          </div>
        </div>
      </aside>
      <div className="app-shell">
        <header className={`utility-bar ${view === "discover" ? "show-search" : ""}`}>
          <div className="mobile-brand">
            <a href="#feed" onClick={() => go("feed")} aria-label="nepeel 홈">
              <Brand />
            </a>
          </div>
          <div className="utility-actions">
            <form className="header-search" role="search" onSubmit={searchSubmit}>
              <Search aria-hidden="true" size={18} />
              <input type="search" aria-label="사진과 사람 검색" placeholder="사진과 사람 검색"
                value={searchDraft} maxLength={80} onChange={e => setSearchDraft(e.target.value)} />
              <button type="submit" aria-label="검색"><ArrowRight size={18} /></button>
            </form>
            <button
              className="utility-action utility-account"
              aria-label={session ? "내 프로필" : "로그인"}
              aria-haspopup={session ? undefined : "dialog"}
              onClick={() => (session ? go("profile") : setModal("auth"))}
            >
              {session ? (
                <Avatar name={profile?.display_name ?? "나"} size="small" />
              ) : (
                <UserRound aria-hidden="true" />
              )}
              <span>{session ? "내 프로필" : "로그인"}</span>
            </button>
          </div>
        </header>
        <div className={`page-layout ${view === "feed" && !postLink ? "" : "single-column"}`}>
          <main id="main" tabIndex={-1}>
            {view === "about" ? (
              <About onCamera={() => setModal("camera")} />
            ) : view === "hi" ? (
              <Suspense
                fallback={
                  <p className="hi-empty" role="status">
                    Hi를 준비하고 있어요…
                  </p>
                }
              >
                <Connections
                  key={userId ?? "guest"}
                  userId={userId}
                  login={() => setModal("auth")}
                />
              </Suspense>
            ) : (
              <>
                {view === "feed" && !postLink && <h1 className="home-title">홈 피드</h1>}
                {view === "discover" && (
                  <div className="page-heading"><h1>탐색</h1>{preview && <span className="preview-label">예시 사진</span>}</div>
                )}
                {view === "saved" && (
                  <div className="page-heading"><h1>저장한 순간</h1><Bookmark className="heading-icon" /></div>
                )}
                {view === "profile" && (
                  <section className="profile-panel">
                    <Avatar name={profile?.display_name ?? "나"} size="large" />
                    <div>
                      
                      <h1>
                        {profile?.display_name ?? "내 프로필"}
                      </h1>
                      {profile?.bio && <p>{profile.bio}</p>}
                      {session && <small>@{profile?.username}</small>}
                    </div>
                    {session && (
                      <div className="profile-controls">
                        <button
                          className="outline-button"
                          onClick={() => go("saved")}
                        >
                          <Bookmark size={16} /> 저장한 순간
                        </button>
                        <button
                          className="outline-button"
                          onClick={() => setModal("edit")}
                        >
                          프로필 수정
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void run("signout", async () => {
                              const { error: e } =
                                await supabase!.auth.signOut();
                              if (e) throw e;
                              go("feed");
                            })
                          }
                        >
                          <LogOut size={15} /> 로그아웃
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setModal("deleteAccount")}
                        >
                          회원 탈퇴
                        </button>
                      </div>
                    )}
                  </section>
                )}
                {postLink && (
                  <button className="back-link" onClick={reset}>
                    <ArrowLeft size={16} /> 전체 피드로
                  </button>
                )}
                <div className="feed-toolbar">
                  <div className="feed-tabs">
                    {view === "feed" && !postLink ? (
                      <>
                        <button
                          aria-pressed={mode === "all"}
                          className={mode === "all" ? "selected" : ""}
                          onClick={() => setMode("all")}
                        >
                          전체
                        </button>
                        <button
                          aria-pressed={mode === "following"}
                          className={mode === "following" ? "selected" : ""}
                          onClick={() => setMode("following")}
                        >
                          팔로잉
                        </button>
                      </>
                    ) : (
                      <h2>
                        {view === "profile"
                          ? "내가 남긴 순간"
                          : postLink
                            ? "공유된 순간"
                            : search ? `“${search}” 검색 결과` : "모든 순간"}
                      </h2>
                    )}
                    {view === "discover" && search && <button className="icon-button" aria-label="검색 지우기" onClick={() => { setSearch(""); setSearchDraft(""); }}><X size={18} /></button>}
                  </div>
                  <button
                    className="sort-label"
                    onClick={() => void reloadFeed()}
                    aria-label="최신순 피드 새로고침"
                    disabled={feed.refreshing || loading}
                  >
                    <RefreshCw size={16} className={feed.refreshing ? "spin" : ""} /> 새로고침
                  </button>
                </div>
                {feed.refreshing && <p className="loading-state" role="status"><LoaderCircle className="spin" /> 최신 순간을 불러오는 중</p>}
                {feed.refreshError && <div className="form-error" role="alert">
                  새 사진을 불러오지 못했어요. 기존 사진은 그대로 볼 수 있어요.
                  <button className="text-button" onClick={() => void reloadFeed()}>다시 시도</button>
                </div>}
                {loading || !authReady ? (
                  <div className="loading-state" role="status">
                    <LoaderCircle className="spin" /> 순간들을 불러오는 중
                  </div>
                ) : error ? (
                  <div className="empty-state">
                    <RefreshCw />
                    <h3>잠시 연결이 끊겼어요.</h3>
                    <p>{error}</p>
                    <button
                      className="dark-button"
                      onClick={() => void reloadFeed()}
                    >
                      다시 시도
                    </button>
                  </div>
                ) : !posts.length || (postLink && preview) ? (
                  <div className="empty-state">
                    {search ? <Search /> : postLink ? <Info /> : <Camera />}
                    <h3>{search ? "검색 결과가 없어요" : postLink ? (preview ? "로그인하고 사진 보기" : "사진을 볼 수 없어요") : preview ? "로그인하고 이어보기" : mode === "following" ? "아직 팔로우한 사진이 없어요" : view === "saved" ? "아직 저장한 사진이 없어요" : "아직 사진이 없어요"}</h3>
                    {postLink && !preview && <p>삭제되었거나 공개 범위가 바뀐 사진이에요.</p>}
                    <button className="dark-button" onClick={() => {
                      if (search) { setSearch(""); setSearchDraft(""); }
                      else if (preview) setModal("auth");
                      else if (postLink || mode === "following" || view === "saved") reset();
                      else setModal("camera");
                    }}>
                      {search ? "검색 지우기" : preview ? "로그인" : postLink || mode === "following" || view === "saved" ? "모든 순간 보기" : "앱에서 촬영"}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                ) : (
                  <div
                    className={
                      view === "discover" ? "explore-grid" : "feed-list"
                    }
                  >
                    {posts.map((post, i) =>
                      view === "discover" ? (
                        <button
                          className="explore-item"
                          key={post.id}
                          onClick={() => setDetail(post)}
                        >
                          <img
                            src={post.image_url}
                            alt={post.caption || `${post.display_name}의 사진`}
                            loading="lazy"
                          />
                          <span className="explore-info">
                            <b>{post.sample ? sampleTitle(post) : post.display_name}</b>
                          </span>
                        </button>
                      ) : (
                        <article className="post" key={post.id}>
                          <header className="post-header">
                            {post.sample ? <span className="sample-avatar"><Aperture size={21} aria-hidden="true" /></span> : <Avatar name={post.display_name} index={i} />}
                            <div className="post-person">
                              <b>
                                {post.sample ? sampleTitle(post) : post.display_name}
                                {!post.sample && <span>
                                  @
                                  {post.username.length > 18
                                    ? post.username.slice(0, 12) + "…"
                                    : post.username}
                                </span>}
                              </b>
                              <small>
                                {timeLabel(post)}
                              </small>
                            </div>
                            {!post.sample && post.user_id !== userId && (
                              <button
                                className={`follow-button ${post.following ? "is-following" : ""}`}
                                onClick={() => void follow(post)}
                                disabled={busy.includes(
                                  `follow-${post.user_id}`,
                                )}
                              >
                                {post.following ? (
                                  <>
                                    <Check size={13} /> 팔로잉
                                  </>
                                ) : (
                                  "팔로우"
                                )}
                              </button>
                            )}
                            {!post.sample && (
                              <button
                                className="icon-button compact"
                                aria-label={
                                  post.user_id === userId
                                    ? "게시물 삭제"
                                    : "게시물 신고"
                                }
                                onClick={() =>
                                  post.user_id === userId
                                    ? setDeleting(post)
                                    : setReport(post)
                                }
                              >
                                {post.user_id === userId ? (
                                  <Trash2 size={17} />
                                ) : (
                                  <Flag size={17} />
                                )}
                              </button>
                            )}
                          </header>
                          <button
                            className={`post-photo ${post.sample ? post.id : ""}`}
                            onClick={() => setDetail(post)}
                            aria-label={`${post.sample ? sampleTitle(post) : post.display_name} 사진 크게 보기`}
                          >
                            <img
                              src={post.image_url}
                              alt={
                                post.caption || `${post.display_name}의 사진`
                              }
                              loading={i === 0 ? "eager" : "lazy"}
                            />
                          </button>
                          {actions(post)}
                          <div className="post-copy">
                            {!post.sample && Number(post.like_count) > 0 && (
                              <strong className="like-count">
                                좋아요{" "}
                                {Number(post.like_count).toLocaleString()}개
                              </strong>
                            )}
                            <p>
                              {!post.sample && <b>{post.display_name} </b>}{post.caption}
                            </p>
                            <PhotoPlace post={post} userId={userId} onChange={patch=>patchPost(post.id,patch)}/>
                            {!post.sample && <button
                              className="comment-link"
                              onClick={() => setDetail(post)}
                            >
                              {post.comment_count
                                ? `댓글 ${post.comment_count}개 보기`
                                : "댓글 쓰기"}
                              <ArrowUpRight size={13} />
                            </button>}
                          </div>
                        </article>
                      ),
                    )}
                  </div>
                )}
                {feed.moreError && (
                  <p className="form-error" role="alert">
                    다음 사진을 불러오지 못했어요. 다시 눌러 시도해 주세요.
                  </p>
                )}
                {hasMore && (
                  <button
                    className="load-more outline-button"
                    onClick={() => void nextPage()}
                    disabled={loadMore}
                    aria-busy={loadMore}
                  >
                    {loadMore ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <ArrowDown size={16} />
                    )}{" "}
                    더 많은 순간 보기
                  </button>
                )}
              </>
            )}
          </main>
          {view === "feed" && !postLink && <aside className="right-rail">
            <section className="rail-discover">
              <div className="section-line"><h2>다른 순간들</h2><button onClick={() => go("discover")}>전체 보기 <ArrowRight size={14} /></button></div>
              {(preview ? samplePosts : posts).slice(1, 4).map(post => (
                <button className="rail-moment" key={post.id} onClick={() => setDetail(post)}>
                  <img src={post.image_url} alt="" loading="lazy" />
                  <span><b>{post.sample ? sampleMeta.find(item => item.id === post.id)?.tag : post.display_name}</b><small>{post.sample ? "미리보기" : post.caption || "앱 촬영"}</small></span>
                  <ArrowUpRight size={16} />
                </button>
              ))}
              {!preview && posts.length < 2 && <button className="text-button" onClick={() => go("discover")}>사진 둘러보기 <ArrowRight size={16} /></button>}
            </section>
            <div className="rail-footer">
              <button onClick={() => go("about")}>서비스 소개 · 커뮤니티 원칙</button>
              {preview && <a href="https://unsplash.com" target="_blank" rel="noreferrer">예시 사진 · Unsplash</a>}
              <p>© 2026 nepeel</p>
            </div>
          </aside>}
        </div>
      </div>
      </div>
      <nav className="mobile-nav" aria-label="모바일 메뉴">
        {navigation.slice(0, 2).map((item) => (
          <button
            key={item.id}
            aria-label={item.label}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => go(item.id)}
          >
            <item.icon />
            <span>{item.label}</span>
          </button>
        ))}
        <button
          className="mobile-capture"
          aria-label="앱에서 촬영"
          onClick={() => setModal("camera")}
        >
          <Camera aria-hidden="true" /><span>촬영</span>
        </button>
        {navigation
          .slice(2)
          .filter((item) => item.id !== "saved")
          .map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => go(item.id)}
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          ))}
      </nav>
      <footer className="mobile-footer"><button onClick={() => go("about")}>서비스 소개</button></footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
          <button aria-label="알림 닫기" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === "auth" && (
        <AuthDialog
          close={() => setModal(null)}
          onDone={() => {
            setModal(null);
            notify("반가워요. 당신의 순간을 기다렸어요.");
          }}
        />
      )}
      {modal === "camera" && <CameraDialog close={() => setModal(null)} />}
      {modal === "edit" && profile && (
        <EditProfile
          profile={profile}
          close={() => setModal(null)}
          saved={() => {
            setModal(null);
            setRefresh((v) => v + 1);
            notify("프로필을 저장했어요.");
          }}
        />
      )}
      {modal === "recovery" && <Recovery close={() => setModal(null)} />}
      {detail?.sample && (
        <Dialog title="예시 사진" close={() => setDetail(null)} wide>
          <figure className="sample-detail">
            <img src={detail.image_url} alt={detail.caption} />
            <figcaption>{detail.caption}</figcaption>
          </figure>
        </Dialog>
      )}
      {detail && !detail.sample && (
        <PostDialog
          post={detail}
          actions={actions(detail)}
          userId={userId}
          close={() => setDetail(null)}
          onDetails={patch=>patchPost(detail.id,patch)}
          login={() => {
            setDetail(null);
            setModal("auth");
          }}
          onComment={() =>
            patchPost(detail.id, {
              comment_count: Number(detail.comment_count) + 1,
            })
          }
        />
      )}
      {modal === "deleteAccount" && session && (
        <DeleteAccount
          key={userId}
          userId={userId!}
          close={() => setModal(null)}
          done={() => {
            setModal(null);
            go("feed");
            setNotice("계정이 삭제되었습니다.");
          }}
        />
      )}
      {report && (
        <ReportDialog
          post={report}
          userId={userId!}
          close={() => setReport(null)}
          done={() => {
            setReport(null);
            notify("신고를 접수했어요. 운영자가 확인하겠습니다.");
          }}
        />
      )}
      {deleting && (
        <Dialog title="이 순간을 삭제할까요?" close={() => setDeleting(null)}>
          <p className="muted">
            사진과 좋아요, 댓글이 삭제됩니다. 이 작업은 되돌릴 수 없어요.
          </p>
          <button
            className="dark-button full"
            disabled={busy.includes("delete")}
            onClick={() =>
              void run("delete", async () => {
                await accountAction(supabase!, "", { action: "delete", postId: deleting.id }, userId!);
                setPosts((old) => old.filter((p) => p.id !== deleting.id));
                setDeleting(null);
                notify("사진을 삭제했어요.");
              })
            }
          >
            삭제하기
          </button>
        </Dialog>
      )}
    </>
  );
}
