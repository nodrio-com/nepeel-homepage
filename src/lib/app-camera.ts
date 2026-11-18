import { useEffect, useRef, useState } from "react";

export const mobileCameraDevice = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function useAppCamera(showAvailability: () => void, view: string) {
  const cleanup = useRef<(() => void) | null>(null);
  const [needsHelp, setNeedsHelp] = useState(false);
  useEffect(() => {
    setNeedsHelp(false);
    return () => cleanup.current?.();
  }, [view]);
  function openCamera() {
    cleanup.current?.();
    setNeedsHelp(false);
    if (!mobileCameraDevice()) { showAvailability(); return; }
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
      cleanup.current = null;
    };
    const leave = () => { finish(); setNeedsHelp(false); };
    const visibility = () => { if (document.hidden) leave(); };
    const offerHelp = () => { if (!document.hidden) setNeedsHelp(true); };
    const timer = window.setTimeout(offerHelp, 1800);
    cleanup.current = finish;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    try { location.assign("nepeel://camera"); }
    catch { offerHelp(); }
  }
  return { openCamera, needsHelp };
}
