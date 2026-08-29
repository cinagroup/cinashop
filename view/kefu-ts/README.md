# CinaShop 客服工作台

独立 Vue 3 客服端，只使用 `/kefuapi` 专用身份域，不接受 Admin、Supplier 或用户 token。

## 本地验证

```powershell
npm install
npm run build
npm test
npm run dev -- --host 127.0.0.1
```

开发环境可访问 `/workbench?preview=1` 使用合成数据做 UI 验收；该模式同时要求 Vite `DEV` 和查询参数，生产构建不会启用。

## Cloudflare Pages

- 构建目录：`view/kefu-ts`
- 构建命令：`npm run build`
- 输出目录：`dist`
- 默认由 Pages Function 将同源 `/kefuapi/*`（包括 WebSocket Upgrade）转发到 `https://cinashop-api.cinagroup.workers.dev`。
- 聊天图片经客服身份上传到私有 R2，消息记录仅保存稳定附件路径，历史与实时响应使用短期签名地址；同源 Pages 通过 `/kefuapi/assets/*` 代理取图。
- 如需切换后端，在 Pages 环境设置 `WORKERS_API`。微信 OAuth 必须继续走同源 Pages Function（或同站点自定义 API 域名），否则 `SameSite=Lax` verifier Cookie 不会随回调请求发送；`VITE_API_BASE` 只用于不启用 OAuth 的受控开发/测试。
- 正式 Kefu Origin 必须同时进入 `KEFU_AUTH_ALLOWED_ORIGINS`，并与全局 `ALLOWED_ORIGINS`、Pages 同源 proxy 和微信回调白名单一起验收。

登录、每次认证请求及 WebSocket 心跳/下行都要求客服记录未删除、业务状态和账号状态启用，并要求绑定用户存在且启用；生产当前没有客服记录，因此尚无正向生产证据。

token 与 identity 使用当前标签页的 `sessionStorage`，启动时清除旧 `localStorage` 遗留。刷新保留、新标签页不共享；关闭标签页不代表服务端撤销，退出仍需调用 logout。若服务端撤销失败，本机凭据仍会清除并在登录页明确警告，不会伪报服务端已撤销。该存储不是 HttpOnly，不能抵御同源 XSS。

`view/pc-ts/test/login-flow-mock-server.mjs` 只用于固定合成身份的内存扫码状态机与 OAuth Cookie/state 合同回归，不覆盖真实 JWT、Redis、DO 租约/并发、Hyperdrive、Kefu 状态、Origin/CORS 或微信提供方。

二维码/微信登录及订单、退款、商品、游客会话、ERP 的既有迁移合同已经接入；生产仍因 Kefu 正式 Origin、微信开放平台凭据、客服/微信身份样本和发布验收缺失而保持安全关闭，不能仅靠前端按钮绕过这些门禁。
