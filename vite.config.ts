import { defineConfig, type PreviewServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

function certificateRoute(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((req, _res, next) => {
    if (req.url && /^\/verify(?:\/|\?|$)/.test(req.url)) req.url = "/verify.html";
    next();
  });
}

export default defineConfig({
  plugins: [
    react(),
    { name: "certificate-route", configureServer: certificateRoute, configurePreviewServer: certificateRoute },
  ],
  build: { rollupOptions: { input: ["index.html", "verify.html"] } },
});
