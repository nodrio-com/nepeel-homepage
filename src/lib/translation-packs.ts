// Mozilla Firefox Translations v2.1 mobile models, pinned by immutable attachment and SHA-256.
const cdn = "https://huggingface.co/midudev/firefox-translations/resolve/6f6acd72c26975a06a8e61b72d1fbacbd184c23f/";
type File = readonly [attachment: string, hash: string];
export type LanguagePack = { from: string; to: string; mb: number; model: File; shortlist: File; vocabs: File[] };

const packs: Record<string, LanguagePack> = {
  "en-ko": {
    from: "en", to: "ko", mb: 52,
    model: ["en-ko/model.enko.intgemm.alphas.bin", "ffe5ef2ce3f2e944055e35310bab186f6a70d533a0ee4394adf716a0e383afbb"],
    shortlist: ["en-ko/lex.50.50.enko.s2t.bin", "96efba97d4bb93ab362e5569bea0f115184d2f68d63b67305ee663c18e32fbeb"],
    vocabs: [
      ["en-ko/srcvocab.enko.spm", "8d4e3141868efd410eb86c2b60d41aa6bc6b46e4c4b2c0b85e3792493c69d802"],
      ["en-ko/trgvocab.enko.spm", "2ece21b28dd7022d36127d17423a74dabf544787dfc1cf614f7b565f93a4a1d3"],
    ],
  },
  "ko-en": {
    from: "ko", to: "en", mb: 54,
    model: ["ko-en/model.koen.intgemm.alphas.bin", "7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507"],
    shortlist: ["ko-en/lex.50.50.koen.s2t.bin", "b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196"],
    vocabs: [["ko-en/vocab.koen.spm", "1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598"]],
  },
};

export const localPack = (from: string, to: string) => packs[from + "-" + to];

function files(pack: LanguagePack) {
  return [pack.model, pack.shortlist, ...pack.vocabs];
}

let database: Promise<IDBDatabase> | undefined;
function openModelStore() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nepeel-offline-translation", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch(error => { database = undefined; throw error; });
  return database;
}

async function modelFile<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openModelStore();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("files", mode);
    const request = operation(transaction.objectStore("files"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function packInstalled(pack: LanguagePack) {
  const keys = new Set(await modelFile("readonly", store => store.getAllKeys()).catch(() => []));
  return files(pack).every(([, hash]) => keys.has(hash));
}

export async function loadPack(pack: LanguagePack, allowDownload: boolean) {
  const buffers = await Promise.all(files(pack).map(async ([attachment, hash]) => {
    const url = cdn + attachment;
    const cached = await modelFile("readonly", store => store.get(hash)).catch(() => undefined);
    if (cached instanceof ArrayBuffer) return cached;
    if (!allowDownload) throw new Error("Translation pack needs a download");
    const integrity = btoa(String.fromCharCode(...hash.match(/../g)!.map(byte => parseInt(byte, 16))));
    const response = await fetch(url, {
      credentials: "omit", referrerPolicy: "no-referrer", integrity: "sha256-" + integrity,
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error("Translation pack download failed");
    const buffer = await response.arrayBuffer();
    // Private windows or low-storage devices can still translate in this session.
    try { await modelFile("readwrite", store => store.put(buffer, hash)); } catch { /* Quota or storage policy. */ }
    return buffer;
  }));
  const [model, shortlist, ...vocabs] = buffers;
  return { model, shortlist, vocabs };
}
