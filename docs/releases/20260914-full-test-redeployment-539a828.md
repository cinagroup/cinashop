# 2026-09-14 六端全量测试重部署（539a828）

已按用户“目前线上的为测试状态，直接全量重新部署”授权，将已提交候选
`539a828c7d2c45068771f384cfd94efd1027f148` 快进合并并推送 main，
从独立干净工作树重新构建并发布 API、Admin、PC、H5、Supplier、Kefu。
本地未完成的创建/恢复 HTTP 接口改动未纳入发布。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布验证

00:49 和 00:50 UTC 两轮只读冒烟均 17/17 通过。
五个 Pages 均为 production/main、精确源 SHA、success，Functions 全部重新发布。
五端入口资源本地/线上 SHA-256 一致。静态资源内容未变，Cloudflare 复用了已有资源，
但五个部署和 Functions 均为新发布，不是只刷新页面。

Worker 版本 `53b92512-583f-4453-b6d4-ed75daed6849` 承接 100% 流量，
部署 ID 为 `d4bf33d6-1dde-42f7-b731-6dff657b8b80`。
全部部署 ID、时间、哈希及逐项结果见相邻 JSON。

按照 Cloudflare/Wrangler 技能核对本机 CLI 参数、配置 schema、dry-run、
keep-vars 和控制面结果；参数参考
[官方 Workers 部署命令](https://developers.cloudflare.com/workers/wrangler/commands/workers/)及
[Pages 部署命令](https://developers.cloudflare.com/workers/wrangler/commands/pages/)。
未升级依赖或兼容日期。锁文件一致后复用依赖；Worker 双类型检查及五端构建通过，
786 个打包输入不含测试或审计文件。

## CI 失败及修正（不可报告全绿）

发布前核验同一候选本地 337 项回归全部通过，本次范围回归另有 20 项通过；
候选远端 CI 当时仍有一个分片运行。

[候选 CI 34793000186](https://github.com/cinagroup/cinashop/actions/runs/34793000186)
随后以 failure 结束：分片 1 为 2867 通过、1 失败、0 跳过。
原始报告确认唯一失败是 `kefu-sequence-runner.test.ts:81`：
新增正式回执表后初始 ORM SQL 为 1091 条，旧断言仍为 1090。
不是已定位的线上业务断言失败。其他九个独立作业成功，聚合门禁因该分片失败而失败。

已仅将精确计数更新为 1091 并解释新增表；保留三十种漂移拒绝、
事务/锁/回滚等断言和所有超时。专用本机 PostgreSQL 16 复核 11/11 通过、零跳过。
失败和修正报告哈希记录在 JSON；未取消或重跑失败候选。
[main CI 34793782371](https://github.com/cinagroup/cinashop/actions/runs/34793782371)
在记录时仍 in_progress，同为 539a828，不能算作通过。
测试修正与本发布记录属于后续提交，不改变已发布运行时代码；新 main 提交的 CI 需独立验收。

## 保留与未完成项

未清库、执行 SQL 迁移、重置 R2/KV、修改密钥/域名/Hyperdrive。
新增回执迁移代码虽已发布，但没有执行线上安装，强制请求键入口及恢复 UI 仍未完成。
现有队列和定时任务继续运行。旧 Worker 版本
`ae1ab2be-50b8-451b-b5df-21b98eff79b0` 及旧 Pages 部署保留可回滚，未演练回滚。

已使用精确 SHA 租约删除完整合入 main 的远端
`codex/shipping-create-replay-migration-20260913`，提交保留在 main 可恢复。
本地改名为 `codex/shipping-create-http-20260914`，四个已修改源文件、
新共享规则文件和原有审计探针均保留未提交；旧工作树和原始报告未删除。

本次完成全量测试发布及只读验证，不等同于支付、下单或全业务验收；
Checklist 保持 240 完成 / 164 开放 / 404 总项。
