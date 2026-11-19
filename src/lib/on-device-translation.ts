import { localPack, packInstalled } from "./translation-packs";

interface Engine { translate(text: string): Promise<string>; destroy(): void }
type Pair = { sourceLanguage: string; targetLanguage: string };
type Availability = "available" | "downloadable" | "downloading" | "unavailable";
type Platform = typeof globalThis & {
  Translator?: { availability(pair: Pair): Promise<Availability>; create(pair: Pair): Promise<Engine> };
  LanguageDetector?: {
    availability(): Promise<Availability>;
    create(): Promise<{ detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>; destroy(): void }>;
  };
};
const platform: Platform = globalThis;
export const languageKey = "nepeel.hi.language";
export const languageChange = "nepeel-language-change";
const packReady = "nepeel-translation-ready";
let transientLanguage: string | undefined;

export function contentLanguage(preference?: string | null, browserLanguage?: string) {
  const preferred = preference === "ko" || preference === "en" ? preference : browserLanguage || "ko";
  try {
    const locale = new Intl.Locale(preferred);
    // Distinguish Traditional and Simplified Chinese when the browser can serve both.
    return locale.language === "zh" ? "zh-" + locale.maximize().script : locale.language;
  } catch { return "ko"; }
}

export function readerLanguage() {
  let saved: string | null = null;
  try { saved = globalThis.localStorage?.getItem(languageKey) ?? null; } catch { /* Restricted storage. */ }
  return contentLanguage(transientLanguage ?? saved, globalThis.navigator?.language);
}

export function saveLanguage(language: string) {
  try { localStorage.setItem(languageKey, language); transientLanguage = undefined; }
  catch { transientLanguage = language; }
  window.dispatchEvent(new Event(languageChange));
}

export function watchLanguage(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("languagechange", listener);
  window.addEventListener(languageChange, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("languagechange", listener);
    window.removeEventListener(languageChange, listener);
  };
}

let detector: ReturnType<NonNullable<Platform["LanguageDetector"]>["create"]> | undefined;
export async function sourceOf(text: string) {
  const words = text.replace(/https?:\/\/\S+|@[\p{L}\p{N}_.-]+/gu, " ").trim();
  if (!/\p{L}/u.test(words)) return undefined;
  const letters = words.match(/\p{L}/gu)!.length;
  if ((words.match(/\p{Script=Hangul}/gu)?.length || 0) >= letters / 2) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(words)) return "ja";
  if (/^(?:hi|hello(?: world)?|hey|thanks|thank you|good morning|good night)[.!?\s]*$/i.test(words)) return "en";
  try {
    if (platform.LanguageDetector && await platform.LanguageDetector.availability() === "available") {
      detector ??= platform.LanguageDetector.create().catch(error => { detector = undefined; throw error; });
      const [best] = await (await detector).detect(words);
      if (best?.detectedLanguage && best.detectedLanguage !== "und" && best.confidence >= 0.55) {
        return contentLanguage(null, best.detectedLanguage);
      }
    }
  } catch { /* Use the small bundled identifier when browser detection is restricted. */ }
  const { eld } = await import("eld/small");
  const result = eld.detect(words);
  return result.language && result.isReliable() ? contentLanguage(null, result.language) : undefined;
}

type Session = { engine: Promise<Engine>; uses: number; timer?: ReturnType<typeof setTimeout> };
const sessions = new Map<string, Session>();
const nativeFailures = new Set<string>();
const nativeNeedsGesture = new Set<string>();
type Plan = { source: string; download: boolean; mb?: number; run: (text: string) => Promise<string> };

export function watchModels(listener: () => void) {
  window.addEventListener(packReady, listener);
  return () => window.removeEventListener(packReady, listener);
}

function plan(key: string, source: string, download: boolean, create: () => Promise<Engine>, mb?: number): Plan {
  return {
    source, download: download && !sessions.has(key), mb,
    async run(text) {
      let entry = sessions.get(key);
      if (!entry) {
        // Native create() is invoked directly inside the pack button's trusted activation.
        const engine = new Promise<Engine>(resolve => resolve(create()));
        entry = { engine, uses: 0 };
        sessions.set(key, entry);
        if (download) void engine.then(() => window.dispatchEvent(new Event(packReady)), () => {});
      }
      entry.uses++;
      clearTimeout(entry.timer);
      try {
        return await (await entry.engine).translate(text);
      } catch (error) {
        if (sessions.get(key) === entry) {
          sessions.delete(key);
          void entry.engine.then(engine => engine.destroy(), () => {});
        }
        if (key.startsWith("native:")) {
          if (!download && error instanceof DOMException && error.name === "NotAllowedError") nativeNeedsGesture.add(key);
          else nativeFailures.add(key);
        }
        throw error;
      } finally {
        if (--entry.uses === 0 && sessions.get(key) === entry) entry.timer = setTimeout(() => {
          sessions.delete(key);
          void entry.engine.then(engine => engine.destroy(), () => {});
        }, 90_000);
      }
    },
  };
}

export async function translationPlan(text: string, target: string, knownSource?: string): Promise<Plan | undefined> {
  const source = knownSource || await sourceOf(text);
  if (!source || source === target) return;
  const pair = { sourceLanguage: source, targetLanguage: target };
  const key = source + ":" + target;
  const nativeKey = "native:" + key;
  const translator = platform.Translator;
  if (translator && !nativeFailures.has(nativeKey)) {
    try {
      const availability = await translator.availability(pair);
      if (availability !== "unavailable") {
        return plan(nativeKey, source, availability !== "available" || nativeNeedsGesture.has(nativeKey), () => translator.create(pair));
      }
    } catch { /* Browser policy or unsupported pair. */ }
  }
  const pack = localPack(source, target);
  if (!pack || typeof WebAssembly === "undefined" || typeof Worker === "undefined" || !globalThis.isSecureContext) return;
  const installed = sessions.has(key) || await packInstalled(pack).catch(() => false);
  return plan(key, source, !installed, async () => {
    const { createBergamot } = await import("./bergamot");
    return createBergamot(pack, !installed);
  }, pack.mb);
}
