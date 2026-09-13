# 2026-09-13 全量测试重部署（d66cd19）

`d66cd192e66b87e7cf2a7eb9db36bf171e1377bc` 已快进合并、推送 main。
API、PC、Admin、H5、Supplier、Kefu 六应用已从独立 main 工作树重新构建并发布，
五端 Functions 均编译上传。Cloudflare 控制面确认 Worker 新版本
`fdb8a977-0a3a-41fb-90ce-aa77a871f90b` 占流量100%，五端 Pages 均为
production/main、同源 SHA、success。

商城：https://shop.cinaseek.ai；后台：https://cinashop-admin.pages.dev。
02:29 UTC 的17项只读检查全部通过，五端入口脚本线上/本地 SHA-256 一致。
检查覆盖首页、资源、公开初始化/商品读取、工作人员接口匿名拒绝及商城 CORS，
不代表登录、购物、支付等完整业务验收。

使用 Cloudflare/Wrangler 技能执行 dry-run、keep-vars、目标核对和发布后控制面复核。
未清库、运行数据库迁移、替换密钥或 Hyperdrive 凭据；队列/定时配置保持，历史部署保留。
764个 Worker 打包输入不含审计/候选模块，尚未提交的运费正式注册修改未进入本次发布。
这些修改完整保留，其本地322项回归和双类型检查成功，但不外推为发布验收。

代码等价版本 ba0df78 的 Actions34731627125 已11/11成功；与本次源仅有两份发布文档差异。
本次 main 的 Actions34732805548 在记录时仍运行，不宣称已经通过。
CLI dirty 警告仅来自未跟踪 Worker 构建目录；发布源码无差异，Pages metadata dirty=false。
完整部署标识及边界见相邻 `full-test-redeployment-d66cd19-20260913.json`。

