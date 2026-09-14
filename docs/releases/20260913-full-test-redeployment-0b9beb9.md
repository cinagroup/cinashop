# 2026-09-13 六端全量测试重部署（0b9beb9）

按用户“目前线上的为测试状态，直接全量重新部署”要求，将已提交候选
`0b9beb9fbaf7e1df747d46bb523555d7cc71a6a1` 快进合并并推送 main，
在独立、干净的 main 工作树重新构建并发布 API、Admin、PC、H5、Supplier、Kefu。
本地 18 项尚未验收的正式回执迁移改动未纳入本次发布，也未执行线上 SQL。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布证据

2026-09-13 15:17、15:18 UTC 两轮控制面及只读冒烟均成功。
五个 Pages 均为 production/main、精确源 SHA、success，Functions 全部重新发布。
Worker 版本 `ae1ab2be-50b8-451b-b5df-21b98eff79b0` 承接 100% 流量，
部署 ID 为 `0a1e9c28-46c8-4d41-b24b-27c7e8433189`。

| 应用 | Pages 部署 ID |
| --- | --- |
| Admin | 35d09c1f-0452-42e1-8644-cf3333fafb06 |
| PC | aa518a73-b6cb-45bf-99b5-e6b7d74f97b1 |
| H5 | 57241934-bb94-4165-aea0-7e3b7de65bcc |
| Supplier | 664dc08f-50c8-4e4d-9dcc-1eb36e8c850a |
| Kefu | 05513e17-01e8-4dec-922c-004b21857186 |

两轮均 17/17 通过：五端 HTML/入口 JS、API 健康、同源代理、公开商品读取、
匿名权限拒绝及 CORS。五端入口资源线上/本地 SHA-256 全部一致。
完整结果及首轮记录见相邻 `full-test-redeployment-0b9beb9-20260913.json`。

## 构建与 CI

六端重新构建、Worker 双类型检查和 dry-run 全部通过。
781 个 Worker 打包输入不含测试、审计或未完成的回执迁移安装器。
既有 PURE 注释和大 chunk 告警未阻断构建；未升级依赖或兼容日期。
复用依赖前核对六份锁文件内容一致（忽略 CRLF/LF 差异）。

本机精确候选回归 343 项通过、零失败/跳过，报告 SHA-256 为
`1aba76c8630ca6f36953c439421e6e34d7b8d5e243bf15ebafa17845fa1ea835`。
[候选 CI 34763819911](https://github.com/cinagroup/cinashop/actions/runs/34763819911)
已 completed/success，11 个作业全部成功，精确 headSha 为 0b9beb9。
[main CI 34764831865](https://github.com/cinagroup/cinashop/actions/runs/34764831865)
收尾记录时仍 in_progress，同一 headSha；未取消、重跑或冒称通过。

2026-09-14终态追记：main CI34764831865已completed/success，精确headSha仍为0b9beb9；
该成功仅对应已发布版本，不能套用于后续正式回执迁移候选。

## 保留与边界

按照 Cloudflare/Wrangler 技能执行已安装 CLI 参数核验、dry-run、keep-vars 发布及
控制面复核；依据[官方 Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/commands/)
和本机 4.122.0 帮助。未清空数据库或 R2/KV、执行 SQL 迁移、修改密钥、Hyperdrive 或域名。
既有队列与定时任务继续运行。旧 Worker `306c6f07-48b0-4a0f-a8c4-796054e45c69`
和旧 Pages 部署保留可用于回滚，未演练回滚。

已删除完整合并的远端 `codex/shipping-create-replay-20260913`；对应提交仍在 main 可恢复。
本地分支改名为 `codex/shipping-create-replay-migration-20260913`，18 项未提交迁移改动
原样保留且没有推送；旧 detached 工作树和原始报告未删除。

本次发布源包含尚未接入 HTTP 的持久回执引擎；它不会让现有创建接口自动具备跨刷新幂等。
正式 ORM/迁移、强制请求键入口和恢复 UI 仍未完成。本次只完成全量测试发布与只读冒烟，
不等于登录、下单、支付等真实业务验收。Checklist 仍为 240 完成／164 开放／404 总项。
本发布记录为后续文档提交，不改变线上源版本 0b9beb9。
