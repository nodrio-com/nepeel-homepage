import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight, Columns2,
  Copy, ImageOff, Images, Link2, Link2Off, Minus, Pencil, Play, Plus,
} from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getStackPreview, listStacks, listStackSources, saveStack, setStackShare,
  setStackSourceShare, stackPublicPath,
} from "../../shared/stacks";
import type { StackCursor, StackSource, WorkStack } from "../../shared/stacks";
import { Dialog } from "../App";
import { supabase } from "../lib/supabase";
import "./media-stacks.css";

type Media = StackSource & { sampleUrl?: string };
type Client = SupabaseClient;
const keyOf = (item: Media) => `${item.source}:${item.id}`;
const kindOf = (item: Media) => item.mediaKind === "video" ? "영상" : "사진";
const captionOf = (item: Media) => item.caption?.trim() || kindOf(item);

// Share in-flight downloads and dispose of the private bytes with the last view.
function previewPool(client: Client) {
  const entries = new Map<string, { users: number; url: Promise<string> }>();
  return (item: Media) => {
    const key = keyOf(item);
    const entry = entries.get(key) ?? { users: 0, url: getStackPreview(client, item).then(
      blob => URL.createObjectURL(blob),
      error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    ) };
    entries.set(key, entry);
    entry.users++;
    return {
      url: entry.url,
      release() {
        if (--entry.users > 0) return;
        if (entries.get(key) === entry) entries.delete(key);
        void entry.url.then(url => URL.revokeObjectURL(url), () => {});
      },
    };
  };
}
const PreviewContext = createContext<ReturnType<typeof previewPool> | null>(null);

function MediaFrame({ item, full = false }: { item: Media; full?: boolean }) {
  const acquire = useContext(PreviewContext);
  const frame = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl("");
    setFailed(false);
    if (item.sampleUrl || !acquire) return;
    let active = true;
    let lease: ReturnType<NonNullable<typeof acquire>> | undefined;
    function load() {
      if (lease || !acquire) return;
      const pending = acquire(item);
      lease = pending;
      void pending.url.then(
        next => { if (active && lease === pending) setUrl(next); },
        () => { if (active && lease === pending) setFailed(true); },
      );
    }
    const observer = !full && typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) load();
          else if (lease) {
            lease.release();
            lease = undefined;
            setUrl("");
            setFailed(false);
          }
        }, { rootMargin: "160px" })
      : null;
    if (observer && frame.current) observer.observe(frame.current);
    else load();
    return () => { active = false; observer?.disconnect(); lease?.release(); };
  }, [acquire, item, full]);
  const src = item.sampleUrl || url;
  return <span className={`ms-frame${full ? " ms-full" : ""}`} ref={frame}>
    {failed ? <span className="ms-unavailable"><ImageOff size={18} />미리보기 불가</span>
      : src && (item.mediaKind === "video"
        ? <video src={full ? src : `${src}#t=0.001`} controls={full} playsInline
            muted={!full} preload="metadata" aria-label={captionOf(item)} onError={() => setFailed(true)} />
        : <img src={src} alt={full ? captionOf(item) : ""} onError={() => setFailed(true)} />)}
    {!full && item.mediaKind === "video" && <span className="ms-kind"><Play size={13} />영상</span>}
  </span>;
}

function Compare({ photos }: { photos: Media[] }) {
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(1);
  const [split, setSplit] = useState(50);
  return <div className="ms-compare">
    {photos.length > 2 ? <div className="ms-compare-fields">
      {(["왼쪽", "오른쪽"] as const).map((label, i) =>
        <label key={label}>{label} 사진
          <select value={i === 0 ? left : right} onChange={e => {
            const index = Number(e.target.value);
            if (i === 0) setLeft(index);
            else setRight(index);
          }}>
            {photos.map((item, index) => <option key={keyOf(item)} value={index}
              disabled={index === (i === 0 ? right : left)}>
              {index + 1}. {captionOf(item)}
            </option>)}
          </select>
        </label>)}
    </div> : <div className="ms-compare-pair"><span>첫 번째 사진</span><span>두 번째 사진</span></div>}
    <div className="ms-compare-stage">
      <MediaFrame key={keyOf(photos[right])} item={photos[right]} full />
      <div className="ms-compare-left" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <MediaFrame key={keyOf(photos[left])} item={photos[left]} full />
      </div>
      <span aria-hidden="true" className="ms-divider" style={{ left: `${split}%` }}>
        <span><ChevronLeft /><ChevronRight /></span>
      </span>
      <input type="range" min="0" max="100" value={split} aria-label="사진 비교 경계"
        aria-valuetext={`왼쪽 사진 ${split}%`} onChange={e => setSplit(Number(e.target.value))} />
    </div>
  </div>;
}

function Gallery({ title, items, children, sample = false }: {
  title: string; items: Media[]; children?: ReactNode; sample?: boolean;
}) {
  const [view, setView] = useState<number | "compare" | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (view === null && opener.current) {
      opener.current.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [view]);
  const photos = items.filter(item => item.mediaKind === "photo");
  return <section className={sample ? "ms-gallery ms-sample" : "ms-gallery"}>
    <div className="ms-bar">
      <div><h2>{title}</h2>{sample && <a className="ms-credit" href="/photo-credits.txt"
        target="_blank" rel="noreferrer">예시 사진 · Piotrus / CC BY-SA 3.0</a>}</div>
      <div className="ms-actions">{children}</div>
    </div>
    {items.length > 0 ? <>
      <ol className={`ms-gallery-grid${items.length === 3 ? " ms-triptych" : ""}`}>
        {items.map((item, index) => <li key={keyOf(item)}>
          <button type="button" className="ms-tile" onClick={e => { opener.current = e.currentTarget; setView(index); }}
            aria-label={`${index + 1}번째 ${kindOf(item)} 열기 · ${captionOf(item)}`}>
            <MediaFrame item={item} /><span className="ms-position">{index + 1}</span>
          </button>
        </li>)}
      </ol>
      {photos.length >= 2 && <button type="button" className="ms-text"
        onClick={e => { opener.current = e.currentTarget; setView("compare"); }}>
        <Columns2 size={17} /> 두 장 비교
      </button>}
    </> : <p className="ms-note">아직 담은 항목이 없습니다. 편집에서 사진이나 영상을 추가하세요.</p>}
    {view === "compare" && photos.length >= 2 && <Dialog title="두 장 비교" close={() => setView(null)} wide>
      <Compare photos={photos} />
    </Dialog>}
    {typeof view === "number" && items[view] && <Dialog title={`${title} · ${view + 1} / ${items.length}`}
      close={() => setView(null)} wide>
      <div className="ms-reader">
        <div className="ms-reader-image"><MediaFrame key={keyOf(items[view])} item={items[view]} full /></div>
        <p>{captionOf(items[view])}</p>
        {items.length > 1 && <div className="ms-reader-nav">
          <button className="ms-text" disabled={view === 0} onClick={() => setView(view - 1)}><ChevronLeft />이전</button>
          <button className="ms-text" disabled={view === items.length - 1} onClick={() => setView(view + 1)}>다음<ChevronRight /></button>
        </div>}
      </div>
    </Dialog>}
  </section>;
}

const samples: Media[] = [
  { id: "sample-pottery", caption: "한 손은 안쪽에서, 다른 손은 바깥에서 흙을 받친다.", sampleUrl: "/images/pottery.webp" },
  { id: "sample-pottery-rim", caption: "물레 위 그릇의 옆면에 얇은 줄이 겹쳐 있다.", sampleUrl: "/images/pottery-rim.webp" },
].map(item => ({
  ...item, source: "post", mediaKind: "photo", createdAt: "2008-05-23",
  imagePath: null, shared: false, inShare: false,
}));

function StackEditor({ client, original, onSave, close }: {
  client: Client; original?: WorkStack; onSave: (stack: WorkStack) => void; close: () => void;
}) {
  const [id] = useState(() => original?.id ?? crypto.randomUUID());
  const [title, setTitle] = useState(original?.title ?? "");
  const [items, setItems] = useState<StackSource[]>(original?.items ?? []);
  const [sources, setSources] = useState<StackSource[]>([]);
  const [cursor, setCursor] = useState<StackCursor | null>(null);
  const [pageTrigger, setPageTrigger] = useState<{ before?: StackCursor }>({});
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const copyId = useRef("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setPageError(false);
    void listStackSources(client, pageTrigger.before).then(page => {
      if (!active) return;
      setSources(previous => pageTrigger.before
        ? [...previous, ...page.items.filter(item => !previous.some(existing => keyOf(existing) === keyOf(item)))]
        : page.items);
      setCursor(page.next);
    }).catch(() => { if (active) setPageError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, pageTrigger]);

  function toggle(item: StackSource) {
    const exists = items.some(other => keyOf(other) === keyOf(item));
    setItems(exists ? items.filter(other => keyOf(other) !== keyOf(item)) : [...items, item]);
    setStatus(exists ? "묶음에서 뺐습니다." : `${items.length + 1}번째로 담았습니다.`);
  }
  function move(index: number, step: number) {
    const next = [...items];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setItems(next);
    setStatus(`${captionOf(items[index])} · ${index + step + 1}번째로 옮겼습니다.`);
  }
  async function save(copy = false) {
    if (saving || !title.trim()) return;
    setSaving(true);
    setSaveError("");
    const refs = items.map(({ id, source }) => ({ id, source }));
    if (copy && !copyId.current) copyId.current = crypto.randomUUID();
    const target = copy ? copyId.current : id;
    try {
      const result = await saveStack(client, {
        id: target, title: title.trim(), revision: copy ? null : original?.revision ?? null, items: refs,
      });
      onSave(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/다른 곳에서|이미 저장된/.test(message)) {
        const fresh = (await listStacks(client).catch(() => [])).find(s => s.id === target);
        if (fresh?.title === title.trim() && fresh.items.length === items.length &&
          fresh.items.every((item, index) => keyOf(item) === keyOf(items[index]))) {
          onSave(fresh);
          return;
        }
        setConflict(true);
        setSaveError("다른 곳에서 묶음이 바뀌었습니다. 지금 편집한 내용은 새 묶음으로 저장할 수 있어요.");
      } else {
        setSaveError("묶음을 저장하지 못했습니다. 입력한 내용은 그대로예요. 다시 저장해 주세요.");
      }
      setSaving(false);
    }
  }
  return <section className="ms-editor">
    <div className="ms-bar"><h2>{original ? "묶음 편집" : "새 묶음"}</h2>
      <button className="ms-text" disabled={saving} onClick={close}>취소</button>
    </div>
    <form onSubmit={e => { e.preventDefault(); void save(conflict); }}>
      <fieldset disabled={saving}>
        <label className="ms-field">묶음 이름
          <input value={title} required maxLength={80} placeholder="예: 서울에서 보낸 사흘"
            onChange={e => setTitle(e.target.value)} />
        </label>
        {items.length > 0 && <div className="ms-block">
          <h3>담은 순서 <span>{items.length}</span></h3>
          <ol className="ms-order">{items.map((item, index) => <li key={keyOf(item)}>
            <div className="ms-order-cover"><MediaFrame item={item} /></div>
            <span className="ms-item-name"><b>{index + 1}.</b> {captionOf(item)}</span>
            <div className="ms-order-actions">
              <button type="button" disabled={index === 0} aria-label={`${index + 1}번째 항목 앞으로`}
                onClick={() => move(index, -1)}><ArrowUp /></button>
              <button type="button" disabled={index === items.length - 1} aria-label={`${index + 1}번째 항목 뒤로`}
                onClick={() => move(index, 1)}><ArrowDown /></button>
              <button type="button" aria-label={`${index + 1}번째 항목 빼기`} onClick={() => toggle(item)}><Minus /></button>
            </div>
          </li>)}</ol>
        </div>}
        <div className="ms-block">
          <h3>내 사진과 영상</h3>
          {sources.length > 0 && <div className="ms-picker">
            {sources.map(item => {
              const position = items.findIndex(other => keyOf(other) === keyOf(item));
              return <button type="button" key={keyOf(item)} className="ms-tile"
                aria-pressed={position >= 0} aria-label={`${captionOf(item)} ${position >= 0 ? "빼기" : "담기"}`}
                disabled={position < 0 && items.length >= 100} onClick={() => toggle(item)}>
                <MediaFrame item={item} />
                <span className="ms-pick-mark">{position >= 0 ? <><Check size={14} />{position + 1}</> : <Plus size={16} />}</span>
              </button>;
            })}
          </div>}
          {!loading && !pageError && !sources.length && <p className="ms-note">아직 담을 사진이나 영상이 없습니다. 앱에서 촬영한 뒤 여기에 담을 수 있어요.</p>}
          {loading && <p className="ms-note" role="status">사진과 영상을 불러오는 중…</p>}
          {pageError && <p className="ms-error" role="alert">사진과 영상을 불러오지 못했습니다.
            <button type="button" className="ms-text" onClick={() => setPageTrigger({ ...pageTrigger })}>다시 시도</button></p>}
          {!loading && !pageError && cursor && <button type="button" className="ms-text"
            onClick={() => setPageTrigger({ before: cursor })}>더 불러오기</button>}
          {items.length >= 100 && <p className="ms-note">묶음 하나에 최대 100개까지 담을 수 있어요.</p>}
        </div>
        <span className="ms-sr" role="status">{status}</span>
        {saveError && <p className="ms-error" role="alert">{saveError}</p>}
        {original?.shareToken && <p className="ms-note">저장하면 공개 묶음에도 변경 사항이 반영됩니다.</p>}
        <button type="submit" disabled={!title.trim() || saving} className="dark-button ms-save">
          {saving ? "저장 중…" : conflict ? "새 묶음으로 저장" : "묶음 저장"}
        </button>
      </fieldset>
    </form>
  </section>;
}

function ShareSettings({ client, stack, update, close }: {
  client: Client; stack: WorkStack; update: (stack: WorkStack) => void; close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const eligible = stack.items.filter(item => item.shared);
  const unpublished = eligible.some(item => !item.inShare);
  const href = stack.shareToken ? new URL(stackPublicPath(stack.shareToken), location.origin).href : "";
  async function change(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      update(await setStackShare(client, stack.id, enabled, stack.revision));
      setStatus(enabled ? "공개 항목을 반영했습니다." : "묶음 링크를 끊었습니다.");
    } catch (error) {
      if (error instanceof Error && /다른 곳에서/.test(error.message)) {
        const fresh = (await listStacks(client).catch(() => [])).find(current => current.id === stack.id);
        if (fresh) update(fresh);
      }
      setError("묶음 링크 상태를 확인한 뒤 다시 시도해 주세요.");
    } finally { setBusy(false); }
  }
  async function toggleItem(item: StackSource) {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await setStackSourceShare(client, item, !item.shared);
      const fresh = (await listStacks(client)).find(current => current.id === stack.id);
      if (!fresh) throw new Error();
      update(fresh);
      setStatus(item.shared ? "개별 링크를 껐습니다." : "개별 링크를 켰습니다.");
    } catch {
      setError("항목의 공유 상태를 확인하지 못했습니다. 다시 시도해 주세요.");
    } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(href); setStatus("묶음 링크를 복사했습니다."); }
    catch { setStatus("묶음 링크를 선택해 복사하세요."); }
  }
  return <section className="ms-share">
    <button className="ms-back" disabled={busy} onClick={close}><ArrowLeft />묶음으로</button>
    <h2>{stack.title} 공유</h2>
    <p className="ms-note">개별 링크가 켜진 항목은 로그인 없이 볼 수 있습니다. 묶음 링크를 끊어도 개별 링크는 유지됩니다.</p>
    {stack.items.length > 0 && <ul className="ms-share-list">{stack.items.map(item =>
      <li key={keyOf(item)}>
        <div className="ms-order-cover"><MediaFrame item={item} /></div>
        <span className="ms-item-name">{captionOf(item)}
          {item.shared && <small className="ms-share-state">{item.inShare ? "묶음에 공개 중" : "개별 링크 켜짐"}</small>}
        </span>
        <button className="ms-text" disabled={busy} onClick={() => void toggleItem(item)}>
          {item.shared ? "개별 링크 끄기" : "개별 링크 켜기"}
        </button>
      </li>)}</ul>}
    {!stack.items.length && <p className="ms-note">항목을 담은 뒤 공유할 수 있어요.</p>}
    {href && <label className="ms-field">묶음 링크
      <input type="url" readOnly value={href} onFocus={e => e.target.select()} />
    </label>}
    <div className="ms-actions">
      {!href ? <button className="dark-button" disabled={busy || !eligible.length} onClick={() => void change(true)}>
        <Link2 size={16} />묶음 링크 만들기</button>
        : <>
          <button className="dark-button" disabled={busy} onClick={() => void copy()}><Copy size={16} />링크 복사</button>
          {unpublished && <button className="outline-button" disabled={busy} onClick={() => void change(true)}>공개 항목 반영</button>}
          <button className="ms-text" disabled={busy} onClick={() => void change(false)}><Link2Off size={16} />묶음 링크 끊기</button>
        </>}
    </div>
    {error && <p className="ms-error" role="alert">{error}</p>}
    <p role="status" className="ms-status">{busy ? "공유 설정을 변경하는 중…" : status}</p>
  </section>;
}

type Screen = { page: "list" } | { page: "create" } | { page: "gallery" | "edit" | "share"; id: string };

function MemberStacks({ client }: { client: Client }) {
  const previews = useMemo(() => previewPool(client), [client]);
  const [stacks, setStacks] = useState<WorkStack[]>([]);
  const [screen, setScreen] = useState<Screen>({ page: "list" });
  const pane = useRef<HTMLDivElement>(null);
  const lastPage = useRef(screen.page);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (lastPage.current !== screen.page) {
      const heading = pane.current?.querySelector("h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "instant" });
      }
      lastPage.current = screen.page;
    }
  }, [screen.page]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void listStacks(client).then(result => { if (active) setStacks(result); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, retry]);
  const findId = "id" in screen ? screen.id : null;
  const current = stacks.find(stack => stack.id === findId);
  function update(result: WorkStack) {
    setStacks(previous => previous.some(stack => stack.id === result.id)
      ? previous.map(stack => stack.id === result.id ? result : stack)
      : [result, ...previous]);
  }
  return <PreviewContext.Provider value={previews}><div ref={pane}>
    {screen.page === "create" || (screen.page === "edit" && current)
      ? <StackEditor key={current?.id ?? "create"} client={client} original={current}
          close={() => setScreen(current ? { page: "gallery", id: current.id } : { page: "list" })}
          onSave={stack => { update(stack); setScreen({ page: "gallery", id: stack.id }); }} />
      : screen.page === "share" && current
        ? <ShareSettings client={client} stack={current} update={update}
            close={() => setScreen({ page: "gallery", id: current.id })} />
        : screen.page === "gallery" && current
          ? <>
              <button className="ms-back" onClick={() => setScreen({ page: "list" })}><ArrowLeft />내 묶음</button>
              <Gallery title={current.title} items={current.items}>
                <button className="ms-text" onClick={() => setScreen({ page: "edit", id: current.id })}><Pencil />편집</button>
                <button className="ms-text" onClick={() => setScreen({ page: "share", id: current.id })}><Link2 />공유</button>
              </Gallery>
            </>
          : <section className="ms-library">
              <div className="ms-bar"><h2>내 묶음</h2>
                <button className="dark-button" disabled={loading || error || stacks.length >= 100}
                  onClick={() => setScreen({ page: "create" })}><Plus size={17} />새 묶음</button>
              </div>
              {loading ? <p className="ms-note" role="status">묶음을 불러오는 중…</p>
                : error ? <p className="ms-error" role="alert">묶음을 불러오지 못했습니다.
                    <button className="ms-text" onClick={() => setRetry(n => n + 1)}>다시 시도</button></p>
                  : stacks.length ? <ul className="ms-covers">
                      {stacks.map(stack => <li key={stack.id}>
                        <button className="ms-cover-button" onClick={() => setScreen({ page: "gallery", id: stack.id })}>
                          <span className={`ms-cover ms-cover-count-${Math.min(stack.items.length, 3)}`}>
                            {stack.items.length ? stack.items.slice(0, 3).map(item => <MediaFrame key={keyOf(item)} item={item} />)
                              : <Images aria-hidden="true" />}
                          </span>
                          <strong>{stack.title}</strong>
                          <small>{stack.items.length}개 · {stack.shareToken ? "링크 공유 중" : "비공개"}</small>
                        </button>
                      </li>)}
                    </ul>
                    : <p className="ms-note">아직 만든 묶음이 없습니다. 사진과 영상을 골라 원하는 순서로 담으세요.</p>}
              {stacks.length >= 100 && <p className="ms-note">묶음은 최대 100개까지 만들 수 있어요.</p>}
            </section>}
  </div></PreviewContext.Provider>;
}

export function MediaStacks({ userId, login, client = supabase }: {
  userId?: string | null; login: () => void; client?: Client | null;
}) {
  return <div className="media-stacks">
    {userId ? client ? <MemberStacks key={userId} client={client} />
      : <p className="ms-error" role="alert">묶음을 불러오려면 서비스 연결이 필요합니다.</p>
      : <Gallery title="라브카의 물레" items={samples} sample>
          <button className="dark-button" onClick={login}><Plus size={17} />내 묶음 만들기</button>
        </Gallery>}
  </div>;
}
export default MediaStacks;
