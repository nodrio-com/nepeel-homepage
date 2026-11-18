import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, ChevronLeft, ChevronRight, Columns2,
  Camera, ChevronDown, ImageOff, Images, Link2Off, Minus, Pencil, Play, Plus, Share2,
} from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getStackPreview, listStacks, listStackSources, publishStackSelection, saveStack, setStackShare, stackPublicPath,
} from "../../shared/stacks";
import type { StackCursor, StackRef, StackSource, WorkStack } from "../../shared/stacks";
import { Dialog } from "../App";
import { supabase } from "../lib/supabase";
import { deliverMediaLink } from "../lib/share-link";
import "./media-stacks.css";

type Media = StackSource & { sampleUrl?: string };
type Client = SupabaseClient;
const keyOf = (item: StackRef) => `${item.source}:${item.id}`;
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

function Gallery({ title, items, children, feedback, sample = false }: {
  title: string; items: Media[]; children?: ReactNode; feedback?: ReactNode; sample?: boolean;
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
    {feedback}
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
    </> : <p className="ms-note">아직 담은 항목이 없습니다.</p>}
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

function isStackConflict(error: unknown) {
  return error instanceof Error && /다른 곳에서|이미 저장된|새로고침/.test(error.message);
}

function stackName(item: StackSource | undefined, today: Date) {
  if (!item) return "";
  const caption = item.caption?.trim().replace(/\s+/g, " ");
  if (caption) return Array.from(caption).slice(0, 80).join("");
  const captured = new Date(item.createdAt);
  const date = Number.isNaN(captured.getTime()) ? today : captured;
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(date) + " 묶음";
}

function StackEditor({ client, original, onSave, onLatest, close, onCamera }: {
  client: Client; original?: WorkStack; onSave: (stack: WorkStack) => void;
  onLatest: (stack: WorkStack) => void; close: () => void; onCamera?: () => void;
}) {
  const [id] = useState(() => original?.id ?? crypto.randomUUID());
  const [revision, setRevision] = useState(original?.revision ?? null);
  const [today] = useState(() => new Date());
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [status, setStatus] = useState("");
  const submitting = useRef(false);
  const defaultName = stackName(items[0], today);
  const name = title.trim() || defaultName;

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
  }
  function move(index: number, step: number) {
    const next = [...items];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setItems(next);
    setStatus(`${captionOf(items[index])} · ${index + step + 1}번째`);
  }
  async function save() {
    if (submitting.current || (!name && !conflict)) return;
    submitting.current = true;
    setSaving(true);
    setSaveError("");
    try {
      if (conflict) {
        const fresh = (await listStacks(client)).find(stack => stack.id === id);
        if (!fresh) throw new Error();
        onLatest(fresh);
        setRevision(fresh.revision);
        setTitle(fresh.title);
        setItems(fresh.items);
        setConflict(false);
        return;
      }
      const result = await saveStack(client, {
        id, title: name, revision, items,
      });
      onSave(result);
    } catch (error) {
      if (isStackConflict(error)) {
        const fresh = (await listStacks(client).catch(() => [])).find(stack => stack.id === id);
        if (fresh?.title === name && fresh.items.length === items.length &&
            fresh.items.every((item, i) => keyOf(item) === keyOf(items[i]))) {
          onSave(fresh);
          return;
        }
        setConflict(true);
        setSaveError("다른 곳에서 묶음이 바뀌었습니다. 최신 내용을 불러와 다시 편집하세요.");
      } else {
        setSaveError(conflict ? "최신 내용을 불러오지 못했습니다." : "묶음을 저장하지 못했습니다.");
      }
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return <section className="ms-editor">
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="ms-bar ms-editor-bar"><h2>{original ? "묶음 편집" : "새 묶음"}</h2>
        <div className="ms-actions">
          <button type="button" className="ms-text" disabled={saving} onClick={close}>취소</button>
          <button type="submit" disabled={saving || (!name && !conflict)} className="dark-button">
            {saving ? (conflict ? "불러오는 중…" : "저장 중…") : conflict ? "최신 내용 불러오기" : saveError ? "다시 저장" : "묶음 저장"}
          </button>
        </div>
        {saveError && <p className="ms-error" role="alert">{saveError}</p>}
      </div>
      <fieldset disabled={saving}>
        <div className="ms-picker-heading">
          <h3>내 사진과 영상 <span aria-live="polite">{items.length}개 선택</span></h3>
          <button className="ms-text" type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}>
            이름·순서 <ChevronDown size={15} />
          </button>
        </div>
        {optionsOpen && <div className="ms-options">
          <label className="ms-field">묶음 이름
            <input value={title} maxLength={80} placeholder={defaultName || "묶음 이름 입력"} onChange={e => setTitle(e.target.value)} />
          </label>
          {items.length > 0 && <ol className="ms-order" aria-label="담은 순서">{items.map((item, index) => <li key={keyOf(item)}>
            <div className="ms-order-cover"><MediaFrame item={item} /></div>
            <span className="ms-item-name"><b>{index + 1}.</b> {captionOf(item)}</span>
            <div className="ms-order-actions">
              <button type="button" disabled={index === 0} aria-label={`${index + 1}번째 항목 앞으로`}
                onClick={() => move(index, -1)}><ArrowUp /></button>
              <button type="button" disabled={index === items.length - 1} aria-label={`${index + 1}번째 항목 뒤로`}
                onClick={() => move(index, 1)}><ArrowDown /></button>
              <button type="button" aria-label={`${index + 1}번째 항목 빼기`} onClick={() => toggle(item)}><Minus /></button>
            </div>
          </li>)}</ol>}
          <span className="ms-sr" role="status">{status}</span>
        </div>}
        {sources.length > 0 && <div className="ms-picker">{sources.map(item => {
          const position = items.findIndex(other => keyOf(other) === keyOf(item));
          return <button type="button" key={keyOf(item)} className="ms-tile"
            aria-pressed={position >= 0} aria-label={`${captionOf(item)} ${position >= 0 ? "빼기" : "담기"}`}
            disabled={position < 0 && items.length >= 100} onClick={() => toggle(item)}>
            <MediaFrame item={item} />
            <span className="ms-pick-mark">{position >= 0 ? <><Check size={14} />{position + 1}</> : <Plus size={16} />}</span>
          </button>;
        })}</div>}
        {!loading && !pageError && !sources.length && <>
          <p className="ms-note">아직 담을 사진이나 영상이 없습니다.</p>
          {onCamera && <button type="button" className="outline-button" onClick={onCamera}><Camera size={17} />앱 카메라 열기</button>}
        </>}
        {loading && <p className="ms-note" role="status">사진과 영상을 불러오는 중…</p>}
        {pageError && <p className="ms-error" role="alert">사진과 영상을 불러오지 못했습니다.
          <button type="button" className="ms-text" onClick={() => setPageTrigger({ ...pageTrigger })}>다시 시도</button></p>}
        {!loading && !pageError && cursor && <button type="button" className="ms-text"
          onClick={() => setPageTrigger({ before: cursor })}>더 불러오기</button>}
        {items.length >= 100 && <p className="ms-note">최대 100개까지 담을 수 있어요.</p>}
      </fieldset>
    </form>
  </section>;
}

function StackDetail({ client, stack, manage, selectAll, update, openSettings, closeSettings, edit, back }: {
  client: Client; stack: WorkStack; manage: boolean; selectAll: boolean;
  update: (stack: WorkStack) => void; openSettings: () => void; closeSettings: () => void;
  edit: () => void; back: () => void;
}) {
  const [selected, setSelected] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState("");
  const working = useRef(false);
  const active = useRef(true);
  const manualInput = useRef<HTMLInputElement>(null);
  const included = stack.items.filter(item => item.inShare);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!manual) return;
    const frame = requestAnimationFrame(() => {
      manualInput.current?.focus();
      manualInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [manual]);

  function manageSelection() {
    setSelected(new Set((selectAll ? stack.items : included).map(keyOf)));
    setError("");
    setCopied(false);
    openSettings();
  }
  function apply(result: WorkStack) {
    update(result);
    setSelected(new Set(result.items.filter(item => item.inShare).map(keyOf)));
  }
  async function share(intent: "selected" | "current" | "revoke") {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setCopied(false);
    setError("");
    try {
      if (intent === "revoke") {
        const result = await setStackShare(client, stack.id, false, stack.revision);
        if (active.current) {
          apply(result);
          closeSettings();
        }
        return;
      }
      let current = stack;
      const changed = included.length !== selected.size || included.some(item => !selected.has(keyOf(item)));
      if (intent === "selected" && (!stack.shareToken || changed)) {
        const refs = stack.items.filter(item => selected.has(keyOf(item))).map(({ id, source }) => ({ id, source }));
        current = await publishStackSelection(client, stack.id, refs, stack.revision);
        if (!active.current) return;
        apply(current);
      }
      if (!current.shareToken || !current.items.some(item => item.inShare)) throw new Error();
      const url = new URL(stackPublicPath(current.shareToken), location.origin).href;
      const result = await deliverMediaLink(url, current.title);
      if (!active.current) return;
      if (result === "manual") setManual(url);
      else {
        if (manage) closeSettings();
        setCopied(result === "copied");
      }
    } catch (cause) {
      if (!active.current) return;
      if (isStackConflict(cause)) {
        const fresh = (await listStacks(client).catch(() => [])).find(row => row.id === stack.id);
        if (!active.current) return;
        if (fresh) apply(fresh);
        setError(fresh ? "묶음이 바뀌었습니다. 공유할 항목을 다시 선택하세요." : "공유 상태를 불러오지 못했습니다. 다시 시도해 주세요.");
      } else {
        setError(intent === "revoke" ? "공유 링크를 끊지 못했습니다. 다시 시도해 주세요." : "공유하지 못했습니다. 다시 시도해 주세요.");
      }
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <>
    {manage ? <section className="ms-share">
      <div className="ms-share-nav">
        <button className="ms-back" disabled={busy} onClick={() => { setError(""); closeSettings(); }}><ArrowLeft />묶음으로</button>
        {stack.shareToken && <button className="ms-text" disabled={busy} onClick={() => void share("revoke")}>
          <Link2Off size={16} />묶음 링크 끊기
        </button>}
      </div>
      <div className="ms-bar ms-editor-bar"><h2>공유할 항목</h2>
        <button className="dark-button" disabled={busy || !selected.size} onClick={() => void share("selected")}>
          <Share2 size={17} />{busy ? "처리 중…" : `${selected.size}개 공유`}
        </button>
        {error && <p className="ms-error" role="alert">{error}</p>}
      </div>
      {stack.items.length > 1 && <label className="ms-select-all">
        전체 선택
        <input type="checkbox" disabled={busy} checked={selected.size === stack.items.length}
          ref={input => { if (input) input.indeterminate = selected.size > 0 && selected.size < stack.items.length; }}
          onChange={e => setSelected(new Set(e.target.checked ? stack.items.map(keyOf) : []))} />
      </label>}
      <ul className="ms-share-list">{stack.items.map(item => <li key={keyOf(item)}>
        <label>
          <span className="ms-order-cover"><MediaFrame item={item} /></span>
          <span className="ms-item-name">{captionOf(item)}</span>
          <input type="checkbox" disabled={busy} checked={selected.has(keyOf(item))} onChange={e => {
            const next = new Set(selected);
            if (e.target.checked) next.add(keyOf(item));
            else next.delete(keyOf(item));
            setSelected(next);
          }} />
        </label>
      </li>)}</ul>
    </section> : <>
      <button className="ms-back" disabled={busy} onClick={back}><ArrowLeft />내 묶음</button>
      <Gallery title={stack.title} items={stack.items} feedback={<>
        {error && <p className="ms-error" role="alert">{error}</p>}
        {copied && <p className="ms-note" role="status">링크를 복사했습니다.</p>}
      </>}>
        <button className="ms-text" disabled={busy} onClick={edit}><Pencil />편집</button>
        {stack.shareToken && (included.length > 0 || !stack.items.length) &&
          <button className="ms-text" disabled={busy} onClick={manageSelection}>공유 관리</button>}
        {stack.items.length > 0 && <button className="dark-button" disabled={busy}
          onClick={() => stack.shareToken && included.length ? void share("current") : manageSelection()}>
          <Share2 size={17} />{busy ? "공유 중…" : "공유"}
        </button>}
      </Gallery>
    </>}
    {manual && <Dialog title="링크 복사" close={() => setManual("")}>
      <label className="ms-field">묶음 링크
        <input ref={manualInput} type="url" readOnly value={manual} onFocus={e => e.target.select()} />
      </label>
    </Dialog>}
  </>;
}

type Screen = { page: "list" } | { page: "create" } | { page: "gallery" | "edit" | "share"; id: string };

interface StackEntry {
  startCreating?: boolean;
  onCreateIntentHandled?: () => void;
  onCamera?: () => void;
}

function MemberStacks({ client, startCreating, onCreateIntentHandled, onCamera }: { client: Client } & StackEntry) {
  const previews = useMemo(() => previewPool(client), [client]);
  const [stacks, setStacks] = useState<WorkStack[]>([]);
  const [screen, setScreen] = useState<Screen>({ page: startCreating ? "create" : "list" });
  const unpublishedRevisions = useRef(new Map<string, number>());
  const pane = useRef<HTMLDivElement>(null);
  const lastPage = useRef<Screen["page"] | null>(startCreating ? null : screen.page);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!startCreating) return;
    setScreen({ page: "create" });
    onCreateIntentHandled?.();
  }, [startCreating, onCreateIntentHandled]);
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
    if (screen.page !== "list") return;
    let active = true;
    setLoading(true);
    setError(false);
    void listStacks(client).then(result => { if (active) setStacks(result); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, retry, screen.page]);
  const findId = "id" in screen ? screen.id : null;
  const current = stacks.find(stack => stack.id === findId);
  function neverPublished(stack: WorkStack) {
    return !stack.shareToken && (stack.revision === 1 || unpublishedRevisions.current.get(stack.id) === stack.revision);
  }
  function update(result: WorkStack) {
    setStacks(previous => previous.some(stack => stack.id === result.id)
      ? previous.map(stack => stack.id === result.id ? result : stack)
      : [result, ...previous]);
  }
  return <PreviewContext.Provider value={previews}><div ref={pane}>
    {screen.page === "create" || (screen.page === "edit" && current)
      ? <StackEditor key={current?.id ?? "create"} client={client} original={current} onLatest={update} onCamera={onCamera}
          close={() => setScreen(current ? { page: "gallery", id: current.id } : { page: "list" })}
          onSave={stack => {
            if (current && neverPublished(current) && !stack.shareToken && stack.revision === current.revision + 1) {
              unpublishedRevisions.current.set(stack.id, stack.revision);
            }
            update(stack);
            setScreen({ page: "gallery", id: stack.id });
          }} />
      : (screen.page === "share" || screen.page === "gallery") && current
        ? <StackDetail key={current.id} client={client} stack={current} update={update} manage={screen.page === "share"}
            selectAll={neverPublished(current)}
            openSettings={() => setScreen({ page: "share", id: current.id })}
            closeSettings={() => setScreen({ page: "gallery", id: current.id })}
            edit={() => setScreen({ page: "edit", id: current.id })} back={() => setScreen({ page: "list" })} />
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
                    : <p className="ms-note">아직 만든 묶음이 없습니다.</p>}
              {stacks.length >= 100 && <p className="ms-note">묶음은 최대 100개까지 만들 수 있어요.</p>}
            </section>}
  </div></PreviewContext.Provider>;
}

export function MediaStacks({ userId, login, client = supabase, ...entry }: {
  userId?: string | null; login: () => void; client?: Client | null;
} & StackEntry) {
  return <div className="media-stacks">
    {userId ? client ? <MemberStacks key={userId} client={client} {...entry} />
      : <p className="ms-error" role="alert">묶음을 불러오려면 서비스 연결이 필요합니다.</p>
      : <Gallery title="라브카의 물레" items={samples} sample>
          <button className="dark-button" onClick={login}><Plus size={17} />내 묶음 만들기</button>
        </Gallery>}
  </div>;
}
export default MediaStacks;
