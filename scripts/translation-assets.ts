import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// The upstream classic worker resolves both its glue script and WASM relative to itself.
export function translationAssets(): Plugin {
  const folder = dirname(createRequire(import.meta.url).resolve("@mkljczk/bergamot-translator/worker/translator-worker.js"));
  const files = ["translator-worker.js", "bergamot-translator-worker.js", "bergamot-translator-worker.wasm"];
  const prefix = "translation/bergamot-0.4.16/";
  return {
    name: "nepeel-translation-worker",
    configureServer(server) {
      server.middlewares.use("/" + prefix, async (req, res, next) => {
        const name = req.url?.slice(1);
        if (!name || !files.includes(name)) return next();
        try {
          res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          res.end(await readFile(join(folder, name)));
        } catch (error) { next(error); }
      });
    },
    async generateBundle() {
      for (const name of files) {
        this.emitFile({ type: "asset", fileName: prefix + name, source: await readFile(join(folder, name)) });
      }
    },
  };
}
