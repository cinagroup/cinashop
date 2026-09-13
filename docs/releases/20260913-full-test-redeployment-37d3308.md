# 2026-09-13 全量测试重部署（37d3308）

按用户要求，将三个迁移增量分支快进合并并推送 main，以
`37d330829718543a3cc7469d2edc3eb10174a994` 重新构建、部署 API Worker 和 PC、H5、Admin、Supplier、Kefu 五端。

商城：https://shop.cinaseek.ai

后台：https://cinashop-admin.pages.dev

10:31 UTC 控制面确认五个 Pages 均为 production/main、精确源 SHA、success 且 Functions 已部署；
Worker `89286bbd-d8ca-4db1-a952-6f51bc2f6427` 承接 100% 流量。
10:30 UTC 的 17 项只读检查全部通过，五端入口本地/线上 SHA-256 一致。
验证涵盖页面、初始化、商品读取、匿名工作人员接口拒绝及 CORS，不等同登录、下单、支付验收。

五端本次重新构建、Worker dry-run 和双类型检查通过；780 个打包输入不含测试/审计脚本。
核验此前精确应用源的本机回归报告：303 项通过、零失败/跳过，报告 SHA-256 见相邻 JSON。
五端 Functions 全部重新编译上传；同内容静态文件由 Cloudflare 去重，不代表跳过部署。

## CI 与审计修正

发布后前置 [Actions 34751343686](https://github.com/cinagroup/cinashop/actions/runs/34751343686)
最终 9 个作业成功、2 个失败。第一单元分片 2751 项通过、1 项失败、零跳过：
新增嵌套编辑器没有同步至页面盘点快照，`admin-frontend-inventory.test.ts:104` 精确清单断言失败；汇总随之失败。
其余分片、目录迁移、workerd、五端构建及密钥扫描成功。原始失败报告保留，不记为 CI 全绿。

用既有生成器同步盘点，仅目标清单增加编辑器；页面目录 Vue 数 58→59、非直接路由组件 5→6，
独立路由业务组件仍为 53，不能把嵌套编辑器计算为新增独立迁移页面。
本机切换 main 后还复现审计 AST 取出的多行 handler 保留 CRLF、与 Linux 快照不同；
审计脚本现统一哈希和解析输入的换行，新增 LF/CRLF/CR 三个回归，保留完整确定性相等断言。
修正后本机 3 文件 31 项通过、零失败/跳过。修正仅涉及审计工具、快照、测试和文档，应用源码/配置/前端与已发布提交一致。
修正已作为 `ce8739d5955fc2325842856da267fb4cb8149f1b` 推送 main，双类型检查通过；
[修正后的 Actions 34752548223](https://github.com/cinagroup/cinashop/actions/runs/34752548223) 后续已核实终态 success，11/11 作业成功。
main 首轮 Actions 34751911259 被既有同分支 concurrency 策略自动取消；不是通过，也非人为重跑掩盖失败。
已用 git diff 确认修正提交的 Worker 应用源码、Wrangler 配置和全部前端与已部署 37d3308 一致。

## 范围及清理

使用 Cloudflare/Wrangler 技能核对原目标、干运行、keep-vars 发布和控制面状态。
没有清空数据库、执行 SQL 迁移、安装线上运费协议/索引，未修改密钥、Hyperdrive 或域名绑定。
现有队列和定时任务继续启用；旧 Worker/Pages 版本保留，未进行回滚演练。

三个本地及远端分支已在确认完整合并后删除：
`codex/admin-shipping-grouped-editor-20260913`、`codex/admin-shipping-list-snapshot-20260913`、
`codex/supplier-pages-configuration-acceptance-20260913`。全部提交保留在 main，可从历史恢复分支。
旧 detached 发布工作树及原始验证报告未删除。迁移清单仍 240 完成／164 开放／404 总项，A3k13 不因测试部署而关闭。

详细部署 ID、入口资源哈希、CI 原始报告摘要和边界见相邻 JSON。
