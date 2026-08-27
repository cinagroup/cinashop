import { defineConfig } from "vite";
import uni from "@dcloudio/vite-plugin-uni";

const apiProxyTarget = process.env.CINASHOP_API_PROXY_TARGET
  ?? "https://cinashop-api.cinagroup.workers.dev";

export default defineConfig({
  plugins: [uni()],
  server: {
    port: 5174,
    // 本地 H5 开发代理到 Workers
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
