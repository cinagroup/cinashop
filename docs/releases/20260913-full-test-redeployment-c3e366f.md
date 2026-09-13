# 2026-09-13 全量测试重部署（c3e366f）

按用户“目前线上的为测试状态，直接全量重新部署”要求，从已推送的 main
`c3e366f589ab980e58aee146f4f3b3bc4f357fbc` 重新构建并部署 API、PC、Admin、
H5、Supplier、Kefu 六个应用。商城为 https://shop.cinaseek.ai，
后台为 https://cinashop-admin.pages.dev。

2026-09-13 06:41 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success；
Worker 版本 `62a1c336-9cc6-423c-8895-eb358066a829` 承接 100% 流量。
历史部署保留，前一 Worker 版本为 `f203772c-3c05-42a7-869f-12976f6a3409`。

06:40 UTC 的 17 项只读冒烟全部通过，五端入口脚本线上/本地 SHA-256 一致。
覆盖首页、初始化、商品读取、工作人员匿名拒绝和 CORS，不等同于登录、购物、支付全流程验收。
五端 Functions 均重新编译上传；相同静态文件由 Cloudflare 去重。

全部六个应用本次重新构建成功；PC 构建内 98 项认证测试及 7 项图片测试通过。
Worker dry-run 成功，774 个打包输入无测试、审计脚本或未验证的索引安装器。
发布工作树受跟踪源码无差异，CLI dirty 警告仅来自未跟踪 build-release 目录。
应用代码与 [已 11/11 成功的 897136b CI](https://github.com/cinagroup/cinashop/actions/runs/34739769626)
一致；c3e366f 只增加两份此前发布记录，本次没有声称 c3e366f 新跑全套 CI。

使用 Cloudflare/Wrangler 技能核实目标、dry-run、keep-vars 发布与控制面验证。
初次 whoami 网络失败，设置进程级 IPv4 优先后认证成功，没有更改凭据。
没有清库、执行数据库迁移、安装线上运费协议或索引，也没有修改域名、密钥及 Hyperdrive。
现有队列和定时任务保持启用。原生 App 与小程序不在本次六个线上应用发布范围。

索引分支 CI 34741866997 整体失败；其目录/容量 job 成功不代表整体通过。
该分支及未提交的规则防护工作完整保留并排除在本次发布之外，未删除任何分支。
相邻 JSON 保存新部署 ID、资源哈希、检查结果及范围边界。
