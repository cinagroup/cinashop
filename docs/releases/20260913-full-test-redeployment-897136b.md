# 2026-09-13 全量测试重部署（897136b）

按用户“目前线上为测试状态，直接全量重新部署”的要求，将已通过验证的
`897136b4fc33ed22d65abdb2bd40f1c0b55a93c6` 快进合并并推送 main，
从独立 main 工作树重新构建并部署 API、PC、Admin、H5、Supplier、Kefu 六应用。

商城：https://shop.cinaseek.ai；后台：https://cinashop-admin.pages.dev。
五个 Pages Functions 均重新编译上传；相同静态文件由 Cloudflare 去重。
控制面于 05:18 UTC 确认五端均为 production/main、精确源 SHA、success，
Worker 新版本 `f203772c-3c05-42a7-869f-12976f6a3409` 承接 100% 流量。
上一版本 `0e2a8ca8-b9ed-4686-a44f-b774568b31bb` 及历史 Pages 部署保留。

05:17 UTC 的 17 项只读冒烟检查全部通过，五端入口脚本线上/本地 SHA-256 一致。
检查包含初始化、商品读取、工作人员接口匿名拒绝和 CORS；不代表登录、购物、支付完整验收。

精确源提交的 [Actions 34737696153](https://github.com/cinagroup/cinashop/actions/runs/34737696153)
已 11/11 成功；合并 main 后同源自动复跑
[34739769626](https://github.com/cinagroup/cinashop/actions/runs/34739769626) 后续已确认 11/11 成功。
Wrangler dry-run 成功；774 个打包输入不包含审计脚本、测试或未提交的索引迁移。
CLI dirty 警告仅来自独立发布工作树内未跟踪构建目录，受跟踪源码无差异。

使用 Cloudflare/Wrangler 技能核对现有目标、dry-run、keep-vars 发布及控制面验证。
本次没有清库、执行数据库迁移、安装线上运费协议或索引，也没有替换密钥、Hyperdrive 凭据。
现有队列和定时任务继续启用；App 与小程序不属于此次六个线上应用发布范围。

仅删除已合并并成功发布的 `codex/shipping-lifecycle-capacity-20260913` 本地及远端分支引用，
提交仍在 main。尚未完成全套验证的索引工作完整保留在
`codex/shipping-lifecycle-indexes-20260913`，不纳入此次发布。
相邻 JSON 保存部署 ID、资源哈希和冒烟检查结果。
