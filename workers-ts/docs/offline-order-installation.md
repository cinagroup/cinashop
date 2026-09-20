# 线下收银受控安装与协议权限

2026-09-20，本地候选，未部署、未操作生产数据库。此次接入的是独立维护入口，
不是在请求、Worker 启动或付款重试时自动建表。后续同日已补入编号迁移、完整 ORM
及 277 表目录注册，见[正式注册与空 ORM 完成保护](offline-order-registration.md)；
本文下半部分保留独立安装器阶段的验证记录，不能据此关闭 FE-003F。

## 结构合同

`offlineOrderCatalog.ts` 仅查询 PostgreSQL 16 目录，不读取订单、用户余额、
支付入口或凭据内容。检查 7 张新表、10 个函数及 10 张依赖表的 27 个组件。
凭据表覆盖字段、默认值、约束、索引、触发器、维护所有权、ACL、RLS、规则、
继承、持久性及内部触发器是否启用。函数核对完整定义、固定 search_path、
SECURITY DEFINER 属性及执行权限；同名重载也会导致拒绝。

共享旧表检查全部字段、约束、索引，以及属于本协议的触发器，不将其他业务的
触发器或共享表权限宣称为已完成审计。列按名称、索引按完整定义比较：外部及
内嵌历史迁移将 `user.replace_order_num` 追加在末尾，ORM 则先声明该字段，
物理 attnum/indkey 因此不同，但命名字段和逻辑索引相同。新凭据表仍检查列位置。
不会在目标数据库上自动学习或接受新的指纹。

| 状态 | 安装行为 |
| --- | --- |
| `fresh` | 十张依赖表满足基线，七表及十函数全无；一次性安装六段候选 SQL |
| `v1` | 全部定义与权限符合当前合同；重复执行不重建对象或改写记录 |
| `orm-pending` | 精确完整 ORM 裸结构；普通 install 拒绝，仅显式 complete-orm 在七台账全空时补装保护 |
| `drift` | 缺少依赖、局部/旧版/不匹配的 ORM、域约束或结构/所有权/权限漂移；拒绝执行 |

安装采用根数据库事务、READ COMMITTED、read-write、public/pg_temp、origin
复制模式和 row_security=off；启用的 DDL event trigger 会使安装拒绝。
语句、锁、事务空闲上限分别为 30 秒、1 秒、5 秒，保留调用者更严格的值，
事务结束后恢复会话设置。与其他证据安装器共用事务级维护锁 `(731611,0)`，
然后按固定顺序对十张依赖表、已有七张凭据表取得 ACCESS EXCLUSIVE NOWAIT 锁。
因此需协调维护窗口，不能当作无锁在线变更。

锁后及提交前重新检查目录。安装会扩展 `payment_callback_event` 和
`payment_reconciliation_case` 的 domain CHECK，并创建三条共享表索引；
任何迟后失败均与新表、函数、触发器一起回滚。不会修补既有 ACL、覆盖函数、
补造历史凭据，或自动迁移不完整的候选版本。完整候选可保留已有记录并重复核验，
但结构合格不代表所有既有业务数据或历史支付事实已经得到认证。

## 显式维护入口

由运维安全设置 `OFFLINE_ORDER_MAINTENANCE_DATABASE_URL`，不要把口令写入命令
历史。入口不加载 `.env`，不回退到 DATABASE_URL、运行账号或 Hyperdrive 配置。
必须提供精确数据库名和独立 LOGIN；远程连接要求验证 TLS，URL 查询选项/片段拒绝。

在 `workers-ts` 下：

```text
node node_modules/tsx/dist/cli.mjs scripts/offline-order-maintenance.ts inspect <expected-database> <runtime-role>
node node_modules/tsx/dist/cli.mjs scripts/offline-order-maintenance.ts install <expected-database> <runtime-role> --confirm-install
node node_modules/tsx/dist/cli.mjs scripts/offline-order-maintenance.ts complete-orm <expected-database> <runtime-role> --confirm-install
```

这些是待发布运维合同，不是生产执行记录或新的生产授权。inspect 使用只读事务。
退出 0 表示 `v1` 且本协议权限就绪，2 表示不完整，1 表示失败；异常只输出固定摘要，
不输出连接串、SQL 或凭据。提交响应丢失后应 inspect，不能盲目重试或删表回滚。

## 权限边界

维护入口只追加七表的 SELECT/INSERT、dispatch 的五个状态/入口字段 UPDATE，
以及 `ooa_lock_pricing()` EXECUTE。不授予 DELETE、TRUNCATE、表级 UPDATE、
其他触发器函数 EXECUTE 或修改身份字段的权限。

指定运行角色及其传递角色路径不得拥有维护/超级用户、建库/建角色、复制、
BYPASSRLS、public CREATE、复制模式 SET 等能力。NOINHERIT 不被当作阻止
SET ROLE 的充分条件。已有超额对象权限会拒绝安装，不由维护命令默默撤销。

`protocolPrivilegesReady` **仅指以上线下收银对象权限**，不代表完整应用可运行。
用户、支付公共表、资金流水、配置读取和相关序列仍需独立授权及验收。
HTTP 测试由真实安装器提供协议权限；同日后续增量将共享权限整理为统一的只返回 SQL 的合同，
并增加[实际运行连接只读预检](offline-runtime-permissions.md)。安装器的协议权限测试仍独立保留，
不把共享合同执行成功或本地测试通过当作完整生产角色验收。

## 验证与剩余工作

新增原生 PostgreSQL 测试覆盖首次/完整候选/已付款凭据重复、结构及权限漂移、
迟后索引冲突回滚、所有依赖锁、默认权限污染、真实非所有者 LOGIN、继承角色、
事务模式、临时表遮蔽、CLI 确认/身份/脱敏，以及完整外部和内嵌前置迁移。
原 workerd/JWT/本地 Hyperdrive HTTP 测试改为调用受控安装器及授权入口。

首轮 38 项中 36 项通过，两个完整前置迁移检查发现上述物理列序差异；定向目录
比对确认并修正逻辑指纹。初次类型检查另发现测试夹具返回类型混用，已改用
类型化数据库查询。未通过删掉约束、接受目标库自报指纹或跳过用例处理失败。
扩大回归另发现旧支付宝派发断言缺少上一轮新增的 `quit_url`；签名验证已通过，
现补充完成/退出地址都精确绑定原单的断言，未更改支付实现或任何业务超时。

最终验证分两次完成，不能把中间的 90/91 当成全绿：

- 受控安装 **38 项**、真实 workerd/JWT/本地 Hyperdrive HTTP **19 项**、
  原生 PG/workerd **7 项**，合计 **64 项**通过；同轮派发 26/27，整轮 316.24 秒。
- 修正旧断言后的完整派发回归 **27/27** 通过，126.88 秒；最终相关覆盖共 **91 项**。
- 运行器命令边界 **51/51** 通过，11.01 秒；主及 runtime-test 两套 TypeScript
  检查退出 0，最后断言变更后主类型再次退出 0。最终测试无 `.only` 或 `.skip`。

本轮七个隔离集群依次为 `.cache/finance-postgres-V6fXbf`（53158）、
`TWDUYB`（53180）、`PvBwtE`（65322）、`OpPNP7`（54916）、`MxESc9`（59538）、
`9LoRDU`（55831）、`Y99d2b`（57909），后六项同样带 `finance-postgres-` 前缀。
全部运行器报告测试库/角色残留 0 并停止；逐个独立 `pg_ctl status` 为退出 3，
PID/引导口令文件不存在。最终七端口监听 0，可信 PG/workerd 进程 0。
保留已停止集群的诊断目录，没有递归删除目录。

本轮没有生产连接、生产数据或图片/缓存修改，也没有暂存、提交、推送或部署。
原九项暂存内容保持不变，checklist 仍为 **240 已完成 / 164 未完成 / 404 总项**。

上述独立安装阶段之后，正式编号迁移/ORM/目录清单注册及显式空 ORM 保护完成流程
已有[同日增量](offline-order-registration.md)；不把已有裸表数据假定为可信历史。还需完整应用/真实生产角色、旧候选
版本处置、真实商户域名与 Provider、原生设备、零元/安全关闭/退款、CI 和协调发布。
回滚必须保留不可变支付证据，不得通过删除凭据表恢复旧写入方式。

本轮 PostgreSQL 技能用于最小权限、短事务及固定锁序；Workers 技能用于保持
维护 DDL 与请求运行路径分离。本机 Workers 类型为 5.20260828.1，没有新增绑定。
参考 [PG16 LOCK](https://www.postgresql.org/docs/16/sql-lock.html)、
[PG16 CREATE FUNCTION](https://www.postgresql.org/docs/16/sql-createfunction.html) 及
[Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
