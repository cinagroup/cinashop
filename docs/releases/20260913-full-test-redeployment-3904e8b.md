# 2026-09-13 六端全量测试重部署（3904e8b）

按用户“目前线上的为测试状态，直接全量重新部署”要求，将候选快进合并并推送 main，
以 `3904e8b8c7fc688e21b39055dd26bc878e2377a2` 重新构建并发布 API 和五个前端。
该版本包含供应商会话隔离、过期请求保护和未知写入回执保护；本次没有额外应用代码改动。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布与验证

14:28 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success，Functions 已部署。
先发布 API，再发布五个前端。Worker 版本 `306c6f07-48b0-4a0f-a8c4-796054e45c69`
承接 100% 流量，部署 ID 为 `56cbc9e3-95f2-429f-9827-f0d97a34c33d`。

| 应用 | Pages 部署 ID |
| --- | --- |
| Admin | b6c58abc-0a76-4daf-8499-5bc3839fd952 |
| PC | 4b279896-711c-4a2c-b0a8-265d4d0b5f66 |
| H5 | 9f094d2c-1c9e-4870-abc2-8959243ec324 |
| Supplier | c99a333d-e95c-4529-b0b0-3f38a9d81b08 |
| Kefu | 86fb9f79-cac2-4438-a956-4353e8201716 |

五端重新构建、Worker 双类型检查及 dry-run 全部通过；781 个打包输入不含测试或审计脚本。
Supplier 上传 20 个新增静态文件，其他同内容文件由 Cloudflare 去重；五端 Functions 均重新上传。
既有 PURE 注释与大 chunk 构建告警保留，未升级依赖或兼容日期。

两轮只读冒烟均为 17/17 通过：五端 HTML/入口 JS、Worker 健康、同源代理、公开商品读取、
匿名权限拒绝和 CORS 均符合预期；五端入口资源本地/线上 SHA-256 一致。
首次证据采集器误用不存在的 is_functions，导致整体 verified=false，但该次 17 项冒烟全部通过。
核对部署详情的实际 uses_functions 字段后修正采集器并重新验证，最终 verified=true。
首次完整记录保留在相邻 JSON 的 initialCapture 中；没有修改应用或放宽通过条件。

此前精确候选本机 392 项专项回归零失败/跳过，重新核验报告 SHA-256：
`29043dfdeea8209ae60c32b22a6faedc63e21e765b7537138772d605b311c945`。
[候选 CI 34761689488](https://github.com/cinagroup/cinashop/actions/runs/34761689488)
已 completed/success，11 个作业全部成功。
[main CI 34762472925](https://github.com/cinagroup/cinashop/actions/runs/34762472925)
在本次收尾采集时仍 in_progress，精确 headSha 为 3904e8b；未取消、重跑或冒称通过。

终态追记：main CI 34762472925 已 completed/success，headSha 仍为3904e8b；候选与main均成功。
该结论仅适用于已发布版本，不适用于后续持久回执候选。

## 清理与边界

使用 Cloudflare/Wrangler 技能核对现有项目、dry-run、keep-vars 发布与控制面验证；命令依据
[官方 Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/commands/)和本机 4.122.0 帮助核实。
未清空数据库、执行 SQL 迁移、修改密钥、Hyperdrive 或域名。既有队列与定时任务继续运行。
旧 Worker `59b1194b-75ee-4243-b51c-652987d6a5e5` 和旧 Pages 部署保留用于回滚，未演练回滚。

按此前授权，清理已完整合并的 codex/supplier-shipping-session-boundary-20260913 本地及远端分支，
以及没有独立新增提交的 codex/shipping-create-replay-20260913 本地分支。提交仍保留于 main，
可从历史恢复；不删除旧 detached 发布工作树或原始报告。本文件为发布后的文档记录，不改变线上应用版本。

本次完成测试环境全量部署验证，不等于登录、下单、支付和真实角色全流程验收。
运费创建跨刷新持久幂等恢复尚未实现；迁移清单仍为 240 完成／164 开放／404 总项。
