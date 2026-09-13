# 2026-09-13 六端全量测试重部署（7dc52ed）

按用户“目前线上的为测试状态，直接全量重新部署”要求，将供应商运费快照候选快进合并并推送 main，
统一以 `7dc52ed9b84e0294b277dc1ffff85dbce55d6c72` 重新构建、发布 API 和五个前端。
该版本包含供应商运费编辑版本冲突保护和共享有界快照；本轮没有新增应用功能。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

## 发布结果与验证

13:29 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success，Functions 已部署。
Worker 版本 `59b1194b-75ee-4243-b51c-652987d6a5e5` 承接 100% 流量，部署 ID 为
`9219666d-187e-4806-895a-90137903a133`。先发布 API，再发布前端。

| 应用 | Pages 部署 ID |
| --- | --- |
| Admin | 113610d7-99cc-4341-a733-c00a4b421aef |
| PC | ce3a5b82-7c5f-486b-819c-31d51da8481e |
| H5 | b8a0b121-0ea6-46db-9d68-6e44b0e38158 |
| Supplier | 5fd0dd76-0b16-4979-8197-29b43dd485ad |
| Kefu | e034ce50-de7c-4085-a718-4a191f6986d0 |

五端本机重新构建、Worker 双类型检查和 dry-run 全部通过；781 个打包输入不含测试或审计脚本。
Supplier 上传 20 个新增静态文件；其他同内容资源由 Cloudflare 去重，五端 Functions 均重新上传。
已有 PURE 注释和大 chunk 构建告警未修正或隐藏。本轮未升级依赖或兼容日期。

首次只读冒烟 16/17 通过，后台入口检查出现 20 秒 TimeoutError；原始结果保存在相邻 JSON 的
initialSmokeAttempt。不更改代码、不放宽阈值，完整复测 17/17 通过，五端入口资源本地/线上 SHA-256
全部一致。后台入口额外三次复核均 HTTP 200、资源 HTTP 200 且哈希相同，首页及资源合计耗时
8067、8249、9592 ms。复测成功不能证明首次超时根因已查明。

此前精确候选本机 447 项专项回归为零失败/跳过，原报告哈希重新核验：
`042df4fc27ec20e1cb39f0d549593be31da00af08b9677a43f6ba426fb7ce105`。
[候选 CI 34759108922](https://github.com/cinagroup/cinashop/actions/runs/34759108922)
已 completed/success，11 个作业全部通过。推送 main 自动触发的独立
[main CI 34759671112](https://github.com/cinagroup/cinashop/actions/runs/34759671112)
发布采集时仍运行，未重跑、取消或冒称成功；两者均针对精确源 SHA 7dc52ed。

## 清理与边界

使用 Cloudflare/Wrangler 技能核对现有项目、dry-run、keep-vars 发布与控制面验证；发布命令依
[官方 Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/commands/workers/)及本机帮助核实。
未清空数据库、执行 SQL 迁移或安装线上运费协议/索引；未修改密钥、Hyperdrive 或域名绑定。
既有队列和定时任务继续启用。旧 Worker `c5c2b98b-ab9a-4f70-b7c7-037e9c315cb6` 和旧 Pages
部署保留以备回滚，未执行回滚演练。

按此前授权，仅清理已经完整合并的 `codex/supplier-shipping-snapshot-conflict-20260913`
本地和远端分支引用；提交保留在 main，可从历史恢复。不删除旧 detached 发布工作树和原始报告。
本文件为发布后的文档记录，不改变线上应用版本。

本次是测试环境部署验收，不等于完整登录、下单、支付及真实角色验收。
迁移清单仍为 240 完成／164 开放／404 总项，没有因发布关闭剩余迁移要求。
