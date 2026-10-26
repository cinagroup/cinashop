# Admin 会员套餐目录兼容合同

PHP 基准：`cinashop-php@8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。
`app/controller/admin/v1/user/member/MemberCard.php` 的 `member_ship` 列表不附加启用状态过滤；`view/admin/src/pages/user/grade/type/index.vue` 的状态操作在写入后重新读取目录。停用套餐仍可见，并可重新启用。

## 本次行为

- Admin `/member` 的套餐页使用现有注册路由 `GET /adminapi/member/ship`，显式发送 `page`、`limit=20`、`include_deleted=1`。真实总数驱动分页，刷新保持成功读取的页码。套餐按后端 `sort DESC, id ASC` 排序。
- 最后一页因目录收缩而不存在时，最多追加一次末页读取。读取失败保留上次成功的行、页码与总数并显示重试入口；错误响应不会伪装成空目录。读取有 12 秒期限，旧请求会中止且不能覆盖新页面。
- 启停使用 `POST /adminapi/member_ship/set_ship_status` 的现有 `{id,is_del}` 合同。每次操作结束后读取实际目录；响应丢失时不自动重发写入。操作期间阻止重复点击和旧行回调。
- 套餐页需 `paid_membership.view`（或 manage），编辑与启停需 `paid_membership.manage`。异步完成和保留的操作函数都核对内存与持久化账号、令牌及权限。账号切换、撤权与卸载后不采用旧目录或旧编辑器结果。
- 概览标为“本页启用套餐”，避免将单页启用数量宣称为全站数量。
- 会员记录的套餐筛选仍默认仅含启用套餐，并继续遍历其全部 100 项批次。预览 API 同样区分目录全部状态和默认启用列表。

## 验证边界

真实 Vue SFC 运行回归覆盖超过 100 项的分页、错误恢复、并发读取、重复操作、未知写入结果、编辑器及账号边界。HTTP 数据库回归使用实际 `createApp`、JWT、账号/密码和角色中间件；普通 CI 使用 PGlite SQL，显式本地 runner 使用独占 PostgreSQL 16。该小型夹具完整核对自身四张表和四个序列；不声称是全生产 schema 或独立 LOGIN ACL 证明。

后台 Browser 验收文件 `test/browser/admin-member-packages.acceptance.ts` 使用实际 Admin 生产构建、注册 Worker 路由和独占 PostgreSQL 16。只允许两次对夹具套餐 7002 的启停写入，另有一项明确隔离的 QA 角色撤权设置；每个请求保留实际响应、全夹具状态摘要及资源调用证据。测试登录态由 QA 引导，不覆盖生产登录表单。

本次范围为套餐目录、分页、启停及既有套餐编辑的生命周期边界；卡批次、制卡/兑换、支付、会员权益图标和其他标签页不在本批验收结论内。
