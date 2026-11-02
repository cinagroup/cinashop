# 后台门店履约分配作者

第39轮在[第38轮不可变存储](store-order-fulfillment-assignment.md)之上接通真实 Admin 作者和 HTTP 协议。平台付款根和财务归属保持 store0，分配只追加履约批准/撤销回执。Manager 分配单发货、前端会话/journal 和完整 Queue/App 首上传仍未接通；全局 `runtime_ready=false`，完整 PHP→TS 迁移未完成。

## 可信配置与实际身份

`Env.ADMIN_FULFILLMENT_ASSIGNMENT_RUNTIME` 接受维护 forward 返回的完整显式 `RuntimeGiftPeerDeclarations`，包括 assignment addon 和五角色声明。配置由可信部署组合注入，不能从 HTTP、DSN 用户名或当前 ACL 推断；缺失或不完整返回 503。本轮没有设置生产绑定、执行安装或部署。

两个前缀 `/adminapi/order/fulfillment_assignment`、`/api/admin/order/fulfillment_assignment` 共用独立 router，主应用在旧 catch-all 前注册。生产 `adminRuntimeAuthMiddleware` 先在普通连接完成 Admin token/实时账号/密码声明/路由权限，再选独立 Admin LOGIN；没有 App/Manager 连接回退。每次业务事务再核对指定数据库、current/session/backend OID、实际受限 Admin、专用完整存储目录、共享维护 try gate 和物理 ACCESS SHARE fence。完整五角色审计属于正式维护/审计，不在每个请求重新运行。

专用检查不是十张既有来源表的完整 owner、全部触发器或财务协议审计。它检查这些表的正式限定名、普通持久表、无 RLS/继承/rule 等边界，并拒绝实际 Admin 拥有对象或 DDL/membership/replication 旁路。普通运行角色不能自行换表 owner；外部维护级来源环境漂移仍须独立维护核对，不能把这里扩张为整个数据库的防篡改证明。

## HTTP 和权限合同

| 方法与后缀 | 行为与权限 |
| --- | --- |
| GET `/review/:id` | `order.view`；只读快照返回当前 head、grant/revoke 分别的 review 来源和 `requires_locked_commit`。不保证最后能写入。 |
| GET `/stores?after=<id>` | `order.manage`；仅有效目标门店，按 ID 游标每页最多 50 条。 |
| POST `/commit` | 路由和新决策均须 `order.manage`；严格 4096 字节 JSON，不允许重复键、额外字段或查询参数。 |
| GET `/receipt/:operationId` | 仅当前登录的原作者读取最小不可变回执；角色移除后仍可恢复，不返回 source。缺失或他人所有均为 unknown。 |

GET 的 HEAD 具有相同只读权限语义。只有精确 receipt GET/HEAD 从通用管理权限恢复，POST/子路径/其他名字不豁免。HTTP commit 在失去 `order.manage` 后仍拒绝；直接 service 的精确原键重放只恢复既有原作者回执，不能追加新决策。所有响应均设 private/no-store；没有 resolve、abandon 或“未应用”的新终态。

请求字段固定为：

```ts
{
  format_version: 1,
  operation_id: UUIDv4,
  kind: 'grant' | 'revoke',
  order_id: positiveInt,
  target_store_id: positiveInt,
  expected_head: { ordinal: nonnegativeInt, operation_id: UUIDv4 | null },
  expected_order_revision: hex64,
  expected_source_hash: hex64
}
```

首次 await 前捕获有界纯数据，拒绝 getter、symbol、稀疏数组、异常原型和类型强制转换。作者、买家、财务 store0、根和 source 由服务器读取。相同 UUID/作者/原内容返回同一回执；换内容返回 409，head/revision/source 已变返回 412。失败事务不预占业务回执；查无记录保持 unknown，不能据此改键重发。

## 锁后作者与来源边界

新决策在真实 RC/RW Admin 事务中持 Admin/role authority barrier，先取得请求互斥，再取 63842 根门和实际根行 `FOR UPDATE NOWAIT`。真实 supplier allocation 使用旧的单参数 advisory，但也在写 family 前锁同一根行，不能声称所有作者都共享 63842。cart/refund/waybill 的 SHARE NOWAIT 表 fence 保护空集合；实际 cart 与目标门店行也锁定，city 冲突使用正式 reader。写后回读保存的 source 和完整链，并复核实时权限；实际来源状态由事务内已有锁保持。使用 SQL 默认时间并回读，尾部检查 SQL 事务未超过 8 秒及会话未到期。沿用现有单语句/锁/idle 限制，8 秒尾验不是全程硬中断或提供方时间证明。

当前 grant 只接受 TS 普通商品的已付款、未发货、未删除平台整根快递：root pid0/store0/supplier0，allocation0或2，没有 child、退款物化分支、未结/完成退款、面单、发货 notice 或同城冲突。完整原购物车 1..200 行、全部初始数量一致，允许真实 type0/1 原库存来源；type1 的 relationId 保留为原值，不代表分配目标。不会查询当前商品/SKU 在售状态来代替旧付款来源，也不改库存、SKU、订单、买家或财务归属。

普通下单与赠品作者都实际保存 `financial_version=checkout-line-finance-v1`。本作者只接受这个正式版本，并严格核对 JSON id/cart_num 与实际行；refund_order_generation、legacy_php_financial_source、未知/缺版本拒绝。最终物理总数量包括赠品。这个检查是格式/身份/数量准入，不重新验证全部财务金额、完整 purchase-origin 或提供方付款；版本字符串和 hash 都不是签名。

私有 source hash 绑定实际根 revision、收件路由值、完整有界 cart 行及原 cartInfo hash，保存的 source 仍只有封闭非路由 cart 投影。历史最小 source 不能重建全部私有 source hash；其真实性依赖受控作者和不可变存储。请求 hash 能从单行保存字段重建，只证明内容一致性。不要称任一 SHA 为密码学授权或原账号付款原证。

完整历史最多 64 项/1 MiB，读65探测溢出，不截断或重开 genesis。作者验证连续 ordinal、previous、根/买家、合法状态转移和请求 hash。grant 可改派到不同目标；同目标不能用新键续批；revoke 后可重新 grant。revoke 只能撤销当前 grant，保留其旧 source/revision/hash/目标；真实发货或根退休后仍能撤销，只要根/买家/store0 身份相符。撤销不会倒退已完成履约；容量耗尽、来源不全和身份矛盾须人工维护，不能现场修复或回填证据。

## 实际验证与失败留存

固定 Node24.14.1、npm11.11.0、自有原生 PG16.14，所有重型检查使用一个外层共享串行锁、单 worker、既有8192堆和每阶段600秒/原case/hook限制。

| 冻结批次 | 实际结果 |
| --- | --- |
| `native-04` | 完整11项通过，123.78秒，8510冻结输入不变，remaining=0/STOPPED。 |
| `types-05` | 最终 Worker unit/runtime 两套通过，199.42/97.93秒，8510输入不变。 |
| `unit-06` | 新输入及既有完整权限两文件33项通过，35.10秒，8509输入不变。 |
| `final-07` | 最终类型/单元两组全部exit0，336.67秒，8506外层输入不变；运行前另核对native-04全部冻结输入无变更。 |

11项通过真实 Admin assisted checkout、RSA/AES 默认 Routine 回调、真实 App payment/paid outbox 消费，然后执行导出 production router 两个 mount 的真实鉴权/独立 Admin session。包括 grant→reassign→revoke、原键重放/409/CAS、真实备注 writer 后412、真实 Admin 发货后撤销、角色撤销后的最小 owner 恢复及他人/缺失 unknown、缺配置/错误实际 LOGIN、根行和空 waybill 表争用、完整作者后的受控 caller-abort 共同回滚、type1 原库存来源，以及真实 AdminFullGiftService 活动产生的 charged2+gift1=totalNum3。

反向来源用例明确使用维护 SQL 改五种 cartInfo 标本并逐次恢复原字节，分别拒绝 refund version、refund marker、unknown version、错误 id 和错误数量；每次均无 assignment 行，最后原请求成功。正向 paid/root/cart/assignment 事实由真实作者生成。caller-abort 仅代理真实外层 transaction 的最终返回，回调仍用真实 SQL/LOGIN，属于明确故障注入。测试有本地 KV/Queue/内部订单 ID/回调传输适配，不冒称真实供应商调用。

`native-03` 原始10项全失败、115.43秒、输入不变、remaining0/STOPPED：首版 guard 把任何 financial_version 都视作退款快照，真实普通与赠品来源均被误拒，未进入分配写入。修正为上述正式版本和行身份检查，新增反例后才有完整11项通过。首轮静态复核漏检此问题，原报告和失败保留，修正后另有独立只读复核；复核者未独立重跑测试，不是完整安全审计。早期unit-01/types-02不代替最终结果，重复执行不累计为新案例。

单元批次的内层清单显式排除未选中的 native 文件；最终外层清单和已通过native-04清单共同冻结该文件，没有并发改动或执行缺口。实现/测试在最终运行后不变；本文件和阶段记录之后补齐，最终14个提交文件另做逐文件秘密扫描。原始日志和复核在本地 `.cache/php-ts-phase39-validation/`。

## 尚未完成

没有执行 createApp 全栈 HTTP、Browser、前端 journal、Workerd/Hyperdrive、生产 DDL、部署或真实微信验收。legacy字段/缺版本的单独原生反例、64/65事件/1MiB、51项门店分页、8秒慢尾/时钟倒退、原键多会话并发、真实退款/分包/同城家族仍未专门验证。Manager 专用不可变履约回执、正式权限后继、当前 assignment/source/员工 scope 证明、waybill 能力适配、真实 Manager HTTP→outbox/Queue→App 首上传继续待实现。现有通用门店财务 scope 和 promotion capability 保留；旧 delivery.notice 没有被虚构为带有 Manager/assignment 原证，实际派发 actor 仍为 App。

保留现有用户、UID、权益、旧单和付款，未知归属不猜；原账号维护 manifest/原子切换、物流更正/历史 UNKNOWN 恢复和既有 CI 缺口仍未完成。
