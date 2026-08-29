import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

const apiProxyTarget = process.env.CINASHOP_API_PROXY_TARGET
  ?? "https://cinashop-api.cinagroup.workers.dev";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 本地开发代理到 Workers (部署后走同源 /api)
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/adminapi": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
      "/kefuapi": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
