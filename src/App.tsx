import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  Aperture, ArrowDown, ArrowLeft, Bookmark, Camera, Check, Compass, Flag, Grid2X2, Grid3X3,
  Heart, Home, Layers, LoaderCircle, MessageCircle, Search, Send, Settings, Trash2, UserRound, X,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import { sampleMeta, samplePosts } from "./lib/samples";
import { getProfile, setFollowing, setReaction } from "../shared/data";
import { useFeed } from "./useFeed";
import type { FeedMode, Post, Profile } from "../shared/types";
import DeleteAccount from "./components/DeleteAccount";
import { useEditorialSaves } from "./lib/editorial-saves";
import { MediaGrid } from "./components/MediaGrid";
import { readBrowseRoute, browseHash, type BrowseRoute, type MediaFilter, type View } from "./lib/browse-route";
import { PostShareDialog, OwnerShareActions } from "./components/PostShareDialog";
import { deliverMediaLink } from "./lib/share-link";
import { useAppCamera } from "./lib/app-camera";
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
const MediaStacks = lazy(() => import("./components/MediaStacks"));

type Modal = "auth" | "camera" | "edit" | "recovery" | "deleteAccount" | null;
const navigation = [
  { id: "feed", label: "홈", icon: Home },
  { id: "discover", label: "탐색", icon: Compass },
  { id: "stacks", label: "묶음", icon: Layers },
  { id: "hi", label: "Hi 연결", icon: Send },
  { id: "profile", label: "프로필", icon: UserRound },
] as const;
const labels: Record<View, string> = {
  feed: "홈", discover: "탐색", saved: "저장", profile: "프로필",
  about: "서비스 소개", hi: "Hi 연결", stacks: "묶음",
};
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
  useLayoutEffect(() => {
    const el = ref.current!;
    const opener = document.activeElement;
    el.showModal();
    return () => {
      el.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
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
  const [hash, setHash] = useState(() => location.hash);
  const route = readBrowseRoute(hash);
  const { view, filter, search, postId: postLink } = route;
  const [dense, setDense] = useState(() => {
    try { return localStorage.getItem("nepeel.grid.dense") === "1"; } catch { return false; }
  });
  function changeDensity(value: boolean) {
    setDense(value);
    try { localStorage.setItem("nepeel.grid.dense", value ? "1" : "0"); } catch { /* Storage can be unavailable in private browsing. */ }
  }
  function navigate(next: BrowseRoute, options: { replace?: boolean; viewer?: boolean } = {}) {
    const to = browseHash(next);
    if (to === location.hash) return;
    const state = options.viewer ? { nepeelViewer: true } : null;
    if (options.replace) history.replaceState(state, "", to);
    else history.pushState(state, "", to);
    setHash(to);
  }
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [profileState, setProfile] = useState<Profile | null>(null);
  const [searchDraft, setSearchDraft] = useState(search);
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [report, setReport] = useState<Post | null>(null);
  const [deleting, setDeleting] = useState<Post | null>(null);
  const [createAfterLogin, setCreateAfterLogin] = useState(false);
  const { openCamera, needsHelp: cameraHelp } = useAppCamera(() => setModal("camera"), view);
  const searchTimer = useRef<number | undefined>(undefined);
  const composingSearch = useRef(false);
  useEffect(() => () => window.clearTimeout(searchTimer.current), [hash]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef(new Set<string>());
  const authUser = useRef<string | null>(null);
  const preview = !session;
  const userId = session?.user.id;
  const editorialSaves = useEditorialSaves(userId);
  const [manualLink, setManualLink] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => { setCopied(""); setManualLink(""); }, [route.open, userId]);
  const profile = profileState?.id === userId ? profileState : null;
  const notify = (text: string) => setNotice(text);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  useEffect(() => {
    const sync = () => setHash(location.hash);
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  useEffect(() => {
    setSearchDraft(previous => view === "discover" && previous.trim() === search ? previous : search);
  }, [view, search]);
  useEffect(() => { document.title = labels[view] + " · nepeel"; }, [view]);
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
        setReport(null);
        setDeleting(null);
        setManualLink("");
        if (changedAccount) setCreateAfterLogin(false);
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
          : filter === "following" ? "following" : "all";
  const feed = useFeed({
    client: supabase, userId, enabled: authReady && view !== "hi" && view !== "about" && view !== "stacks",
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
  const canBrowse = view === "feed" || view === "discover";
  const editorial = canBrowse && !postLink && filter !== "following" && authReady
    ? samplePosts.filter(p => {
        const item = sampleMeta.find(s => s.id === p.id);
        return !search || [p.caption, p.display_name, item?.tag, item?.category, item?.creator].join(" ").toLocaleLowerCase().includes(search.toLocaleLowerCase());
      }) : [];
  const memberPosts = userId ? feed.posts : [];
  const typeMatches = (p: Post) => (filter !== "photo" && filter !== "video") || (p.media_type ?? "photo") === filter;
  const savedEditorial = view === "saved" ? editorialSaves.ids.flatMap(id => samplePosts.filter(p => p.id === id)) : [];
  const posts = [...memberPosts, ...savedEditorial, ...editorial].filter(typeMatches);
  const detailIndex = route.open ? posts.findIndex(p => p.id === route.open) : -1;
  const lookup = !!route.open && detailIndex < 0 && hasMore && !loading && !!userId &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(route.open);
  const directPost = useFeed({
    client: supabase, userId, enabled: lookup, scope: view, mode: feedMode,
    search, postId: route.open,
  });
  const detail = posts[detailIndex] ?? (lookup ? directPost.posts.find(p => p.id === route.open && typeMatches(p)) : null);
  const detailMeta = detail?.sample ? sampleMeta.find(s => s.id === detail.id) : undefined;
  const showFeed = view !== "stacks" && view !== "about" && view !== "hi";
  useEffect(() => {
    if (detailIndex >= 0 && !detail?.sample && detailIndex >= memberPosts.filter(typeMatches).length - 3 && hasMore && !loadMore && !feed.moreError)
      void nextPage();
  }, [detailIndex, detail?.sample, memberPosts.length, filter, hasMore, loadMore, feed.moreError, nextPage]);
  function go(next: View) {
    navigate({ view: next, search: "", filter: "all", open: "", postId: "" });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function navClick(event: MouseEvent<HTMLAnchorElement>, next: View) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(next);
    if (event.currentTarget.classList.contains("mobile-search-link"))
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".discover-field input")?.focus({ preventScroll: true }));
  }
  function openPost(post: Post) {
    navigate({ ...route, open: post.id }, { replace: !!route.open, viewer: !route.open || history.state?.nepeelViewer === true });
  }
  function closePost() {
    if (history.state?.nepeelViewer) history.back();
    else navigate({ ...route, open: "" }, { replace: true });
  }
  function setFilter(next: MediaFilter) {
    navigate({ ...route, filter: next, open: "" });
  }
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
    if (lookup) directPost.setPosts(old => old.map(p => p.id === id ? { ...p, ...patch } : p));
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
      if (view === "saved" && !enabled && kind === "bookmarks") {
        closePost();
        setPosts((old) => old.filter((p) => p.id !== post.id));
      }
    });
  }
  async function follow(post: Post) {
    if (!requireMember(post) || !supabase || !userId) return;
    await run(`follow-${post.user_id}`, async () => {
      await setFollowing(supabase!, userId, post.user_id, !post.following);
      if (lookup) directPost.setPosts(old => old.map(p => ({ ...p, following: !post.following })));
      setPosts((old) =>
        old.map((p) =>
          p.user_id === post.user_id ? { ...p, following: !post.following } : p,
        ),
      );
    });
  }
  function changeSearch(value: string) {
    setSearchDraft(value);
    window.clearTimeout(searchTimer.current);
    if (view !== "discover" || composingSearch.current) return;
    const at = location.hash;
    searchTimer.current = window.setTimeout(() => {
      if (location.hash === at)
        navigate({ ...route, search: value.trim(), open: "" }, { replace: true });
    }, 300);
  }
  function searchSubmit(e: FormEvent) {
    e.preventDefault();
    if (composingSearch.current) return;
    window.clearTimeout(searchTimer.current);
    navigate({ view: "discover", filter: view === "discover" ? filter : "all", search: searchDraft.trim(), open: "", postId: "" });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  async function shareEditorial(post: Post) {
    const url = new URL(browseHash({ view: "feed", filter: "all", search: "", open: post.id, postId: "" }), location.origin + "/").href;
    const at = location.hash;
    const result = await deliverMediaLink(url, post.caption);
    if (location.hash !== at) return;
    if (result === "copied") setCopied(post.id);
    if (result === "manual") setManualLink(url);
  }
  const actions = (post: Post) => post.sample ? <div className="editorial-actions">
    <button type="button" aria-pressed={editorialSaves.ids.includes(post.id)}
      onClick={() => {
        if (view === "saved" && editorialSaves.ids.includes(post.id)) closePost();
        editorialSaves.toggle(post.id);
      }}><Bookmark size={17} fill={editorialSaves.ids.includes(post.id) ? "currentColor" : "none"}/>
      {editorialSaves.ids.includes(post.id) ? "저장됨" : "이 기기에 저장"}</button>
    <button type="button" onClick={() => void shareEditorial(post)}><Send size={17}/>{copied === post.id ? "링크 복사됨" : "공유"}</button>
  </div> : (
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
        onClick={() => document.getElementById("viewer-comment-input")?.focus()}
      >
        <MessageCircle />
      </button>
      {post.user_id === userId && <OwnerShareActions key={userId + ":" + post.id} postId={post.id} manual={setManualLink} />}
      {post.user_id !== userId && <button className="text-button" disabled={busy.includes("follow-" + post.user_id)}
        aria-pressed={post.following} onClick={() => void follow(post)}>{post.following ? "팔로잉" : "팔로우"}</button>}
      <button className="icon-button" aria-label={post.user_id === userId ? "게시물 삭제" : "게시물 신고"}
        onClick={() => post.user_id === userId ? setDeleting(post) : setReport(post)}>
        {post.user_id === userId ? <Trash2 size={16}/> : <Flag size={16}/>}
      </button>
      <span className="action-spacer" />
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
      <header className="browse-header">
        <div className="browse-header-inner">
          <a className="browse-brand" href="#feed" onClick={e => navClick(e,"feed")} aria-label="nepeel 홈"><Brand /></a>
          <nav className="browse-nav" aria-label="메인 메뉴">
            {navigation.filter(item => item.id !== "profile").map(item => (
              <a key={item.id} href={"#" + item.id} onClick={e => navClick(e,item.id)} aria-current={view === item.id ? "page" : undefined}>{item.label}</a>
            ))}
          </nav>
          <div className="browse-tools">
            {view !== "discover" && <form className="browse-search" role="search" onSubmit={searchSubmit}>
              <button aria-label="검색" type="submit"><Search size={19} /></button>
              <input type="search" aria-label="사진, 영상, 사람 검색" placeholder="사진, 영상, 사람 검색" maxLength={80}
                value={searchDraft} onChange={e => changeSearch(e.target.value)} />
            </form>}
            <a className="mobile-search-link" href="#discover" onClick={e => navClick(e,"discover")} aria-label="검색 열기"><Search size={21} /></a>
            <a className="saved-shortcut" href="#saved" onClick={e => navClick(e,"saved")} aria-label="저장한 게시물" aria-current={view === "saved" ? "page" : undefined}><Bookmark size={19} fill={view === "saved" ? "currentColor" : "none"} /></a>
            <button className="browse-camera" onClick={openCamera}><Camera size={18} /><span>앱에서 촬영</span></button>
            <button className="browse-account" onClick={() => session ? go("profile") : setModal("auth")} aria-label={session ? "내 프로필" : "로그인"}>
              {session ? <Avatar size="small" name={profile?.display_name ?? "나"}/> : <><UserRound size={19} /><span>로그인</span></>}
            </button>
          </div>
        </div>
      </header>
      {cameraHelp && <div className="camera-launch-help"><button type="button" className="text-button"
        onClick={() => setModal("camera")}>앱이 열리지 않나요?</button></div>}
      <main id="main" tabIndex={-1} className={"browse-main view-" + view}>
        {view !== "profile" && view !== "about" && view !== "hi" && <h1 className="visually-hidden">{labels[view]}</h1>}
        {view === "about" && <About onCamera={openCamera} />}
        {view === "hi" && <Suspense fallback={<p className="loading-state" role="status">연결 불러오는 중…</p>}>
          <Connections key={userId ?? "guest"} userId={userId} login={() => setModal("auth")} />
        </Suspense>}
        {(view === "profile" || view === "saved") && <>
          {view === "profile" && <section className="browse-profile">
            <Avatar name={profile?.display_name ?? "나"} />
            <div><h1>{profile?.display_name ?? "내 프로필"}</h1>
              {profile && <small>@{profile.username}</small>}{profile?.bio && <p>{profile.bio}</p>}</div>
            {session && <details className="account-menu"><summary aria-label="계정 설정"><Settings size={20}/></summary>
              <div><button onClick={() => setModal("edit")}>프로필 수정</button>
              <button onClick={() => void run("signout", async () => {
                const { error } = await supabase!.auth.signOut();
                if (error) throw error; go("feed");
              })}>로그아웃</button>
              <button onClick={() => setModal("deleteAccount")}>회원 탈퇴</button></div>
            </details>}
          </section>}
          <nav className="library-tabs" aria-label="내 보관함">
            <a href="#profile" aria-current={view === "profile" ? "page" : undefined}>내 게시물</a>
            <a href="#stacks">묶음</a><a href="#saved" aria-current={view === "saved" ? "page" : undefined}>저장</a>
          </nav>
        </>}
        {view === "stacks" && (authReady ? <Suspense fallback={<p className="loading-state" role="status">묶음 불러오는 중…</p>}>
          <MediaStacks key={userId ?? "guest"} userId={userId}
            login={() => { setCreateAfterLogin(true); setModal("auth"); }} startCreating={createAfterLogin}
            onCreateIntentHandled={() => setCreateAfterLogin(false)} onCamera={openCamera} />
        </Suspense> : <p role="status" className="loading-state">묶음 불러오는 중…</p>)}
        {showFeed && <>
          {postLink && <button className="back-link" onClick={() => go("feed")}><ArrowLeft size={16}/> 피드로</button>}
          {view === "discover" && <form className="discover-field" role="search" onSubmit={searchSubmit}>
            <Search size={20} aria-hidden="true"/><input type="search" aria-label="탐색 검색어" placeholder="사진, 영상, 사람 검색"
              value={searchDraft} onChange={e=>changeSearch(e.target.value)} maxLength={80}
              onCompositionStart={() => { composingSearch.current = true; window.clearTimeout(searchTimer.current); }}
              onCompositionEnd={e => { composingSearch.current = false; changeSearch(e.currentTarget.value); }}/>
            <button type="submit">검색</button>
          </form>}
          {!postLink && <div className="browse-filters">
            <div className="filter-strip" aria-label="콘텐츠 필터">
              {([["all", "전체"], ["photo","사진"], ["video","동영상"], ...(view === "feed" ? [["following","팔로잉"]] : [])] as const).map(([key,label]) =>
                <button type="button" key={key} aria-pressed={filter === key} onClick={() => setFilter(key as MediaFilter)}>{label}</button>)}
            </div>
            <div className="density-group" aria-label="그리드 간격">
              <button type="button" aria-label="기본 그리드" aria-pressed={!dense} onClick={() => changeDensity(false)}><Grid2X2 size={18}/></button>
              <button type="button" aria-label="촘촘한 그리드" aria-pressed={dense} onClick={() => changeDensity(true)}><Grid3X3 size={18}/></button>
            </div>
          </div>}
          {search && <div className="search-summary"><span>‘{search}’ 검색 결과</span><button aria-label="검색 지우기" onClick={() => go("discover")}><X size={16}/></button></div>}
          {feed.refreshError && <p className="form-error" role="alert">업데이트할 수 없습니다. <button onClick={() => void reloadFeed()}>다시 시도</button></p>}
          {loading || !authReady ? <p className="loading-state" role="status"><LoaderCircle className="spin"/> 불러오는 중…</p>
          : error ? <div className="browse-empty" role="alert"><p>{error}</p><button className="outline-button" onClick={() => void reloadFeed()}>다시 시도</button></div>
          : posts.length && !(postLink && preview) ? <MediaGrid posts={posts} dense={dense} onOpen={openPost}/>
          : <div className="browse-empty">
            <p>{search ? "검색 결과가 없어요." : postLink ? (preview ? "이 게시물은 회원에게만 공개돼요." : "게시물을 볼 수 없어요.") :
              preview && (view === "profile" || filter === "following") ? "로그인하면 " + (filter === "following" ? "팔로잉 피드" : "내 게시물") + "을 볼 수 있어요." :
              filter === "following" ? "팔로우한 사람의 게시물이 아직 없어요." : filter === "video" ? "표시할 동영상이 없어요." :
              view === "saved" ? "저장한 게시물이 없어요." : "표시할 게시물이 없어요."}</p>
            {preview && !search && (postLink || view === "profile" || filter === "following") ?
            <button className="dark-button" onClick={() => setModal("auth")}>로그인</button> :
            <button className="outline-button" onClick={() => go(search ? "discover" : "feed")}>{search ? "검색 지우기" : "전체 둘러보기"}</button>}
          </div>}
          {route.open && !detail && !loading && authReady && !(lookup && directPost.loading) && <div className="browse-empty" role="status">
            <p>이 게시물을 열 수 없어요.</p><button className="outline-button" onClick={closePost}>목록으로</button>
          </div>}
          {feed.moreError && <p className="form-error" role="alert">다음 게시물을 불러오지 못했어요.</p>}
          {hasMore && <button className="load-more outline-button" onClick={() => void nextPage()} disabled={loadMore}>
            {loadMore ? <LoaderCircle className="spin" size={16}/> : <ArrowDown size={16}/>} 더 보기</button>}
        </>}
      </main>
      <footer className="browse-footer"><a href="#about">서비스 소개</a><a href="/photo-credits.txt">미디어 출처</a></footer>
      <nav className="browse-bottom" aria-label="모바일 메뉴">
        {navigation.map(item => <a key={item.id} href={"#" + item.id} onClick={e => navClick(e,item.id)} aria-current={view === item.id || (item.id === "profile" && view === "saved") ? "page" : undefined}>
          <item.icon aria-hidden="true" size={21} /><span>{item.label}</span></a>)}
      </nav>
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
          close={() => { setCreateAfterLogin(false); setModal(null); }}
          onDone={() => {
            setModal(null);
            if (!createAfterLogin) notify("로그인했어요.");
          }}
        />
      )}
      {manualLink && <PostShareDialog url={manualLink} close={() => setManualLink("")} />}
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
      {detail && <PostDialog post={detail} actions={actions(detail)} userId={userId} close={closePost}
        editorialTitle={detailMeta?.title} position={detailIndex >= 0 ? detailIndex + 1 : undefined} total={detailIndex >= 0 ? posts.length : undefined}
        onPrevious={detailIndex > 0 ? () => openPost(posts[detailIndex - 1]) : undefined}
        onNext={detailIndex >= 0 && detailIndex + 1 < posts.length ? () => openPost(posts[detailIndex + 1]) : undefined}
        credit={detailMeta ? { label: detailMeta.creator ?? "사진 출처", url: detailMeta.sourceUrl } : undefined}
        onDetails={patch => patchPost(detail.id, patch)}
        login={() => setModal("auth")}
        onComment={() => patchPost(detail.id, { comment_count: Number(detail.comment_count) + 1 })} />}
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
        <Dialog title="게시물을 삭제할까요?" close={() => setDeleting(null)}>
          <p className="muted">
            사진과 좋아요, 댓글이 삭제됩니다. 이 작업은 되돌릴 수 없어요.
          </p>
          <button
            className="dark-button full"
            disabled={busy.includes("delete")}
            onClick={() =>
              void run("delete", async () => {
                await accountAction(supabase!, "", { action: "delete", postId: deleting.id }, userId!);
                closePost();
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
