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
    port: 5175,
    // 本地开发代理到 Workers (部署后走 Pages Function)
    proxy: {
      "/adminapi": {
        target: "https://cinashop-api.cinagroup.workers.dev",
        changeOrigin: true,
      },
      "/api": {
        target: "https://cinashop-api.cinagroup.workers.dev",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
});
