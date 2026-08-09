import { defineConfig } from "vite";
import uni from "@dcloudio/vite-plugin-uni";

export default defineConfig({
  plugins: [uni()],
  server: {
    port: 5174,
    // 本地 H5 开发代理到 Workers
    proxy: {
      "/api": {
        target: "https://cinashop-api.cinagroup.workers.dev",
        changeOrigin: true,
      },
    },
  },
});
