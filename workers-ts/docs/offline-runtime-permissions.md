# 线下收银实际运行连接权限预检

2026-09-20，本地候选；未连接生产、改线上授权或部署。新图可读确认保留。

## 本次交付与边界

`auditOfflineOrderRuntimePermissions(db)` 使用实际根数据库连接，在同一个
REPEATABLE READ / READ ONLY 事务内检查受保护目录及有效权限。
它不是维护账号对一个角色名的模拟，不调用安装器、不改授权、序列或业务数据，
也不调用计价锁函数、支付平台或缓存。主 Worker 请求路径没有新增 DDL 或审计入口。

报告固定标记 `scope: offline-cashier-collection-v1`，`ready` 只覆盖此合同：
报价、准入建单、余额支付、外部支付派发、本人详情/方式/历史读取、已验签回调收款及系统查单恢复。
同时始终返回 `completeApplicationVerified: false`、`businessDataVerified: false`。
它不能证明真实付款、历史行可信、全 Worker 权限或正式发布就绪。
管理员人工对账操作、其他业务域、清理保留策略和关闭/退款不在该合同内。

## 可审阅的授权合同

`offlineOrderRuntimeContract.ts` 统一原来 HTTP、workerd 与签名回调夹具各自维护的权限清单。
`offlineRuntimeGrantPlan(role)` 只返回 SQL 文本，不连接、执行或安装任何对象。
角色名必须是最多 63 字节的明确 ASCII 标识符，输出引用角色名与固定 public 表。
应用此计划需要另行审阅的维护操作；本次仅在自建隔离测试库中执行。
计划是追加授权，不撤销其他功能的权限；本协议定义的危险权限由预检拒绝，不能因为执行过计划就认为安全。
`ready` 不表示账号只能拥有计划中的权限；对共享表不是完整 ACL 白名单，其他功能所需权限仍需各自审计。

| 对象类别 | 合同 |
| --- | --- |
| 读取 | 7 张离线台账 + 14 张依赖业务表，合计 21 表 SELECT |
| 追加 | 7 张台账 + 8 张共享业务表，合计 15 表 INSERT |
| 共享状态机 | callback event、outbox、reconciliation case 三表 UPDATE |
| 有限列更新 | user 的 uid/now_money/integral/is_promoter；other_order 的 id/paid/pay_type/pay_time/trade_no；wechat_user.id；dispatch 原五个状态/入口字段 |
| 序列 | 7 个明确绑定所属表/主键列的序列，仅 USAGE，不授予 UPDATE/setval |
| 函数 | 仅 `public.ooa_lock_pricing()` EXECUTE |

共享回调表 UPDATE 沿用既有状态机合同，不宣称所有共享字段都已缩减到全应用最小权限。
计划不授予 DELETE、TRUNCATE、TRIGGER、对象/数据库创建、角色管理、授权转授或序列重置能力。
七张协议台账仍禁止表级 UPDATE，只有 dispatch 的明确五列例外。
维护安装器的 `protocolPrivilegesReady` 仍只是协议对象权限；发布前另用实际连接预检。

## 检查方法

- 仅接受根数据库对象及 PostgreSQL 16，拒绝从嵌套事务调用。
- 核验七表、十函数和十依赖的 27 个既定目录指纹；裸 ORM、缺失、触发器/函数/约束漂移均不自动修复。
  目录的维护所有者标志不作为运行账号通过条件，改为单独拒绝可达对象所有权。
- 同时考虑 current_user、session_user 和 pg_stat_activity 中当前 backend 的真实 LOGIN，
  因而维护账号 SET ROLE / SET SESSION AUTHORIZATION 不能伪装成独立受限连接。
- 检查可直接继承、切换或通过 ADMIN 获得的角色，并查询这些角色的有效对象权限。
  中间角色继承的序列等权限也参与检查，不能只检查末端角色的直接 USAGE/SET 谓词或 NOINHERIT。
- 拒绝超级用户、建库/建角色、复制、绕过 RLS、文件/全数据预定义角色，以及对象所有权、
  schema/数据库 CREATE、TRIGGER/TRUNCATE、台账改写、序列重置、复制模式设置、授权转授等能力。
- 拒绝受检业务表 RLS、规则、继承/分区，以及启用的 DDL 事件触发器。
  七个序列必须存在并绑定正确 public 表/列；必需表、列、序列和函数权限必须齐全。
- 检查非系统命名空间中可执行的 SECURITY DEFINER routine，仅允许目录指纹已验证的计价锁函数。
  这是保守的发布条件：已有其他受控能力也可能被拒绝，需要明确审阅，不能自动加白名单。
- 使用事务局部 search_path/row_security 和有界超时（statement ≤ 5 秒、lock ≤ 1 秒、idle ≤ 5 秒），
  保留调用者更严格的超时，退出后恢复原会话设置。报告只含范围、布尔检查和固定失败键，不含角色、连接串或业务行。

这是指定时间点的只读目录/权限快照，不锁住后续管理员变更，也不认证全部共享触发器或任意数据库扩展。
若预检报错/超时，应视为未完成，不能当作通过。

## 显式 CLI

```text
node node_modules/tsx/dist/cli.mjs scripts/audit-offline-runtime-permissions.ts <expected-database> <expected-runtime-role>
```

仅读取 `OFFLINE_RUNTIME_AUDIT_DATABASE_URL`，不自动加载 `.env`，不回落到普通 DATABASE_URL
或维护凭据。URL 的数据库与账号及连接后的 current_database/current_user/session_user 必须精确匹配参数。
禁止 URL 查询参数、片段或额外命令参数。远程连接还必须显式设置
`OFFLINE_RUNTIME_AUDIT_ALLOW_REMOTE=1`，采用 verify-full TLS；本机环回连接用于隔离测试。
不得把密码写在命令行或报告中。上述使用说明不代表已运行远程预检或获得新生产写权限。

- 退出 0：此范围的权限/目录检查通过。
- 退出 1：完成预检但有固定失败项；不执行修复。
- 退出 2：参数、身份、版本、连接或执行错误；只输出固定脱敏提示。

直连 CLI 不能替代实际远端 Hyperdrive 的身份验证。本次额外在测试专用、鉴权保护的 GET `/audit`
通过 workerd → 本地 Hyperdrive → 独立非所有者 LOGIN 运行同一预检；该入口不在生产路由或部署配置中。

## 本地验证

初轮新增原生 PG16.15 测试 **27/27** 通过（131.88 秒）；补充两种混合角色路径后
完整 **29/29** 通过（136.77 秒）。混合路径是假设验证，不是一次已发生的红测修复：
直接末端 USAGE/SET 均为 false，但中间角色仍可继承序列 UPDATE，现有有效权限检查成功拒绝。

覆盖每个声明的必需权限逐一撤销/恢复、17 类过大权限或目录漂移、真实 LOGIN 与维护身份伪装、
SET/INHERIT/ADMIN、跨 schema/PUBLIC 定义者能力不被执行、遗漏表不修复、局部设置恢复、
根事务边界及 CLI 参数/远程显式选择/输出脱敏。用并发 member_right 写锁证明未调用计价 SHARE 锁函数，
审计前后目录快照不变。

纯授权合同 **14 项**与运行器边界 **53 项**，合计 **67/67** 通过（4.73 秒）。
最终联合回归 **55/55** 通过（214.72 秒）：权限预检 29 项、实际鉴权 HTTP 19 项、
workerd / 本地 Hyperdrive 7 项。HTTP 使用统一合同后复核真实 LOGIN；workerd 测试通过
独立 backend 的鉴权只读入口运行同一预检，未授权请求被拒绝，预检前后业务计数不变且支付出口调用为零。
主项目与 runtime-test 两套类型检查通过。

已有签名回调流水线改用同一合同，测试前核验真实受限连接；补齐测试库 dispatch 对象后，
**32/32** 通过（149.62 秒），包含微信/支付宝/小程序签名入口、错误身份/金额/签名拒绝、
持久 outbox、并发提交可见性、入账后中断、迟到冲突与原证据恢复。生产付款代码未改动。
这是实际控制器/原生 PG 与本地独立签名、KV/Queue 传输替身，不冒充真实 Provider、远端队列或回调 workerd E2E。
最后夹具变更后主类型检查再次通过。本轮不同用例合计 **154 项**（55 + 32 + 67），
不将初轮 27/29 的重复运行累加，也不宣称全仓测试或远程 CI 已通过。

## 清理与保留证据

四个自建集群均由运行器确认自建测试库/角色残留 0 并停止，随后独立 `pg_ctl status` 均退出 3：

| `.cache/finance-postgres-` 后缀 | 本机端口 |
| --- | --- |
| `ZbQjgK` | 55414 |
| `Ok8W9t` | 60129 |
| `8DfqYr` | 58755 |
| `gOVDEH` | 51578 |

四处 postmaster.pid / bootstrap-password 均不存在，四端口监听为 0；可信 PostgreSQL/workerd
测试进程及路径不明的同名原生进程均为 0。测试期间删除了自建合成库/角色，未删除用户或生产数据；
已停止集群的诊断目录保留，没有递归删除目录。原九项暂存的路径与增删行数复核不变。

## 仍开放

完整生产角色、真实远端 Hyperdrive / Provider / 商户配置 / 原生设备、旧候选版本处置、
零元政策、安全关闭退款、CI 与协调发布仍未验收。FE-003F 不关闭，checklist 仍为
240 已完成 / 164 未完成 / 404 总项。原九项暂存内容保留；无暂存、提交、推送或部署。

PostgreSQL 技能用于最小权限与有界只读事务，Workers 技能用于保持维护/预检与业务热路径隔离。
Firecrawl 读取 PostgreSQL 16 官方权限函数文档，核对 SET/USAGE/ADMIN、列权限和序列权限语义；
参考 [PG16 权限查询函数](https://www.postgresql.org/docs/16/functions-info.html) 和
[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
