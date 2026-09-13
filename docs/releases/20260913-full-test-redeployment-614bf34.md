# 2026-09-13 全量测试重部署（614bf34）

按用户“目前线上的为测试状态，直接全量重新部署”的要求，提交测试隔离修复，
合并已完成的审计分支并推送 main，以 `614bf34cafeb7a2b0e9d307b8c1f9f518d350f2f`
重新构建并发布 API Worker、PC、H5、Admin、Supplier、Kefu 六个应用。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

08:32 UTC 控制面核实 Worker `932cb018-2a26-442c-b01a-b7328f19bd3d`
承接 100% 流量；五个 Pages 均为 production/main、精确源 SHA、success。
五端 Functions 全部重新编译上传，同内容静态资源由 Cloudflare 去重。
08:31 UTC 的 17 项只读检查全部通过，五端入口脚本本地/线上 SHA-256 一致。
检查涵盖页面、初始化、商品读取、匿名工作人员接口拒绝及 CORS，
不等同登录、下单、支付验收。

五端构建、Worker dry-run、两套 TypeScript 检查及源码密钥扫描通过；
777 个 Worker 打包输入不含测试/审计脚本。
砍价和测试实例隔离扩展回归在本机专用 PostgreSQL 16.15、maxWorkers=3 下
36 文件 / 589 项通过，零失败、零跳过。此前 64 项定向验证为其子集，不叠加计数。
新增的测试独立数据库和旧 finance_test schema 在运行结束后均为零残留。

测试修复保留业务规格 advisory lock 和同一实例内真实多连接冲突，
仅把不同 finance 测试实例从独立 schema 改为受进程所有权校验的独立数据库。
已复现跨 schema 锁污染使合法新建返回 400；但旧 main CI 未保存响应消息，
不能据此断言它就是旧故障的唯一原因。

08:33 UTC：前置 e71138b 的 [Actions34747048162](https://github.com/cinagroup/cinashop/actions/runs/34747048162)
11/11 成功；本次 main 的 [Actions34747816178](https://github.com/cinagroup/cinashop/actions/runs/34747816178)
仍在运行（七作业成功，目录及两个单元分片进行中），不记作完整 CI 通过。

使用 Cloudflare/Wrangler 技能核对配置、dry-run、keep-vars 发布和控制面状态。
未清库、执行数据库迁移、安装线上运费协议/索引或修改密钥、Hyperdrive、域名绑定。
既有队列和定时任务继续启用，旧部署版本保留，未做回滚演练。

两个本地已合并分支及已有的 shipping-restricted-route-runtime 远端分支已删除；
finance-fixture-advisory-isolation 分支未曾推送。全部提交保留在 main。
本次干运行构建产物移至本机临时目录保留，旧 detached 发布工作树未动。
发布时 CLI dirty 警告仅来自未跟踪构建目录，受跟踪源码与提交一致。
详细部署 ID、原始报告路径/哈希、验证状态见相邻 JSON；迁移 checklist 未标完成。
