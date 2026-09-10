# 已付订单保护：运行身份权限预检

此预检用于迁移清单 A3k11c 的发布准备，不安装0150、不授予权限、不修改业务数据，也不替代整个发布验收。它同时检查 `current_user`、`session_user` 和本后端 `pg_stat_activity.usesysid` 记录的连接身份。管理员的 `SET ROLE` 或 `SET SESSION AUTHORIZATION` 都不能据此冒充独立低权限登录；无法读取实际连接身份时不通过。

## 执行方式

在 `workers-ts` 目录执行 `npm run audit:paid-runtime-permissions`。必须事先通过受控的秘密注入方式设置 `PAID_RUNTIME_AUDIT_DATABASE_URL` 为拟验收的运行身份连接。不要把凭据写入仓库、命令参数、审计报告或聊天。

默认只允许loopback目标；远端还要求显式设置 `PAID_RUNTIME_AUDIT_ALLOW_REMOTE=1`。这只是执行目标确认，不代替组织的生产访问授权。脚本不读取通用 `DATABASE_URL`、`.env` 或自动发现Hyperdrive，不会因缺少专用变量而连接其它数据库。

| 退出码 | 含义 |
| --- | --- |
| 0 | 本文定义的权限检查全部通过 |
| 1 | 检查完成，但存在权限缺口或需人工审查的能力 |
| 2 | 目标配置无效、未确认远端，或检查无法完成；不得按通过处理 |

输出只有固定检查名、布尔值和失败检查名，不输出连接URL、角色名、SQL、异常原文或凭据。数据库检查在独立 REPEATABLE READ／READ ONLY 事务中执行，语句／锁／空闲事务分别限于5／1／5秒，保留更严格的会话设置；连接超时5秒。不是事务总时限承诺。

## 检查合同

检查同时考虑上述三个身份直接拥有、立即继承、可SET切换及具ADMIN OPTION而可进一步授予的角色。对可达角色的高权限属性采用保守拒绝策略；这不是对所有PostgreSQL权限组合的完备证明。

- 目标schema、普通user／store_order表及保护函数必须存在。这里只检查必要对象存在，不验证完整触发器定义。
- 不允许可达角色带SUPERUSER、CREATEDB、CREATEROLE、REPLICATION、BYPASSRLS，或具有受检查的服务器写文件／执行程序角色。
- 不允许控制目标数据库、schema、两张表或保护函数的所有者角色。
- 不允许在目标schema／数据库CREATE，也不允许在两张表上TRIGGER或TRUNCATE。
- 不允许设置／ALTER SYSTEM配置 `session_replication_role`，当前复制角色也不得为replica。
- 可执行的非系统schema SECURITY DEFINER函数须人工审查；即使函数实际上无害，也不自动豁免PUBLIC EXECUTE。系统前缀按字面 `pg_` 识别，不能用未转义的LIKE模式排除普通pgx命名空间。
- 当前身份至少需要目标schema USAGE、订单SELECT／INSERT／UPDATE、用户SELECT及用户任意列UPDATE。这只是累计消费协议的基础权限，不是完整商城所有功能的GRANT清单。

保护函数保持SECURITY INVOKER。真实数据库验证表明，即使渠道入账本身不更新用户余额，函数中的用户行锁仍需要UPDATE权限；仅SELECT会使付款事务整体拒绝。对测试用户表显式授予 `UPDATE(now_money)` 后，渠道入账可以正常完成，无须把运行角色提升为所有者或改为SECURITY DEFINER。完整余额、积分、退款及其它业务仍应按实际访问的表／列单独授权。

## 仍需完成的发布门禁

`ready=true` 只代表以上权限范围在检查时通过：

- 运行时 `CheckoutPaidOrderAuthority` 另行校验保护源码、触发器、表列／主键、RLS、复制角色、隔离级别和本事务写锁；本命令不替代它。
- 需要在正式Worker实际身份与Hyperdrive路径复核。专用本机角色、直接PostgreSQL连接和合成支付证据不能代表正式环境。
- 本命令尚未自动串联进 `deploy`；发布流程必须显式消费失败退出码，并完成其它迁移／CI／业务门禁。不得只凭本命令退出0发布。
- 另一个维护管理员仍可在预检之后替换函数、停用触发器或改变授权。必须安排受控维护窗口和权限变更审计；本工具不声称阻止管理员。
- 其它系统／扩展高权限函数、整个应用的最小权限清单、全部活动与账务角色组合、真实支付和回滚发布仍需各自验证。任何未知项不自动视为通过。

本机验证：最终22项权限测试全部通过，真实独立LOGIN覆盖业务／锁／拒绝路径；两个预检漏检先复现后修复，过程及其它回归的版本边界见[审计记录](../audit/brokerage-paid-runtime-permissions-20260910.json)。这不是生产验收记录。

依据：[PostgreSQL 16权限](https://www.postgresql.org/docs/16/ddl-priv.html)、[GRANT与角色选项](https://www.postgresql.org/docs/16/sql-grant.html)、[权限检查函数](https://www.postgresql.org/docs/16/functions-info.html)、[pg_stat_activity连接身份](https://www.postgresql.org/docs/16/monitoring-stats.html)、[LIKE通配符与字面前缀](https://www.postgresql.org/docs/16/functions-matching.html)。
