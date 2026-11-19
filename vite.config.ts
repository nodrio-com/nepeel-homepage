import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { translationAssets } from "./scripts/translation-assets";

function certificateRoute(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((req, _res, next) => {
    if (req.url && /^\/verify(?:\/|\?|$)/.test(req.url)) req.url = "/verify.html";
    next();
  });
}

export default defineConfig({
  plugins: [
    react(),
    translationAssets(),
    { name: "certificate-route", configureServer: certificateRoute, configurePreviewServer: certificateRoute },
  ],
  build: { rollupOptions: {
    input: { index: "index.html", verify: "verify.html", "share-enhancements": "src/share-enhancements.tsx" },
    output: {
      entryFileNames: chunk => chunk.name === "share-enhancements" ? "share-enhancements.js" : "assets/[name]-[hash].js",
    },
  } },
});
