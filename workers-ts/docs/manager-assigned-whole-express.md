# Manager 后台分配整单快递

第40轮在[后台分配作者](admin-fulfillment-assignment-author.md)之上接通实际 Manager 整单手工快递。平台付款根保留原 ID，订单 `store_id` 与 `supplier_id` 均保持0，原 type0/1 库存来源不变；履约门店来自当前员工身份和真实 Admin grant。全局 `runtime_ready=false`，整体 PHP→TS 迁移仍未完成。本轮未部署或执行生产 DDL。

## 正式存储与显式运行声明

`upgradeManagerAssignedWholeExpress[InTransaction]` 是独立成功回执存储后继。它要求已经正式 commissioned 的五角色和 assignment addon，调用方再显式声明 `managerAssignedWholeExpress:{receipts:true}`。本轮验收同时安装并声明 city reader；已安装 reader 必须与声明匹配。forward 使用实际 PG16 maintenance LOGIN、指定数据库、共享 try gate 与既有权限审计；新门为 `[731724,0]`，既有 assignment 门仍保留。安装前后审计完整跨角色后继；重复安装只核对，不修复漂移。原事务回滚共同撤销目录和授权。

新表 `public.manager_assigned_fulfillment_request` 共26列，固定 format1/kind=`assigned_whole_express`/outcome=`delivery-recorded`。主键为原用户+UUIDv4；订单和 outbox 分别唯一。typed列固定根、买家、财务0、staff/scope、grant/CAS、写后 revision 和真实 notice ID/key/hash；intent严格绑定同一请求，仅整单手工快递。维护账号拥有目录；唯一 runtime 原始权限为固定 Manager 的 SELECT/INSERT，App/Admin/Financial/Cashier 均无读取或写入权限。immutable UPDATE/DELETE/TRUNCATE 触发器、完整 catalog/ACL/namespace 检查保持原行不变。

目录指纹 `4788618e9687ce6a882762999790f714020bfabe46711f503b8c81a94594f039` 来自隔离原生 PG16.14 捕获，后由完整正式套件与源内固定常量核对。结构检查并非业务外键或密码学授权；Manager 原始 INSERT 只证明存储格式，不能据此称任意 SQL 标本为真实发货。

`Env.MANAGER_FULFILLMENT_ASSIGNMENT_RUNTIME` 由可信组合注入完整 `RuntimeGiftPeerDeclarations`，缺失关闭。HTTP、DSN 用户名和当前 ACL 不能替代声明。请求事务核对固定 Manager current/session/backend LOGIN、数据库和绑定 OID、精确 assignment/receipt 存储、共享维护门及物理 ACCESS SHARE fence；不是每次重新执行完整五角色审计。既有来源表只检查限定名、普通持久表、无 RLS/继承/rule 等边界，不冒称全部 owner/trigger/财务协议审计。

## HTTP 与原请求恢复

生产主应用在 `/api` catchall 之前挂载导出 router `/api/store/manager/assigned-order`。真实中间件先用普通 App 连接认证 JWT，再建立独立 Manager session；没有回退至普通 App 或维护账号。

| 方法与后缀 | 合同 |
| --- | --- |
| GET `/review/:id?store_id=<id>` | 唯一目标门店参数；当前用户/员工 scope 与当前 grant 同意该门店后才读取订单、收件人和商品。返回 CAS、scope、有效承运商及 `requires_locked_commit`。 |
| POST `/commit` | 唯一 `Idempotency-Key: UUIDv4`；严格8192字节 UTF-8 JSON、无重复键/额外字段/查询参数，仅整单手工快递。 |
| GET `/receipt/:requestKey` | 当前原登录用户恢复最小成功回执，无需仍是店长；缺失与他人相同 UUID 均 unknown，不返回 intent/运单内容。 |

所有响应 private/no-store。GET 的 HEAD 沿用 Hono 只读语义，未单独作为本轮原生专案执行。请求在首次 await 前捕获为冻结纯数据，拒绝 getter、symbol、异常原型和强制转换。

```ts
{
  version:'merchant-assigned-whole-express-v1', order_id:positiveInt, store_id:positiveInt,
  scope_key:hex64, assignment_operation_id:UUIDv4, assignment_ordinal:1..64,
  assignment_payload_hash:hex64, expected_assignment_source_hash:hex64,
  expected_order_revision:hex64,
  payload:{type:1,express_record_type:1,delivery_name:string,delivery_code:string,delivery_id:string}
}
```

同用户、UUID和原内容只重放原成功回执；换内容409。重放 POST 仍需当前用户和目标门店管理身份，但不要求旧 grant 仍有效，不重新发货。员工身份撤销后只保留 owner GET 恢复。unknown 不表示“未应用”，没有 abandon、resolve、改键或推断失败的终态。存储只追加成功，不预占失败请求。

## 锁后证明与原子提交

新写入为实际 Manager RC/RW 事务：原用户/UUID互斥→63842根门→真实根行 FOR UPDATE NOWAIT→当前账号/员工 scope→完整不可变 grant 链与 CAS→原根/cart 来源→当前承运商锁及目录。Supplier 旧单参数 allocation 门不冒称63842，但其物理根行与此路径串行。cart/refund 的 SHARE 表 fence 保护空集合；waybill 复用正式 Manager definer 的物理 SHARE 锁，并检查同事务实际锁。该能力不代表 assignment 权限，不伪造旧 `MANAGER_SCOPE_CONTEXT` 或把 root.store_id 改成履约门店。

共享来源读取与第39轮 Admin 作者采用同一事实编码：普通已付款、未发货、未删除 store0/supplier0 的 pid0整根快递；真实 type0/1 原购物车，严格 checkout-line-finance-v1/id/cart_num 和完整初始数量。订单退款状态须为0、退款金额须为0；拒绝 child、退款物化/旧PHP/未知版本、未取消未删除且 refund_type IN(0,1,2,4,5,6) 的退款行，以及 waybill/notice/city 冲突。本轮没有证明真实退款后的余单履约。source hash 是有界旧审阅栅栏，不是签名、付款原证或全部金额重新核算。

同一外层事务调用既有 Supplier 整单服务，嵌套锁后再次证明员工、当前 grant 和完整 source。实际写后只允许预期发货字段/status变化，原 cart 来源不变；核对唯一真实 PENDING delivery.notice 的业务字段，计算原 payload hash，追加 typed 回执并 RETURNING/readback 重建请求 hash。order、标准发货状态、补充 Manager audit、notice 和成功回执共同提交或回滚。尾部复核运行绑定、当前员工和原用户会话；SQL8秒尾验不是全程硬中断或提供方时间。共享 Supplier 改为保留外层更窄 statement/lock_timeout，不提高既有期限。

Manager 事务不执行 provider 或 Queue I/O。提交后的真实 PENDING notice 由既有 App outbox dispatcher（包括 scheduled 扫描）与 Queue 消费，继续原账号发货合同。新回执绑定 notice 的实际 hash，但旧 notice 不被虚构为含有 Manager/assignment 原证；App 派发 actor 仍为实际 App。App 不独立读取/验证新 Manager 回执或后台分配授权。历史 grant 后来撤销不倒退已完成发货和原回执。

## 验收与失败留存

所有重型检查固定 Node24.14.1/npm11.11.0、自有 PG16.14、单一外层共享串行锁、单 worker和原有期限；每阶段600秒，未提高内存/用例/任务上限。

| 批次 | 实际结果 |
| --- | --- |
| canonical-01 | 1项目录捕获通过，22.17秒；当时源 pin 为空，此结果本身不宣称已符合固定目录。 |
| author-04 | 完整10项业务通过，164.05秒，输入不变，remaining0/STOPPED。 |
| storage-05 | 完整101项通过（1捕获+100结构），143.37秒，输入不变，remaining0/STOPPED。 |
| regression-06 | 既有 Admin 分配11项与原账号快递Queue12项通过，122.70/205.38秒，两阶段输入不变且集群清理。 |
| final-07 | 41项单元与Worker unit/runtime两套类型检查全部通过，33.91/196.51/96.32秒；合计326.75秒，8525输入不变。 |

业务正例为实际 Admin assisted checkout→默认RSA/AES Routine回调→App paid消费→真实Admin grant→导出 Manager router及实际鉴权/独立LOGIN→真实notice/SQL回执→Queue/App原账号首次上传。明确读取当前配置B，再验证旧A token/AppID和已验证付款人，实际 App dispatch/provider证据、锁外传输、重复消息不重复上传均受断言。保留原 type0/1 cart、财务0和原grant行。还覆盖错门店、改派/撤销后旧review拒绝、损坏cart反例、真实根争用、其他五LOGIN拒绝、缺声明关闭、后台撤销后成功重放、角色撤销后最小owner恢复。

尾部故障是明确标注的 DB 代理：所有业务SQL/真实Manager身份不替换，在实际 receipt INSERT 前同事务读取 status1/notice1，再执行真实 SELECT1/0，证明全部回滚后同键成功。正向 paid/cart/grant/delivery/notice/receipt 不由维护SQL制造；维护配置身份、商品、承运商及原账号发货策略批准，订单分配 grant 由真实 Admin 作者生成；负例明确修改当前cart或角色。结构套件直接SQL标本独立标注，只证明目录、约束、权限与immutable，不能累计为真实履约。8192超限结构反例同时超过文本界限，不宣称孤立验证字节边界。

types-02 原始14条编译错误保留：共享抽取后的 import 和结构测试 savepoint 参数类型遗漏；修正后 final-07 两套类型检查通过。author-03 在 fixture 初始化被既有封闭 shipping-policy target 拒绝，10项全部 skipped、143.17秒、输入不变、remaining0/STOPPED；只将fixture传参收窄为四个身份字段，没有放宽生产接口。两项独立复核建议已加强真实SQL回执/API/intent/hash关联及读取当前B配置；另一位未参与测试作者的复核者核对通过日志与实现，未报阻塞问题，没有独立重跑或扩张为安全审计。

文档在验证后补齐。暂存格式检查发现 `fulfillmentAssignmentRuntimeDeclaration.ts` 末尾多余空行，随后仅删除一个末尾LF；与已扫描前像逐字节核对，其余可执行源码与全部测试字节不变，没有为此重复重型检查。最终提交文件重新执行秘密扫描并核对暂存字节。

## 后续边界

没有 createApp 全栈、Browser、Workerd/Hyperdrive、生产DDL、部署或真实微信验收；provider/Queue/KV为本地受控传输。前端 Admin 分配面板、Manager 分配待办/专用会话和journal尚未接通；旧门店列表继续按真实财务门店过滤，不会因批准而读到store0单。未专门执行并发同键、8秒慢尾/时钟倒退、空waybill业务争用、gift正向Manager发货、所有容量边界。分包、自提、虚拟、真实退款分支、物流更正与历史UNKNOWN恢复不属于本轮新Manager入口。

e11d6de4 已按精确授权推送；其UniApp完整CI17分41秒通过，旧c172的20分17秒cancelled事实保留，不能改称已确证timeout或预算稳定性完全解决。PC/Kefu依赖审计仍失败，Worker全量CI终态另行记录。现有用户/UID/权益/旧单/付款保留，未知归属不猜；完整维护manifest/原子切换许可、前端与整体迁移继续待推进。新提交需具体SHA的新推送授权。
