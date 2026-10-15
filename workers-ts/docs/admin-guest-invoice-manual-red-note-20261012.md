# 后台游客发票与人工整票红字处置

日期：2026-10-12。本文说明当前源码合同、操作与恢复流程、独立维护边界和已经完成的分阶段验证。最终隔离分支候选验证结果须由对应冻结源的实际完整检查填入，不能沿用旧候选通过结果。

## 支持范围与真实办理边界

本增量支持实际 Admin 对 UID 0 游客订单查询发票、读取订单信息和按原 UUID 核对已提交开票操作，并支持人工在税务平台办理整票红冲后录入、独立核对、恢复人工操作回执以及后续真实退款。

每张实际原始已开票票证必须分别整票、同额红冲，币种为 CNY。本协议不支持分次或部分金额红字。所有实际原票得到完整核对覆盖后，订单退款仍可按真实商品数量部分执行，剩余子代可以申请新的未开票发票并由实际 Admin 后续开票。

系统保存办理凭据内容及 hash、原始 issued 快照及 hash、原票与红票标识、完整金额、付款主单和来源订单、买方 UID、正 Admin 操作人和 UUID。核对结论属于人工声明：系统没有连接税务平台办理红字，也没有自动验证平台凭据的真实性或办结状态。

清空票号、降低当前开票状态、归档或删除当前发票行不能替代不可变 issued 历史。未经验证的历史、错误付款来源、缺失原始快照或不完整原票覆盖仍会阻断操作。人工红字事实不能制造付款成功、退款 provider 成功、游客账户或积分余额。

## 后台身份与游客展示

后台使用实际 Admin JWT、当前发票权限及独立 `HYPERDRIVE_ADMIN` 运行身份。普通用户、客服、门店人员或供应商令牌不能代替 Admin。发票读取需要 `invoice.view`，录入和核对需要 `invoice.manage`。

UID 0 是订单买方。搜索 UID 0 必须准确过滤；订单详情返回 `user.is_guest:true`，昵称和推荐人为空。不能查询或创建 `user0`，也不能把收货人、员工、经理或 Admin 姓名当作游客昵称。会员展示保持原合同。游客读写还须核对完整受检 guest 实体目录、实际订单身份，以及不存在 UID 0 账户、账单和佣金记录。

原有开票 process 的请求、审计、hash 和 UUID 回执合同不变。已提交操作可显式按原 UUID 重放核对；后来的合法归档、票号变化或状态变化不抹去原操作事实。

## 人工办理、录入与独立核对

1. 在发票详情读取真实原票列表，检查每张票的原标识、完整金额、issued 快照 SHA256 和已有人工记录。
2. 在税务平台人工办理所选原票的整票红冲，保存实际办理凭据。红字金额必须与该原票完整金额完全一致，不能用其他原票金额、金额合计或部分红字替代。
3. 选择该原票，录入红票号和办理凭据内容，明确确认已经人工办理。原票标识保留 issued 快照原值，非空且最多 50 个字符，不 trim 改造历史标识；全空白或控制字符不能认作原票证据。红票号的 8–20 位数字是本次录入格式，不是自动税务格式校验。
4. 录入提交后为 `RECORDED`，只表示本地凭据已保存，仍待核对。平台凭据内容最多 4096 UTF-8 字节。
5. 实际人工核对原票、红票、金额和办理凭据，再以独立 UUID 提交 `confirm` 或 `reject`，明确 `manual_checked:true` 并填写最多 1024 UTF-8 字节的核对说明。录入与核对是两次独立操作，可以由同一实际 Admin 完成；本合同不宣称双人复核。
6. `confirm` 产生 `MANUAL_REVIEWED`，`reject` 产生 `REJECTED`。被拒事实继续保留；纠正时创建新的录入，不修改或删除旧账本。
7. 所有实际原票必须逐张有唯一、完整、精确绑定的确认覆盖。同一已确认红票号不能重复覆盖其他原票，不能只因总金额相等、当前票号为空或一个版本标签就放行。

两张新账本均为 append-only。UPDATE、DELETE 和 TRUNCATE 受保护；维护连接也不能把这些动作当作业务纠正流程。

## UNKNOWN 与原 UUID 恢复

HTTP 超时、断线或响应丢失不能判断提交成败。界面保留原 UUID 和完整原请求，暂停新的写入，通过页面或详情弹窗的原回执读取按钮核对。

恢复使用 `GET /order/invoices/:id/red-notes/operations/:requestId`。不生成新 UUID、不自动重发 POST，也不凭当前可变发票状态猜测原提交。后端仅向原请求的实际 Admin 操作人返回该操作；当前 Admin 认证与 `invoice.view` 仍须有效。保留 view 而失去 manage 的原操作人可以读取真实已提交回执。

客户端必须比对发票、操作人、操作种类、UUID、原请求内容、record hash、平台内容 hash 和 request hash。核对回执还须比对原 review UUID、decision 与 note。字段不符、未找到回执或无法完整核对时继续保留 UNKNOWN。

录入回执的当前记录可以因后续人工核对而显示 `MANUAL_REVIEWED` 或 `REJECTED`。这只能证明原录入已经提交，不能把“恢复录入”当作“人工核对确认”。

request hash 使用 SHA256(JSON.stringify(tuple))，UUID 由独立精确键绑定：

```text
record:
['invoice-manual-red-record-intent-v1', invoiceId, actorId,
 original_document_number, original_snapshot_hash, original_amount, currency,
 red_document_number, red_amount, platform_evidence]

review:
['invoice-manual-red-review-intent-v1', invoiceId, recordId, actorId,
 record_hash, decision, manual_checked, review_note]
```

## 核对后的部分退款、剩余子代与新票

人工核对完成后，客服须重新读取财务对象、报价和审查，再确认实际退款。确认新的人工事实会改变内部 financial source/review hash；旧报价会失效。公开 Customer Financial Order、Review、Quote 的 wire 版本和字段保持原样，旧来源及旧 owner receipts 不重算。

例如原已开票 21.00，人工整票红字 21.00 完整核对后，可真实退一件 7.00。原票和 issued 快照归档保留；退款子单与剩余 14.00 子代生成新的未开票申请，不复制旧票号。实际 Admin 可对真实剩余金额重新开票。以后该子代再退款时，它自己的实际 issued 历史仍须逐张整票红冲并核对，不能沿用祖先原票的凭据。

人工 allocation v2 冻结原票覆盖、记录和核对 hash，以及新申请的创建归属。后续合法开票不推翻先前真实 CASH_SUCCESS 的原 UUID；恢复须继续完整核对被冻结的事实、付款主单、金额与实际子代。旧 allocation v1 的金额、实体和票据检查保持原合同。

发票全量读取有明确 200 条上限。超过原有三条阈值须有完整受检人工 disposition 与实际受保护退款代次、祖先回执，不按时间窗口、ID cutoff 或单个 JSON 标签忽略历史。

零金额订单保留成熟开票门槛：实际 Admin process 不得制造零金额已开票成功。真实未开票的零金额申请可以按既有合同完成 ZERO_SUCCESS 退款，不需要伪造蓝票、人工红字记录或游客账户。

## 后台接口

实际后台前缀为 `/api/admin` 与 `/adminapi`，以下路径挂载在相应前缀后：

| 方法 | 路径 | 含义 |
| --- | --- | --- |
| GET | `/order/invoices/:id/red-notes` | 读取真实原票、人工事实与可用性 |
| POST | `/order/invoices/:id/red-notes` | 录入凭据，尚未确认核对 |
| POST | `/order/invoices/:id/red-notes/:recordId/review` | 追加 confirm/reject 人工核对 |
| GET | `/order/invoices/:id/red-notes/operations/:requestId` | 原操作人读取原 UUID 回执 |

响应为 private/no-store，拒绝额外查询参数。record body 上限 16384 字节，review body 上限 4096 字节。record 的 id 是录入 UUID；review.id 是核对 UUID，record_id 精确绑定原录入。客户端字段与语义以 `InvoiceManualRedNoteProtocol.ts` 为准。

## 显式维护与独立运行身份

权威维护入口为 `src/migrations/runInvoiceManualRedNote.ts`：

- `runInvoiceManualRedNoteSchema(db, completeEmptyOrm=false)` 安装受检 schema，不配置运行角色。
- `runInvoiceManualRedNote(db, {adminRole, readerRoles}, completeEmptyOrm=false)` 在受检 owner 事务内安装并向明确、独立的普通 LOGIN 授予所需权限。
- `inspectInvoiceManualRedNote` 读取完整目录；`invoiceManualRedNoteReadiness(db, mode)` 区分 reader、admin-read 与 admin-write。

维护要求明确 root maintenance DbClient、PG16、read-committed/read-write 事务、受核 origin 与完整既有 guest 八部件。先按 invoice、history、allocation、refund split、fulfillment branch 顺序锁定既有实体，共享 `731611,0` 维护 advisory；NOWAIT 和已有 statement/lock/idle 上限保持原合同。未知、混搭、漂移目录或不安全权限不会被自动修复。

独立 owner-only 候选为 `src/migrations/maintenance/0181_invoice_manual_red_note.sql`，当前 SHA256：

```text
347edd64921196f65c649e4e291a422e7e6d4ad7b154dd410f432dfa5f01c881
```

0181 只处理新对象均不存在的 fresh 状态，无运行角色 grant；不注册历史 runAll，不进入启动 DDL 或顶层外部迁移扫描。生成器 `scripts/generate-invoice-manual-red-note-candidate.mjs` 仅生成候选文件，不连接数据库或执行安装。

全 ORM 构造若已生成两张新 bare 表，只能通过固定 bare 指纹、空账本、显式 `completeEmptyOrm=true` 的受检 TS 维护分支完成保护。不能将未知已有对象或有数据的 bare 表当作可修复版本。

owner 显式 grant 仅向指定 Admin 提供两新账本 SELECT/INSERT，向指定 reader 提供 SELECT。普通客服不能具有表级、列级、继承或可达 authority 的 INSERT；不能借 Admin writer 身份退款。实际 current/session/backend LOGIN、同 owner、完整固定指纹、危险写权限、CREATE、角色与复制参数能力均受核。

admin-read 是显式 Admin 读取模式，允许其在实际 AdminInvoiceService 后代开票和原操作恢复中读取；它不依据现有 INSERT 自动放宽普通 reader。schema 完整和 owner 安装成功不能代替实际独立 Admin/reader LOGIN readiness 与业务验证。

旧 0180、既有 manual/guest 六个 pins 和旧 proof 语义保持原样。本增量不重学旧指纹或改旧函数 body。本文不提供猜测的生产数据库、role、binding 或部署参数；未执行生产安装或部署。

## 固定目录指纹与已验证阶段

六个新指纹已由真实 PG16 测量后固定：

| 部件 | SHA256 |
| --- | --- |
| bareRecord | `6b1ee8342391b5649e06ba5693df808a9d9e01a8511ef9ceb034090662d34f97` |
| bareReview | `c301182c4a0ab71fd30c16274fe0d8bc0d35c141c115b858b8e1b93ae897fcbc` |
| guard | `fad3b659fa4bb261f8ca210d12e61e2995325028cebd049135c2bb63cdccfab7` |
| protect | `82c16a73576786a61ee003ed8ecaf897194c9559f4da22b697b323fd8378c965` |
| record | `4168138287be01716ae83f5b0f6266abdfc03c5067d6f576c38535ecb57955eb` |
| review | `580d6ee69807673ccbdff91b315ffb413cffae4e3ace8695c982e1528eb26705` |

初次 pending commissioning 运行完整 85 个用例文件，在 beforeAll 严格拒绝未固定指纹：85 skipped、零业务断言，不记业务通过。事务确实回滚，新四对象不存在，旧八部件目录和 OID 不变，guest readiness 前后成立；源/工具前后 hash、fixtures=0、STOPPED 与独立 pg_ctl 终态证明齐全。测量阶段尚未执行 grant，不能据此认定运行账号 ready。

固定指纹后，原 verifier 的 v1-only 分派导致旧候选首轮 72 pass、13 fail。加入精确 v2 分派和完整被冻结覆盖核验后，旧基底候选 `98c45c245638adba6b7b3bce58f2784d9011c3b563fae328479f266f3a4b0fd3` 的完整新原生文件已实际 85 pass、0 fail、0 skip。对应原始日志 SHA256 为 `0f5d544d1d71270d73ad98abdb12e10ea8a8bd5104e07b4aa593a94356c56165`；源/工具前后验证和数据库清理全部成立，旧失败原件继续保留。

待完成：当前隔离分支最新主线基底的完整类型、27 普通文件、43 原生完整文件及实际静态/前端验收须按新的最终冻结源重跑并填入正式报告；旧候选 Q85 通过不得移贴为新版隔离分支通过；独立分支通过也不能表述为主工作区已整合或已部署。整体 PHP→TS 迁移清单尚未闭合。
