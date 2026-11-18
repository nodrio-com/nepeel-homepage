import { useEffect, useRef } from "react";

export const mobileCameraDevice = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function useAppCamera(showAvailability: () => void) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return () => {
    cleanup.current?.();
    if (!mobileCameraDevice()) { showAvailability(); return; }
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", finish);
      document.removeEventListener("visibilitychange", visibility);
      cleanup.current = null;
    };
    const visibility = () => { if (document.hidden) finish(); };
    const fallback = () => { finish(); if (!document.hidden) showAvailability(); };
    const timer = window.setTimeout(fallback, 1800);
    cleanup.current = finish;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", finish);
    try { location.assign("nepeel://camera"); }
    catch { fallback(); }
  };
}
