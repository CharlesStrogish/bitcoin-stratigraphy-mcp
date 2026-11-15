import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
// @ts-expect-error The standalone runtime is deliberately plain Node.js.
import { createConnectionService, connectionMiddleware } from "./server/connection.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const base = process.env.BASE_PATH || "/";
  const port = Number(process.env.PORT || 4173);
  const connection = createConnectionService({
    key: () => process.env.BITCOIN_STRATIGRAPHY_API_KEY || env.BITCOIN_STRATIGRAPHY_API_KEY,
  });
  return {
    base,
    root: import.meta.dirname,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "private-viewer-connection",
        configureServer(server) { server.middlewares.use(connectionMiddleware(connection, base)); },
        configurePreviewServer(server) { server.middlewares.use(connectionMiddleware(connection, base)); },
      },
    ],
    resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") }, dedupe: ["react", "react-dom"] },
    build: { outDir: path.resolve(import.meta.dirname, "dist/public"), emptyOutDir: true },
    server: { port, strictPort: true, host: "0.0.0.0", allowedHosts: true, fs: { strict: true } },
    preview: { port, strictPort: true, host: "0.0.0.0", allowedHosts: true },
  };
});
