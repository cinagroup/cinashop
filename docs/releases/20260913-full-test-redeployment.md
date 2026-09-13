# 2026-09-13 全量测试环境重新部署

后续终态复核：main@d391e7b 的 Actions34730887286 已 completed/success，11作业全部通过。
下面“仍运行”保留为实际发布时的状态；本结果不外推到后续 ba0df78 安装环境修复。

源提交 `d391e7b14a5372e35b677f477d127ceb57eb9283` 已合并推送 main。
01:35–01:38 UTC，API、PC、Admin、H5、Supplier、Kefu 全部重新构建并发布。
Worker `3bd4a6d5-7d18-465e-aada-ef9ae947f8e2` 占流量100%；五端 Pages
控制面均确认 production/main、同源SHA、success，Functions 一并编译上传。
17项只读线上检查全部通过，五端入口脚本的线上/本地 SHA-256 一致。

商城保持 https://shop.cinaseek.ai，后台保持 https://cinashop-admin.pages.dev。
使用 Cloudflare/Wrangler 发布检查流程，执行 dry-run、keep-vars 及控制面复核。
764个 Worker 输入没有审计/候选模块；新增运费候选没有安装到线上。
未清库、运行SQL迁移、替换密钥或Hyperdrive凭据；既有队列/定时保持，历史部署保留。
源码 clean；CLI dirty 警告仅来自未跟踪 Worker 构建目录，Pages metadata dirty=false。

本地运费相关206项、双类型及原样结算262项复跑均通过，隔离库/schema/角色余量均0。
先前 b452f62 的 CI 因结算测试 afterEach 清理数据库超过10秒失败，未修改断言或超时阈值。
本次源分支 Actions34730797973 和 main Actions34730887286 在发布记录时仍运行，
不把本次测试发布表述为完整CI或登录/购物/支付等正式业务验收通过。

完整部署ID、哈希、检查结果见相邻 `full-test-redeployment-d391e7b-20260913.json`。
本记录放在根 docs/releases，以免仅文档推送取消正在执行的 main 代码CI。
