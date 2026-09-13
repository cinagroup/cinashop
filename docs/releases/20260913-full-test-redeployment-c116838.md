# 2026-09-13 全量测试重部署（c116838）

已将 `c116838b21324a7f3f7a72debced2772ad9adbf6` 快进合并并推送 main，
从独立 main 工作树重新构建和部署 API、PC、Admin、H5、Supplier、Kefu 六应用。
五个 Pages Functions 均重新编译上传；相同内容的静态资源由 Cloudflare 去重，
不是跳过构建或沿用旧部署。

商城：https://shop.cinaseek.ai；后台：https://cinashop-admin.pages.dev。
Cloudflare 控制面确认五端均为 production/main、同源 SHA、success，
Worker 新版本 `0e2a8ca8-b9ed-4686-a44f-b774568b31bb` 承接100%流量。
旧版本 `fdb8a977-0a3a-41fb-90ce-aa77a871f90b` 保留。

03:38 UTC 的17项只读冒烟检查全部通过，五端首页/入口资源正常，
入口脚本的线上与本地 SHA-256 全部一致。公开初始化、商品读取、
工作人员接口匿名拒绝及商城 CORS 检查通过；不代表登录、购物、支付等完整业务验收。

精确源提交的 Actions [34734746988](https://github.com/cinagroup/cinashop/actions/runs/34734746988)
已11/11成功；合并 main 自动触发的同源运行34735685981在记录时仍进行中。
Wrangler dry-run 通过；773个打包输入不含审计脚本或未提交的性能优化。
已注册的运费安装器包含在包内，但本次未执行数据库迁移，也未安装线上运费协议。

使用 Cloudflare/Wrangler 技能进行目标核对、dry-run、keep-vars发布和控制面复核。
未清库、替换密钥或修改 Hyperdrive 凭据，现有队列和定时任务继续启用。
CLI dirty警告仅来自独立发布工作树内未跟踪的构建目录；受跟踪源码无差异。

已删除运费注册及触发器交互两个已合并分支的本地/远端引用，
提交仍保留在 main。含未完成修改的容量优化分支完整保留，不纳入发布。
完整部署标识、入口资源哈希及检查结果见相邻JSON记录。
