import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const apiProxyTarget = process.env.CINASHOP_API_PROXY_TARGET
  ?? "https://cinashop-api.cinagroup.workers.dev";

export default defineConfig({
  plugins: [vue()],
  test: { exclude: [...configDefaults.exclude, "scripts/kefu-workbench-runtime.test.cjs"] },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
    proxy: {
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
    chunkSizeWarningLimit: 1000,
  },
});
