# 2026-09-13 全量测试重部署（2b6469d）

按用户“线上为测试状态，直接全量重新部署”要求，将会话边界修正快进合并并推送 main，
以 `2b6469d9135e7771940ea6f83719f0f27d4a3175` 重新构建部署全部六个应用。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布与验证

11:29 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success 且 Functions 已部署。
Worker `47d7d28c-4fe2-4039-9ba7-0f50390e0e01` 承接 100% 流量，部署 ID
`73e3629c-6b06-4069-bfa7-0cfd01768dc6`。

| 应用 | Pages 部署 ID |
| --- | --- |
| Admin | fd0b2277-d019-43a4-9448-901c571c46b3 |
| PC | bd7aad6e-18a7-458e-bc6d-d95b102625b2 |
| H5 | b1817c1f-1e13-4319-b58e-434d1dfad55d |
| Supplier | b8490bbd-7c70-4c9a-86ac-b95cd1f3c97b |
| Kefu | 226dc2fd-54f4-458e-b76e-8ffc22eabe26 |

五端本次重新构建、Worker dry-run 和双类型检查通过；780 个打包输入不含测试/审计脚本。
Admin 上传 68 个新增静态文件，其余同内容资源由 Cloudflare 去重；五端 Functions 全部重新编译上传。
17 项只读检查全部通过，五端入口本地/线上 SHA-256 一致，包含初始化、商品读取、匿名工作人员接口拒绝和 CORS。
这不是完整登录、下单、支付或真实角色验收。本轮没有修改应用代码。

此前精确候选的本机回归原报告已重新读取核验：353 项通过、零失败/跳过；SHA-256
`8b76d44b7948684438aa4ef57fdf5d595a2f2181cc978161a1eff39dbf3d5b13`。
11:29 UTC [候选 CI 34753660067](https://github.com/cinagroup/cinashop/actions/runs/34753660067)
已有九个作业成功，第一单元分片仍运行，汇总未结束。
推送触发的 [main CI 34754263804](https://github.com/cinagroup/cinashop/actions/runs/34754263804) 也仍运行。
没有重跑/取消这些任务，不能把本机通过或先前提交 CI 成功外推为本次 CI 全绿。

采集器初次误用不存在的 `is_functions` 字段而返回验证失败，虽然该次 17 项冒烟已全过。
只读检查部署详情后改用真实 `uses_functions` 字段，最终控制面与冒烟验证均通过。
初始证据保留于 `C:/Users/cina/AppData/Local/Temp/cinashop-release-2b6469d-collector-initial.json`；
最终部署 ID、哈希、CI 快照和边界见相邻 JSON。

## 清理与边界

使用 Cloudflare/Wrangler 技能核对原目标、dry-run、keep-vars 发布和控制面状态。
未清空数据库、执行 SQL 迁移、安装线上运费协议/索引，未修改密钥、Hyperdrive 或域名绑定。
现有队列和定时任务继续启用；旧 Worker `89286bbd-d8ca-4db1-a952-6f51bc2f6427`
和旧 Pages 部署保留，未进行回滚演练。

确认全部提交在 main 后，删除 `codex/admin-shipping-session-boundary-20260913` 本地及远端分支，
以及无独有提交的 `codex/shipping-default-template-contract-20260913` 本地空分支（未曾推送）。
提交保留在 main，可从历史恢复分支；旧 detached 发布工作树和原始验证报告未删除。
本轮发布记录为文档跟进，不要求再部署同一应用代码。

默认运费模板 ID 1 禁止删除合同尚未实现；该候选空分支没有改动可发布。
迁移清单仍为 240 完成／164 开放／404 总项；A3k13 和正式生产验收不因测试部署而关闭。
