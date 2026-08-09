import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

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
        target: "https://cinashop-api.cinagroup.workers.dev",
        changeOrigin: true,
      },
      "/adminapi": {
        target: "https://cinashop-api.cinagroup.workers.dev",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
