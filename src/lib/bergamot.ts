import { loadPack, type LanguagePack } from "./translation-packs";

export async function createBergamot(pack: LanguagePack, allowDownload: boolean) {
  const worker = new Worker("/translation/bergamot-0.4.16/translator-worker.js");
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  let sequence = 0;
  let closed = false;
  function destroy() {
    closed = true;
    worker.terminate();
    for (const call of pending.values()) call.reject(new Error("Translation worker stopped"));
    pending.clear();
  }
  worker.onerror = destroy;
  worker.onmessageerror = destroy;
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error("On-device translation failed"));
    else call.resolve(data.result);
  };
  function call(name: string, args: unknown[], transfer: Transferable[] = []) {
    return new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new Error("Translation worker unavailable"));
      const id = ++sequence;
      const timer = setTimeout(destroy, 120_000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      worker.postMessage({ id, name, args }, transfer);
    });
  }
  try {
    await call("initialize", [{ useNativeIntGemm: false, cacheSize: 0 }]);
    const buffers = await loadPack(pack, allowDownload);
    const pair = { from: pack.from, to: pack.to };
    await call("loadTranslationModel", [pair, buffers], [buffers.model, buffers.shortlist, ...buffers.vocabs]);
    return {
      destroy,
      async translate(text: string) {
        const result = await call("translate", [{ models: [pair], texts: [{ text, html: false, qualityScores: false }] }]);
        return (result as { target: { text: string } }[])[0].target.text;
      },
    };
  } catch (error) { destroy(); throw error; }
}
