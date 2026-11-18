import { useSyncExternalStore } from "react";

const memory = new Map<string, string>();
const changed = "nepeel:editorial-saves";

function subscribe(refresh: () => void) {
  window.addEventListener("storage", refresh);
  window.addEventListener(changed, refresh);
  return () => {
    window.removeEventListener("storage", refresh);
    window.removeEventListener(changed, refresh);
  };
}

function read(key: string) {
  try { return localStorage.getItem(key) ?? memory.get(key) ?? "[]"; }
  catch { return memory.get(key) ?? "[]"; }
}
function ids(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.startsWith("sample-")) : [];
  } catch { return []; }
}
export function useEditorialSaves(userId?: string) {
  const key = "nepeel.editorial-saves." + (userId ?? "guest");
  const raw = useSyncExternalStore(subscribe, () => read(key));
  function toggle(id: string) {
    const current = ids(read(key));
    const next = JSON.stringify(current.includes(id) ? current.filter(item => item !== id) : [id, ...current]);
    memory.set(key, next);
    try { localStorage.setItem(key, next); } catch { /* Retain saves for the active tab. */ }
    window.dispatchEvent(new Event(changed));
  }
  return { ids: ids(raw), toggle };
}
