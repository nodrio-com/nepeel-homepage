import { useRef, useState, type CSSProperties } from "react";
import type { Post } from "../../shared/types";
import "./photo-tape.css";

type Props = {
  src: string;
  alt: string;
  position: NonNullable<Post["tape"]>;
  fit: "contain" | "cover";
  decorative?: boolean;
  loading?: "eager" | "lazy";
  postId?: string;
  openLabel?: string;
  onOpen?: () => void;
  onLoad?: () => void;
  onError?: () => void;
};

const anchorY = { top: "25%", center: "50%", bottom: "75%" };

export function TapedPhoto(props: Props) {
  return <Photo key={props.src} {...props} />;
}

function Photo({ src, alt, position, fit, decorative, loading, postId, openLabel, onOpen, onLoad, onError }: Props) {
  const [ratio, setRatio] = useState(0);
  const image = useRef<HTMLImageElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const photo = <img ref={image} className="taped-image" src={src} alt={alt} draggable={false}
    loading={loading} decoding="async" tabIndex={onOpen || decorative ? undefined : -1}
    onError={onError} onLoad={event => {
      const img = event.currentTarget;
      if (img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight);
      onLoad?.();
    }} />;

  return <span className="taped-photo" data-fit={fit} data-loaded={!!ratio} style={{ "--tape-y": anchorY[position] } as CSSProperties}>
    {onOpen ? <button type="button" ref={opener} className="taped-photo-open" data-post-id={postId} aria-label={openLabel}
      onClick={event => { event.currentTarget.focus({ preventScroll: true }); onOpen(); }}>{photo}</button> : photo}
    {!!ratio && <TapeOverlay position={position} ratio={ratio} decorative={decorative} focusTarget={() => opener.current || image.current} />}
  </span>;
}

export function TapeOverlay({ position, ratio, decorative, focusTarget }: {
  position: Props["position"]; ratio: number; decorative?: boolean; focusTarget?: () => HTMLElement | null;
}) {
  const [peeled, setPeeled] = useState(false);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const cancelClick = useRef(false);
  const style = { "--photo-ratio": ratio, "--tape-y": anchorY[position] } as CSSProperties;

  function reveal(button: HTMLButtonElement) {
    if (peeled) return;
    if (document.activeElement === button) focusTarget?.()?.focus({ preventScroll: true });
    setPeeled(true);
  }

  return <span className="tape-plane" style={style}>
    {decorative ? <span aria-hidden="true" className="tape-strip"><span className="tape-paper" /></span> :
        <button type="button" className="tape-strip tape-control" aria-label="테이프 떼기"
          aria-hidden={peeled || undefined} tabIndex={peeled ? -1 : undefined} data-peeled={peeled}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0 || peeled) return;
            start.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            cancelClick.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { start.current = null; cancelClick.current = true; }}
          onPointerUp={event => {
            const first = start.current;
            start.current = null;
            if (!first || first.id !== event.pointerId) return;
            const dx = Math.abs(event.clientX - first.x);
            const dy = Math.abs(event.clientY - first.y);
            cancelClick.current = dy > 12 && dy > dx;
            if (dx >= 24 && dx > dy * 1.4) reveal(event.currentTarget);
          }}
          onClick={event => {
            event.stopPropagation();
            if (!cancelClick.current || event.detail === 0) reveal(event.currentTarget);
          }}>
          <span className="tape-paper"><span>떼기</span></span>
        </button>}
  </span>;
}
