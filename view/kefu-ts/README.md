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
- 如需切换后端，在 Pages 环境设置 `WORKERS_API`；若不使用 Pages Function，可在构建时设置 `VITE_API_BASE`。

当前未实现的二维码/微信登录、订单、退款、商品、游客会话和 ERP 写入入口保持关闭；不要仅在前端补按钮绕过服务端迁移门禁。
