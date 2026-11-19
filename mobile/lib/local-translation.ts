export interface TranslationEngine {
  translate(text: string, target: string): Promise<string | null>;
}

export function translationLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  return locale.split(/[-_]/)[0]?.toLowerCase() || "ko";
}

// A long chat can mount many messages at once. Limit simultaneous native models,
// and discard queued work when the reader leaves the screen.
export function createTranslationQueue(engine: TranslationEngine | null) {
  const waiting = new Set<() => void>();
  let active = 0;
  function next() {
    const start = waiting.values().next().value;
    if (start && active < 2) {
      waiting.delete(start);
      start();
    }
  }
  return (text: string, target: string, show: (result: string) => void) => {
    let mounted = true;
    const start = async () => {
      active++;
      try {
        const result = await engine!.translate(text, target);
        if (mounted && result?.trim() && result.trim() !== text.trim()) show(result);
      } catch {
        // The original is already displayed if the engine or language pack is unavailable.
      } finally {
        active--;
        next();
      }
    };
    if (engine && /\p{L}/u.test(text)) {
      waiting.add(start);
      next();
    }
    return () => {
      mounted = false;
      waiting.delete(start);
    };
  };
}
