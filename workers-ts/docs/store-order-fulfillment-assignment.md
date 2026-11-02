# 门店履约分配的不可变存储合同

本阶段实现用户选择的“仅后台受控分配到门店，并保留不可变分配回执”所需的前置存储和显式 PG16 维护后继。尚未实现经过认证的 Admin 分配作者、HTTP/UI 或 Manager 分配单履约入口。表中的 SQL 结构标本不是后台批准、付款原证或门店履约能力；全局 `runtime_ready=false`，完整迁移未完成。

## 数据与不可变边界

`storeOrderFulfillmentAssignment.ts` 定义维护者所有的 `public.store_order_fulfillment_assignment`，16 列：

| 列 | 结构合同 |
| --- | --- |
| `operation_id` | UUIDv4 主键，未来操作的幂等标识。 |
| `format_version`、`kind`、`actor_id` | 固定版本 1；`grant` 或 `revoke`；正整数作者。 |
| `root_order_id`、`order_id` | 相等的正整数，限定整根单。 |
| `target_store_id`、`customer_uid`、`financial_store_id` | 目标门店和买家为正整数；财务归属固定为 0。 |
| `ordinal`、`previous_ref` | 正序号；首行只能是无前驱的 grant；后继须有不同于自身的 UUIDv4 引用。 |
| `order_revision`、`payload_hash`、`source_hash` | 各为 64 位小写十六进制字符串；数据库不计算或认证其内容。 |
| `source` | 仅允许 `cart_rows` 数组，1..200 行、序列化后不超过 65536 字节。 |
| `created_at` | 正整数；默认 SQL `clock_timestamp()` 的 epoch 秒。SQL 写者可显式传值，不是独立时间证明。 |

每个 source 行只允许正整数 `row_id`、`product_id`、`quantity`，以及字符串 `cart_id`（1..50 字符）、`unique`（0..255 字符）。后两者对应真实来源列，不能把 cart_id 强制转成数字，不能拒绝合法的空 SKU 标识。禁止额外字段并不等于该数据已经脱敏或真实；未来作者必须从受控数据库来源构造封闭快照。

`UNIQUE(order_id,ordinal)` 与 `UNIQUE NULLS NOT DISTINCT(order_id,previous_ref)` 防止重复序号、同根多个首行和同前驱分叉；`(target_store_id,order_id,ordinal DESC)` 索引支持后续门店读取。它们不证明前驱存在、序号连续、状态转移合法、订单/购物车仍匹配，或 actor 具有后台权限。未来业务作者必须在真实根单物理锁内完成这些检查，不能把结构 CHECK 或非密钥 hash 当作授权。

维护者所有的 SECURITY INVOKER 触发函数拒绝 UPDATE、DELETE 和 TRUNCATE，含维护者直接 SQL 的普通操作。维护者仍可执行 DDL，因此目录证明也检查 owner、函数体、函数标志、触发器和 ACL；不能宣称抵抗数据库超级用户主动篡改。

## 显式维护与权限

`upgradeStoreOrderFulfillmentAssignments[InTransaction]` 是单独的、未来生效的维护 forward，不修改基础迁移，不运行历史回填，不改变订单 store_id、付款、买家、库存或财务事实。它接受显式目标、`{ assignments: true }` 和完整五角色 peers，首次 await 前分离并校验有界纯数据声明。正常部署 target 的额外纯数据元信息不参与身份、不返回、不传入授权审计；getter、稀疏数组和异常原型拒绝。

实际上下文须为指定库的维护者真实 LOGIN，current/session/backend OID 一致、无 SET ROLE、PG16、read committed、可写 origin 事务，并无启用的 event trigger。沿用既有 commissioning try-only 门，最后取得 `[731723,0]`；不会取得订单业务资源锁或创建运行角色。

首装前审核精确旧完整 profile，创建后审核精确新完整 profile。唯一新增运行权限如下：

| 运行身份 | 新表权限 |
| --- | --- |
| 指定 Admin | SELECT、INSERT |
| 固定 `cinashop_manager_v1` | SELECT |
| App、Financial、Cashier | 无 |

没有新序列、运行 EXECUTE、逐列逃逸或 grant option。基础 privilege plan 不改；审计只在显式 `fulfillmentAssignments` 声明、真实命名/OID 和完整目录相符时接受后继。安装后遗漏声明拒绝。Manager 的公开审计新增第五个可选参数，保留既有 city reader 第四参数的位置；旧 city/refund forward 继续传递已声明后继，不能学习当前 ACL 后自行扩权。

目录完整逻辑指纹固定为 `9805d9ab6bbce34371dcbd45cd36a1d5fd09d3683a2c8e66fa374fc670b9e7bc`，使用项目规范 JSON hash。列类型/默认值/排序规则、约束、索引、触发器等形状参与指纹；owner、函数体/标志、ACL、复合类型/数组绑定、额外 namespace 对象与附着对象另行核对。TEMP 元数据不影响正式目录证明；同名前缀的用户 schema 对象拒绝。正式 forward 使用显式命名身份，不以元数据 leaf 的可选 ACL 候选发现作为授权。

半安装或漂移直接拒绝，不补全、不修复。精确重复仅做读取和锁，先取 `ACCESS SHARE NOWAIT` 物理表锁再复验目录和完整 profiles，没有 DDL、GRANT 或行写入。首装由调用者事务持有；回滚同时撤回表、函数、触发器与 ACL。

## 已执行验证

固定 Node 24.14.1、npm 11.11.0、隔离原生 PG16，所有重型检查由一个外层共享串行锁顺序执行，单 worker，沿用每阶段 600 秒、既有 case/hook 和内存限制。没有把多个阶段的总时长冒称为单阶段 CI 预算。

| 批次 | 结果 |
| --- | --- |
| `native-04` | 当前完整新原生 24 项通过，203.65 秒，8502 项冻结输入不变，remaining=0/STOPPED。 |
| `regression-04` | 旧 city/refund 两文件 27 项、旧 Manager profile 8 项，共 35 项通过；375.56 秒，输入不变，两组均 remaining=0/STOPPED。 |
| `types-final-06` | Worker unit/runtime 两套类型检查通过，190.22/100.44 秒，输入不变。 |
| `unit-05` | 四文件 40 项通过，14.39 秒，输入不变。 |
| `final-07` | 上述兼容、最终类型和单元三组全部 exit0；687.95 秒，8498 项外层冻结输入不变。新原生复用前另核对其冻结输入无变化，没有重复计数。 |

新原生使用五个独立真实 LOGIN，执行正式安装、完整调用者回滚、精确重复/缺失声明、参数异步变更、实际有效 ACL、Admin/owner 不可变拒绝、分叉/财务归属约束、source 200/201 行和 SKU 255/256 边界、UTF8 大小拒绝，以及 gate/物理表锁、实际数据库/身份/ROLE/事务/replica、TEMP 与代表性目录漂移。安装 assignment 后实际执行旧 city 和 refund 后继及重复；refund 前置也由真实维护 forward 完成。SQL 结构标本不充当真实订单、Admin 决策、付款或 provider 证据。

保留失败记录：`canonical-01` 是空指纹的首次诊断，1 失败/22 跳过，不能记作通过；其有效 DDL/目录用于钉住规范指纹。`native-03` 为 5 通过/19 失败，正常 target 的 `pricingOwner` 元信息被错误拒绝，后续因尚未安装级联失败。改为有界纯数据捕获后只提取身份，修正夹具可变 peers，再完整执行得到 native-04；没有放宽运行角色或目录。早期 types-02 的通过不替代最终类型结果。

只读独立复核未发现本阶段范围内阻塞缺陷；复核者检查既有记录，没有独立重跑测试，不是完整安全审计。日志、指纹与原始结果保存在本地 `.cache/php-ts-phase38-validation/`；文档在冻结执行后补齐，最终提交文件另做逐文件秘密扫描。

## 后续业务工作

仍需真实 Admin 身份与 `order.manage`、封闭输入和幂等回执恢复、当前订单/购物车来源及完整前驱链、真实根锁/空集合写入隔离、门店有效性、撤销/重新分配规则，然后接通专用 Manager 整单快递履约。保持平台 root/store0 及通用财务归属规则，不能通过客户端 store_id 或维护 SQL 改单伪造门店来源。后续还须完成真实付款→后台分配→Manager HTTP→outbox/Queue→App 首上传的端到端验证及前端会话/journal/浏览器验收。

本阶段未执行生产 DDL、部署、真实微信调用、业务 HTTP、Browser 或 Workerd/Hyperdrive 验收。缓存中的下一阶段作者草稿未应用、未验证，不属于本阶段实现。现有用户、UID、权益、旧单、付款和跨 AppID 归属维护屏障保留，未知归属不猜。
