# 同城配送回调归属与原子收货（2026-10-01，本地未发布）

本批继续处理同城配送记录屏的履约合同。修改范围是现有回调/查单证据的本地投影和共享收货事务，没有新增取消请求、费用确认、凭据编辑、发单或生产授权。记录整屏仍为 **partial**，相邻配置整屏仍为 **missing**。完整旧配置是四个开关加六个凭据，并无计价或配送范围字段，见[配置逐项核对](admin-city-delivery-settings-contract-review-20261001.md)。

## 真实基线与问题

旧投影按 provider/orderId 找配送记录，再只按 oid 找原单。未校验买家 UID、门店/供应商多态归属或同原单的其他发单尝试。旧尝试的取货或取消因此能覆盖另一归属的骑手、配送和原单状态。真实 PostgreSQL 首组 28 项中，24 项保护断言失败、4 项合法归属对照通过，见[归属红基线](C:/cinagroup/cinashop/.cache/city-delivery-callback-authority-native-ownership-red-20261001.log)。完整旧代码对照进一步得到 **32失败／15通过／47总项**，见[完整红基线](C:/cinagroup/cinashop/.cache/city-delivery-callback-authority-native-full-red-20261001.log)。此前另一次 28 项均因隔离夹具重复建立索引而失败；该日志单独保留，不当作业务缺陷证明。

旧送达投影先提交原单状态核验，再另起事务收货、结算积分/佣金和供应商款项，最后又另起事务写配送终态与 watermark。核验后履约改成快递仍可能被旧送达收货；最后配送写入失败也不能回滚已经提交的真实财务。此次抽出共享 `completeOrderReceiptInTx`，复用全部原收货条件，并由同城投影在同一事务内完成上述写入。

## 归属和尝试权威

配送 oid 必须等于原单 id，配送 UID 必须为正且等于原单 UID。归属遵循旧创建顺序：正 store_id 优先对应 type=1/relation_id，其次正 supplier_id 对应 type=2/relation_id，否则仅允许 store_id=supplier_id=0 且 type=0/relation_id=0。订单 type 表示促销，不用作归属判断。不能证明的 platform pickup、不同类型同数字 ID、未知或无效归属均拒绝写投影。

尚无持久 active-attempt binding。同 oid 只要有第二条历史配送记录，当前尝试就不能可靠证明；即使另一条 status=-1，也不按最大/最小 ID 自动采用。事件成为 CONFLICT，outbox 沿原生命周期成为 DEAD；不回退原单、不改骑手、配送或 watermark，也不自动重试冲突。此保守边界不会删除或聚合记录；解除歧义仍需后续可信账户、历史 adoption 与 active binding 合同。

同事件 key 的重试也须经过当前 UID/归属/唯一尝试/平台单号/已付款校验，再核对当前履约状态。完成 no-op 只接受 status=2 且仍为 city_delivery，取消 no-op 只接受 status=0 且配送方式为空，其他 no-op 只接受 status=1/city_delivery。不能用旧 watermark 绕过权威检查后把 reconciliation 错误标为已解决。UNKNOWN 继续只保留 IGNORED 事件/outbox，不创建或更新已确认 watermark；历史已被旧代码降级的权威不会自动重建。

## 事务和并发边界

收货配置上下文在事务外预加载。外部 status hint 仅决定是否加载上下文，不授权写入；已完成 no-op 无须财务配置表。若 hint 表示已完成、等待后原单却变为待收货且未加载上下文，则失败并重试，不在业务锁内调用 KV 或其他外部服务。

投影事务在首次数据 SELECT 前明确设置 READ COMMITTED，保留更严的会话超时，并将 statement/lock/idle 上限分别设为 5/2/5 秒。首个业务锁是 store_delivery_order 的 SHARE ROW EXCLUSIVE 表锁；取得后重读配送/原单 hint，再按 root settlement → child settlement（不同才取）→ subject → watermark → 原单 → 配送记录的顺序加锁。等待后的 pid、PK、oid、provider/单号、UID 和归属必须重新核实；漂移时不能临时换锁目标继续授权。

表锁避免直接 INSERT 在唯一尝试查询后制造 phantom。它与配送 DML 的 ROW EXCLUSIVE 冲突、自身互斥，普通 SELECT 仍可进行；规则见 [PostgreSQL 16 显式锁](https://www.postgresql.org/docs/16/explicit-locking.html)和 [LOCK](https://www.postgresql.org/docs/16/sql-lock.html)。这是所有已知同城投影暂时串行的表级保护，不能称为每单锁或生产规模验收。未来发单/import writer 必须遵守表锁优先顺序；先拿订单或配送行锁再写配送表会产生反向等待，需另行调整协议。超时或数据库失败沿既有 durable FAILED/重试流程处理。

完成分支在这些锁内调用同一个共享收货 helper，保留 paid/status、pid!=-1、配货已完成、非到店自提/自配送、退款状态、actor 和门店可见性条件，并额外要求 city_delivery。原单 status=2、真实 supplier/reward/brokerage、日志、配送 status=4 和 watermark 同一事务提交；任意后续写入失败全部回滚。通用用户/供应商/计划任务入口仍通过原 boolean wrapper 调用这个相同 helper，未放宽原收货准入。

## 验证状态和仍开放合同

最终完整保护用例 **47/47** 通过，其中30项使用九表生产ACL切片，17项使用178个正式迁移阶段/282表和全新app/Admin LOGIN的实际权限初始化与审计。覆盖UID/类型归属20、多尝试4、合法对照4、同键恢复2、真实财务4、快递切换与末端故障2、收货资格8、真实锁/快照3。加强超时用例后额外单项旧源码仍失败；最终完整47项再次通过，实际事务内设置为400/2000/5000ms。此前通过和重复对照不累加，最终日志见[原生保护验证](C:/cinagroup/cinashop/.cache/city-delivery-callback-authority-native-final-20261001.log)。

既有回归六文件 **51/51**（原回调/记录40、实际用户收货11）；另三个文件定向 **5/5**（供应商拆单收货2、正式受限LOGIN完整建单/退款/分单/收货1、退款商品行后收货补偿2），56未选中明确排除。纯函数及旧核销/计划任务/对外API源码合同四文件 **49/49**。本批共 **152项唯一通过＝83项真实SQL/HTTP＋69项纯输入/源码**。计划任务静态合同不代表实际计划任务消费者已执行；同城正向调用的是共享scheduled actor事务helper。

旧受限角色完整业务用例曾在checkout前置因过时夹具缺少store_product_relation权限失败，未进入receipt；现在用两个全新空LOGIN执行既有正式权限初始化，保留完整原业务流程，未手工补生产授权。夹具仅增加已有operations构造函数的导出，旧ACL与其他用例保持。静态四项初失败分别来自两处CRLF精确比较和两处早已提取的退款/自提实现位置；规范化换行、追踪实际共享校验后保留语义断言并全过。所有失败日志和修正分别保留。

支付/发货状态及同键恢复边界由合成夹具种入；同键测试没有触发真实finishClaim异常，而是验证该恢复状态不能错误解决PENDING对账。财务SQL和末端配送故障触发器为真实执行。财务比较覆盖38个场景表、配送表及另行watermark断言，不宣称282表全量比较。后台页面及请求合同本批没有增加；上一批UI浏览器证据只覆盖当时构建，不当作本次后端财务与并发验证。Worker双类型结果、源码/日志摘要与清理证据见[独立验收](../audit/city-delivery-callback-authority-acceptance-20261001.json)。

Worker unit/runtime类型检查分别71.750秒和40.279秒通过；本批全部九个自有原生PG集群均fixtures清零停机，经独立pg_ctl status=3及真实TCP查询确认无监听后清理data。源码范围含未跟踪文件的空白检查通过。旧验收原始摘要保持不变，59个未改动旧证据源码摘要逐一相符；本批另冻结当前源码和实际日志，不重写历史验收。

真实 provider 的取消原因/费用协议、确认意图、未知外部提交恢复、取消/完成竞争的持久操作回执、账户版本/历史 adoption/active binding 及配置凭据单一权威仍未实现。运行权限计划与数据库 schema 保持原版本；隔离测试中的正式迁移、维护角色和故障触发器不代表生产 DDL/权限或全渠道验收。本批未提交、推送或部署，Checklist 158 项开放范围保持。
