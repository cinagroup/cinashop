import { defineConfig } from "vite";
import uni from "@dcloudio/vite-plugin-uni";
import { resolve } from "node:path";
import { createPostcssConfigurationGuard, createPostcssDirBoundary } from "./scripts/postcss-dir-boundary.cjs";
import { createCommunityPageAliasPlugin, createCommunityVideoAppPagePlugin } from "./scripts/community-page-alias.cjs";

const apiProxyTarget = process.env.CINASHOP_API_PROXY_TARGET
  ?? "https://cinashop-api.cinagroup.workers.dev";
const postcssBoundary = createPostcssDirBoundary(resolve(__dirname, "src"));

export default defineConfig({
  plugins: [createCommunityPageAliasPlugin(resolve(__dirname, "src")), uni(), createCommunityVideoAppPagePlugin(resolve(__dirname, "src")), createPostcssConfigurationGuard(postcssBoundary)],
  css: { postcss: { plugins: [postcssBoundary] } },
  server: {
    // Override DCloud's host:true/fs.strict:false defaults. Vite 5 still has
    // unresolved advisories: keep this development server off shared networks.
    host: "127.0.0.1",
    cors: false,
    fs: { strict: true },
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
