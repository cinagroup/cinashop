# 线下消费建单准入候选

2026-09-19，本地候选；未注册迁移、未接公开建单/支付路由、未部署。完整收银支付仍未完成，本文件不把未支付订单当作收款成果。

2026-09-20 当前接线更新：已新增[鉴权建单、支付及只读详情 HTTP](offline-order-http.md)，进入实际路由装配；受控安装、页面和正式环境仍未完成。下文“未公开接线”保留准入阶段历史，不再作为当前总状态。

后续增量：已新增[正金额余额结算候选](offline-order-balance.md)，覆盖原子扣款/账单/积分/节省及重放。下文建单批次结果按历史保留；provider、公开路由与受控安装依然开放。

## 为什么需要独立建单

对照相邻 PHP 仓库的 `OtherOrderServices::createOrder` / `paySuccess`、`OtherOrderJob` 及当前 TS 支付服务：

- 线下消费属于 `other_order.type=3`，不应触发会员套餐延期。当前 `findMembershipOrderByOrderId` 和 `applyMembershipPayment` 仅接受 type=0/1；候选测试直接验证 type=3 被这两个服务拒绝，**没有声称验证了完整 provider 回调**。
- 回调和主动查单持久域目前只有商城、充值和会员。不能只把 type=3 订单导入会员支付分支。
- `other_order.order_id` 历史非唯一，没有保存顾客确认金额或重复创建请求的持久身份。普通的“生成订单号然后插入”不足以保证丢响应后重试不会重复收银。

## 已实现的内部写入

`OfflineOrderAdmissionService.admitOfflineOrder` 接受受信调用方提供的 UID、UUIDv4 请求键、原始金额、顾客确认金额、渠道和服务器预分配订单号。当前没有 HTTP 适配器；鉴权/请求头/跨刷新客户端持久化仍须接线。

1. 写入边界只接受有界十进制**字符串**，不接受 JSON 数字的浮点近似；原始金额为正且不超过 99999999.99，确认金额须至少0.01元。金额/渠道别名规范化后计算请求摘要；拒绝原型属性伪渠道。
2. 进入拥有事务，设置不放宽现有配置的 5 秒语句和 1 秒锁等待上限，锁住当前有效顾客行。
3. 按 `(uid, request_key)` 查不可变准入凭据。相同规范化请求返回原订单；同键不同金额/渠道返回业务 409。配置或会员后续变更不把原请求变成新订单，已付/取消标志也不会释放键。
4. 首次创建取得配置/权益共享锁，重新以同一 SQL 快照计算价格。确认金额不同则返回权威金额和 409，整笔无写；不信任客户端折扣。
5. 原子插入未支付 type=3 订单、准入凭据及 `create_offline_scan_order` 状态。原始金额、实付、会员资格及适用百分比冻结；不扣余额、不延长会员、不写赠分/节省账本或发送外部请求。

数字 0 的“无会员报价”哨兵不用于建单金额。非会员应确认原价。2026-09-20 用户明确要求至少0.01元，因分币截断得到的 `"0.00"` 不再准入，客户端伪报一分也被锁后计价拒绝；不向上取整。历史零元记录仅保留读取，不能付款或赠分。当前规则和验证见[最低应付政策](offline-order-http.md#最低应付政策2026-09-20-最新决定本地未部署)。

目前订单号内部格式为 `xx` 加 30 位十六进制；测试使用加密随机标识。生产的预分配器、客户端请求键保存和公开 DTO 适配尚未接线。新凭据约束其订单 ID/订单号唯一；共享旧 `other_order` 仍可能出现历史重复号，重放明确检查歧义，最终 provider 解析也必须这样做。

## 数据库与权限边界

候选模型位于 `src/models/candidates/offline_order_admission.ts`，没有导出到生产 schema 入口。`OFFLINE_ORDER_ADMISSION_SQL` 只由测试显式安装，未加入 `MigrationService`，没有 `IF NOT EXISTS`、替换旧对象、回填或运行时 DDL。缺表时整个准入失败，不自动安装。

- 凭据包含顾客/请求键、摘要、原订单主键/订单号、版本、原价/实付、会员是否有效、折扣百分比、渠道和数据库语句时间。
- CHECK 校验价格公式、范围、UUID/摘要/版本/渠道；外键禁止删除对应顾客和订单的物理身份。
- 触发器拒绝修改、删除或截断凭据。首次凭据写入对原订单取得行锁并核对 type/UID/金额/渠道/初始状态；后续原订单准入字段不可变、不能物理删除。普通会员历史行仍可按既有方式更新/删除。
- **这不是支付终态保护。** `paid`、支付方式/交易号等留给后续受控支付状态机，凭据存在本身不证明已经收款。
- 第一轮原生 PG 的 14 项失败证明：`UPDATE(id)` 列权限不足以取得表级 SHARE 锁。因此增加无参数、固定目标的 `ooa_lock_pricing()` 能力函数；只能以 READ COMMITTED 对两张明确配置表取得 SHARE NOWAIT，不能动态指定表或修改配置。业务角色只获得该函数 EXECUTE，不获得配置表 UPDATE/DELETE/TRUNCATE；另一个触发器函数撤销 PUBLIC EXECUTE。
- 函数使用固定 search_path 和显式 public 表；测试业务账号为独立 LOGIN，无超级用户/建库/建角色/RLS 绕过。部署时仍须验证函数所有者、ACL、RLS、触发器完整性和目录漂移，不能直接运行候选 SQL 当作已验证的升级器。

PG16 的表锁权限要求已与[官方 LOCK 文档](https://www.postgresql.org/docs/16/sql-lock.html)及本机实际错误核对。共享锁会覆盖这两张表所有写入，生产争用和超时仍需验收。

锁顺序为顾客→配置/权益→新订单。重放不锁住旧订单，以免反转后续支付的订单→顾客顺序；新订单未提交前对其他会话不可见。测试用原生 `pg_blocking_pids` 证明同键竞争、用户锁后重新计价及配置编辑等待，不用睡眠时长冒充阻塞证据。

## 验证与限制

测试在每项独立的本机 PG16 数据库中用当前完整 ORM 创建表，然后显式安装候选 DDL；不是生产注册迁移验证。角色按表/列/函数显式授权；故意误授 UPDATE/DELETE/TRUNCATE 的反例证明约束仍拒绝破坏准入身份。迟后状态表 INSERT 权限失败须回滚订单和凭据，重试才可产生一份记录。

```powershell
# workers-ts 目录；只使用本机隔离运行器
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-admission.test.ts test/offline-order-quote.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/response-cache.test.ts test/route-parity-audit.test.ts test/order-member-savings.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

第一轮 86 项中 72 过、14 失败，失败点是表锁权限而不是报价金额；原 67 项 HTTP/JWT/PG 报价仍通过。修复不提升生产权限，不改既有商城计价锁。最终原生 PG16.15 两文件 **93 项**（建单候选 26、报价 67）零失败/跳过，耗时 155.84 秒；五文件 **108 项**相关回归以及主/运行时双类型、运行器语法和作用域空白检查全部通过。批次存在重叠，不相加为独立用例总数。

本轮 `finance-postgres-IPWGBO:56779` 和 `finance-postgres-NWRBfY:49162` 已由运行器核验夹具数据库/角色剩余为零并停止。独立获准的主机只读检查确认两集群停止、无 PID/启动口令文件、两端口监听和可信测试 PostgreSQL 进程均为零；保留诊断目录。生产路由、MigrationService 和模型总入口无本候选引用，原九个暂存路径未变。

## 下一步仍然是完整支付链路

优先复用本准入证据接入余额支付事务、资金账单、type=3 支付终态、节省金额及赠分的幂等效果，再扩展 provider 意图、回调和主动恢复的独立域。还需明确支付期限与零元结算、推广员规则、受控 DDL/目录/ACL 注册、历史读取、公开请求/角色/页面及真实 Redis/Hyperdrive/provider 验收。旧 PHP 赠分实际是截断金额比例后加会员权益值，不能根据“双倍”注释擅改为相乘。

请求键不释放、建单成功不等于付款、provider 未知结果不能重建另一个订单，是后续接线必须保留的边界。整体合同见[报价及支付域缺口审计](offline-order-quote.md)。Checklist 仍为 240/404，SUP-001、FE-003F 保持开放。

Workers/PostgreSQL 技能影响了本候选的无外部 I/O 短事务、固定有界能力函数、金额编码、锁后权威读取及独立最小权限测试。未访问生产、修改图片、暂存、提交、推送或部署。
