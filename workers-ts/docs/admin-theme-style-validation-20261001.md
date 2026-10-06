# 主题风格本地验证记录（2026-10-01）

本批状态为 `local_candidate_verified_not_released`。主题设置及真实客户端消费已完成本地验证，没有 commit、push 或 deploy，也不代表生产发布。

主题是 `system_dise` 中 `color_change/type=3` 的六个固定枚举方案，每套包含六个实际 token。Admin、公开接口与签到预览使用共同读取权威；GET 不初始化，首次创建及损坏值修复须显式保存。管理采用独立 `theme_settings.view/manage`、CAS、actor-bound UUID 与原子回执，确定拒绝和版本冲突仅使用匹配的实际 HTTP 400/409 proof。八表真实 ORM、非 owner LOGIN 夹具只验证现有生产权限交集，不是生产数据库或完整 commissioning。

客户端覆盖 96 个 `ThemePage` 宿主及六套 token；DIY `toneConfig=0` 跟随全局，`toneConfig=1` 保留 authored 颜色。财务、状态、错误、disabled 与独立 custom 颜色不被全局主题覆盖。

本批实际结果为：

- 256 个唯一测试通过，分为 65 个真实 SQL/HTTP 和 191 个 pure/runtime/static，0 skipped。失败尝试和重试日志保留，但重复执行不重复计数。
- 浏览器 22/22 组通过。六个故意 HTTP 错误保留在 raw 证据；unexpected、page、route、unknown 错误均为 0。记录了 12 个 SDK 警告和 1 个 Canvas2D 警告。
- 四项类型检查、四项构建均通过。MP/APP 构建资源不是设备验证或签名安装包；浏览器合成 API 结果与真实 SQL 结果分开计证。
- 本批没有重跑旧支付、退款 PG；原有 proof 保持。当前消费由 checkout 33 个用例及 type4 浏览器场景证明，不据此宣称支付 provider、退款或真机全链路重新验证。

入批基线的 5,693 个条目由 2,585 source、141 reference、2,967 raw 构成；10 份历史构建的 2,549 个文件逐哈希保持。三个新 PG data 目录已删除，九个新自有端口由最终 reader 核对；清理范围只涉及本批自有资源。

首次验收 writer 在写入前拒绝未声明的 `IntegralSharePoster.vue` 变化：原两份前端 freeze 的 120 文件遗漏了这一个海报组件。原 freeze 与失败 writer 均保留，另用 `theme-poster-source-supplement-20261001.json` 绑定旧积分批的不可变 before、当前源码/capture、三种实际 Uniapp 构建的组件消费语义及 H5 canvas 实际价格颜色。该补件在构建后采集，不能宣称遗漏文件在当时的 120 文件清单中，或其完整源码字节已在构建前采集；实际构建消费证明与采集时间分别记录。

后端原 17 文件 freeze 使用 raw 摘要，主验收 source/reference 则使用 LF 归一摘要。第二次 writer 在写入前拒绝混用这两种口径；17 个文件的实际 raw 均与原 freeze 一致，两个原有 CRLF 文件解释了差异。`theme-backend-final-source-receipt-20261001.json` 另绑定 17 个不可变 raw 副本，原源码和原 freeze 未改写。

当前路由库存为 2,170，其中 API 1,126、Admin 769。Admin 有 108 页、581 个调用、612 个调用变体。设置分布按台账原顺序为 23/24/24/5，全 Admin 为 89/114/63/8；Checklist 的 246/158/404 计数保持不变，不能将本地 candidate 当作 production release。

最终冻结及计数以 `admin-theme-style-acceptance-20261001.json` 为准，独立核验结论以 `theme-style-independent-verification-final-20261001.json` 内实际记录为准。本文不提前宣告尚未落盘的冻结或独立核验成功；失败尝试、重试、原始日志及其哈希边界均应保留。
