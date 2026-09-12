# DB-007 提现流水及通知增量发布

2026-09-12 已经明确授权后在线完成：首次applied=true、独立ready=true、第二次applied=false，
四表合计1行的规范化指纹全部一致；临时Worker控制面及公开端点404。
证据见 `../audit/withdrawal-effects-production-20260912.json`；不自动重复执行下面命令。

本次维护只覆盖外部 `0131`、`0132`、`0133`（内嵌 `0135`–`0137`）的最终合同，
不是全量建库，不触发提现、支付、通知发送或真实 provider 调用，不修改角色权限。
须先完成 DB-006，并得到本次短时锁表维护授权。

## 确切范围

- `public.capital_flow`：可空 `event_key varchar(128)`，唯一索引 `cf_event_key_uq`。
- `public.order_notification_delivery`：可空 `withdrawal_id integer`，`order_id` 改为可空，
  订单/提现主体互斥且提现 ID 为正的 `ond_subject_ck`，部分索引 `ond_withdrawal`。
- `public.store_order_outbox`：将已知的 5/7/8 项事件白名单扩大到最终 9 项；
  已经是最终白名单时保留，不中途重放旧的较窄 CHECK。
- `public.system_message`：客服专用部分索引 `smsg_staff_inbox`，不更改消息内容。

## 执行与验证

在已配置凭据的 PowerShell7 中，从 `workers-ts` 目录显式运行：

```powershell
./scripts/run-withdrawal-effects-production-migration.ps1 -Apply -VerifyIdempotence
```

默认不执行。随机临时 Worker 的 256 位能力令牌只保留在进程内存，部署 SHA-256 验证值及
10 分钟期限。只支持固定路径、方法和 `0131-0133-withdrawal-effects` 操作头，不接受任意 SQL。
新域名就绪检查只重试无令牌 GET 的 404，最多 8 次；不自动重试任何迁移 POST。
访问边界要求匿名403、错误方法405、缺少操作头400；失败时不会读取或修改数据库。

先做独立只读前检。执行器只接受 PostgreSQL16 普通永久表，无继承/RLS、已验证主键、
确切列类型与已知索引/CHECK 定义，并拒绝启用的事件触发器。四表按固定顺序取
`ACCESS EXCLUSIVE NOWAIT`；任一表占锁立即回滚退出。短事务语句/锁/空闲超时上限5/1/5秒，
保留更严格设置。每表最多10,000行；超限在指纹扫描或DDL前拒绝，不能据此提高阈值直接重试。

持锁记录每表行数和整行规范化 SHA-256，再记录四表汇总。仅把原先不存在的新字段按NULL规范化；
已有字段值始终参与指纹。只执行缺失的增量；后验目录或指纹不符则回滚。独立只读后检成功后，
显式第二次执行必须是 `applied=false`，无DDL且数据不变。输出仅目录状态、行数和指纹，不输出业务行。

## 失败与清理

HTTP503或连接中断代表结果未确认，不等于必然回滚。先独立只读检查，不盲目重发POST。
`finally`只删除本次新建的确切临时 Worker，并确认控制面404；正式API/Pages不被替换。
应用回滚时保留新增列/索引及最终白名单，不DROP已有幂等键，也不收窄可能已有提现数据的约束。
此操作不能替代其余生产结构、运行角色最小权限及真实角色发布验收；不对同时活动的其他特权管理员提供隔离保证。

依据：[PostgreSQL16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)。
