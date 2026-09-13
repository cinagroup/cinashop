# 2026-09-13 全量测试重部署（b6dc8cb）

按用户“目前线上为测试状态，直接全量重新部署”的要求，将三个已提交的运费迁移相关分支
合并并推送到 main，以 `b6dc8cb6e68b9e9bc55352632883c1fa87bb797e` 重新构建并部署六个应用。
商城为 https://shop.cinaseek.ai，后台为 https://cinashop-admin.pages.dev；
API、H5、Supplier、Kefu 保持既有地址，未使用已占用的根域名、admin/api 子域名。

07:32 UTC 控制面复核：Worker 版本 `92b2edc3-c487-4059-bc02-c64ee900d4c0`
承接 100% 流量；五个 Pages 均为 production/main、精确源 SHA、success。
五端 Functions 均重新编译上传；同内容静态资源由 Cloudflare 去重。
Admin 首次遇到网络 fetch 失败，查询云端确认没有新部署后重试成功。

五端重新构建、Worker dry-run、两套 TypeScript 检查、密钥扫描全部通过。
777 个正式打包输入不含测试或审计脚本；新的索引迁移注册代码已入包，但未执行线上迁移。
07:31 UTC 的 17 项只读线上检查全部通过，五端入口脚本的本地/线上 SHA-256 一致。
包括初始化、商品读取、工作人员接口匿名拒绝和 CORS，不等同登录、下单、支付验收。

前置规则修复提交 92377df 的 Actions34744193037 已全部成功。
07:33 UTC，源提交 eaa6773 的 [Actions34744845166](https://github.com/cinagroup/cinashop/actions/runs/34744845166)
九个作业成功，单元分片 1 仍运行；main 的
[Actions34745307600](https://github.com/cinagroup/cinashop/actions/runs/34745307600) 自动复跑也仍运行。
不将本次测试发布记作完整 CI 成功或迁移清单完成。

使用 Cloudflare/Wrangler 技能执行配置核对、dry-run、keep-vars 发布和控制面复核。
未清库、执行数据库迁移、安装线上运费协议/索引或变更密钥、Hyperdrive 凭据；
既有队列和定时任务继续启用。旧部署版本保留，未做回滚演练。
受跟踪源码无差异，CLI dirty 警告来自临时工作树内未跟踪的构建目录。

三个发布分支（shipping-lifecycle-indexes、shipping-rewrite-rule-guards、
shipping-route-authorization，均为 codex/ 前缀及 -20260913 后缀）已删除本地及远端引用，
全部提交仍在 main。本机主目录已切回 main；临时发布工作树以 detached 状态保留，
未删除目录、依赖或测试数据。相邻 JSON 保存完整部署 ID、资源哈希及检查状态。

