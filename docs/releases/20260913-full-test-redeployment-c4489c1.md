# 2026-09-13 六端全量测试重部署（c4489c1）

按用户“目前线上的为测试状态，直接全量重新部署”要求，将候选快进合并并推送 main，
以 `c4489c18d3e891deaba61373aedc65680641bbf1` 重新构建、发布 API 和五个前端。
该版本包含默认运费模板 ID 1 禁删合同及 CI 单元分片 Admin 依赖安装修正；本轮未改应用代码。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布与验证

12:42 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success，且 Functions 已部署。
Worker `c5c2b98b-ab9a-4f70-b7c7-037e9c315cb6` 承接 100% 流量，部署 ID 为
`5391fa3a-2cf4-4f7d-a736-ab12f181332c`。

| 应用 | Pages 部署 ID |
| --- | --- |
| Admin | 1df3b205-4745-439c-b413-faf6f5da1f04 |
| PC | 626c3043-67c5-4670-86c6-7ce4b0793e17 |
| H5 | c89c19a0-de00-4cef-885a-c145bf22d341 |
| Supplier | 2ab09fdd-8e3d-4502-ba9f-8faf8c8848e1 |
| Kefu | fd75f121-1ba7-49c3-9cbc-0c94df0d83e8 |

五端重新构建、Worker 双类型检查及 dry-run 全部通过；780 个打包输入不含测试或审计脚本。
Admin 上传 68 个新增静态文件，Supplier 上传 20 个；其余同内容资源由 Cloudflare 去重，
但五端 Functions 均重新编译上传。五端入口本地/线上 SHA-256 一致。

首次只读冒烟 16/17 通过，客服匿名接口在 20 秒阈值超时；失败原始输出保留于任务工具记录。
没有更改代码或放宽阈值，完整复测 17/17 通过；额外三次客服匿名接口复核均返回
HTTP 200、业务状态 410000 且无私有数据，耗时分别 1643、1527、1602 ms。
这说明复测时服务正常，但不能据此确定首次超时根因。

此前精确候选本机回归原报告重新读取核验：411 项通过、零失败/跳过；SHA-256 为
`29960cb53d7209871696747ea8032651ba69f57589785a909922137593335170`。
[候选 CI 34756939498](https://github.com/cinagroup/cinashop/actions/runs/34756939498)
已 completed/success，11 个作业全部成功，包括两个单元分片、PostgreSQL 目录审计及汇总。
推送自动触发的 [main CI 34757326726](https://github.com/cinagroup/cinashop/actions/runs/34757326726)
是同源 SHA 的独立任务，发布采集时仍运行；未重跑、取消或冒称该任务已成功。
控制面与哈希详细证据见相邻 JSON。

终态追记：main CI 34757326726 已 completed/success，精确源 SHA 仍为 c4489c1；候选与main均成功。该结论不适用于其后的供应商快照候选。

## 清理与边界

使用 Cloudflare/Wrangler 技能核对原项目、dry-run、keep-vars 发布与控制面验证。
未清空数据库、执行 SQL 迁移或安装线上运费协议/索引；未修改密钥、Hyperdrive 或域名绑定。
现有队列、定时任务继续启用。旧 Worker `47d7d28c-4fe2-4039-9ba7-0f50390e0e01`
及旧 Pages 部署保留，可用于后续回滚；本轮没有执行回滚演练。

仅清理已完整合并到 main 的本轮分支 `codex/shipping-default-template-contract-20260913`
本地及远端引用，提交保留在 main，可从历史恢复。旧 detached 发布工作树和其他原始报告不删除。
本文件为文档跟进，不改变已发布运行时代码，不要求再次部署同一应用版本。

本次为测试环境发布验收，不等于完整登录、下单、支付及真实角色验收。
迁移清单仍为 240 完成／164 开放／404 总项，未因发布关闭剩余迁移要求。
