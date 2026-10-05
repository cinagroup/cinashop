# Admin 拼团商品合同（2026-09-27，本地候选）

旧源码以 `C:/cinagroup/cinashop-php` 的营销路由、拼团页面和 PHP 服务为依据。新 `/activity/combinations` 绑定一个来源商品和多个 type=3 SKU；父秒杀活动和时段是另外的实体。页面和接口可执行不等于四条旧页面全部完成。

当前新增读取批次已将四屏推进至本地 candidate，详见本文末尾“新增读取批次当前合同”；该状态不等于真实环境或发布验收完成。以下完整表单批次的范围、测试数字和源码归档保留为历史证据，不与新批次重复累加。

## 前批完整表单合同与冻结验收历史

| 旧页面 | 前批承接 | 当时完成边界 |
| --- | --- | --- |
| `/admin/marketing/store_combination/create/:id?/:copy?` | 独立完整创建、编辑、复制表单 | 本机验收后可列 candidate；真实运营配置、媒体及发布仍需验证 |
| `/admin/marketing/store_combination/index` | 专用分页目录、名称/ID、日期阶段、上架状态、详情和配置管理 | partial；全筛选 Excel 导出、目录日常价/拼团价、三项参与统计及独立统计跳转未补齐 |
| `/admin/marketing/store_combination/combina_list` | 旧聚合页面保留按商品读取团记录的弹窗 | partial；弹窗的最多50行不能替代跨商品筛选、完整分页和成员订单详情 |
| `/admin/marketing/store_combination/statistics/:id?` | 尚无完整独立页面 | partial；旧六张统计卡和两个分页列表仍缺，不把辅助团计数当作完成，也不额外发明旧页没有的图表 |

专用接口是 `/adminapi/activity/combinations` 与 `/api/admin/activity/combinations` 两个前缀的同一组9个 REST 操作：列表、配置选项、候选商品、完整来源、详情、创建、更新、启停、删除。前端8个导出函数含9个 HTTP 分支。权限分别为 `combination.view` 和 `combination.manage`；单位、运费模板和图库仍沿各自权限。旧 generic 拼团创建、修改、启停和删除在进入写事务前拒绝，聚合目录读取保留。

表单恢复三步流程、名称/简介/单位、最多10张图库图片及排序、富文本及稳定图片引用、上海时间起止、每团时效、人数、累计/单次限购、虚拟成团阈值、完整规格、配送/运费、推荐和退款策略。来源和归属由服务端读取；成本、日常售价、基础库存和已消耗额度只读。复制保留来源商品，创建全新的活动及规格身份，总额度取原配置总量，消耗量不复制。既有 SKU 只退役，不物理删除或复用身份；更新总额度不得小于历史已消耗量。

关闭活动会将尚在进行的团提前到期，由既有消费者按成团规则结算或退款。删除仅写 `is_del=1`，保留原上架状态和既有团截止时间；既有订单继续按原团规则处理。关闭和删除均使用活动排他 NOWAIT 锁排除晚付款，删除不额外锁团或提前截止。已结束活动不能原位保存，可以启停、读取、删除或复制调整日期；上架也不使已过期活动重新可购买。

到期处理先按既有锁序固定活动、结算及订单，再读取团和数据库当前时间。只对到期的进行中团补齐，阈值为 `ceil(people × virtual / 100)` 个有效真实已付成员。未付、虚拟、已退款、在途退款或订单身份矛盾的成员不计数。补齐记录的用户及订单均为0，不创建订单、账单、扣库存或调用 provider。已成功团幂等返回；失败团继续既有退款恢复协议。与付款、取消、退款并发的原生验证见本轮验收证据。

成团事务为每个合格真实订单写一个 `order.pink.success.notice:<orderId>` 事件；不可变载荷仅含订单ID/号、用户、团ID和人数。消费者在生成系统消息及渠道记录前再次核验团、订单和退款资格。系统标识恢复为 `order_user_groups_success`，短信使用买家账号手机号，小程序模板为旧 `PINK_TRUE` 的 `3098`；团长昵称按旧截断和数字清理规则处理，公众号渠道保持禁用。通知可通过现有 Admin 配置页面启用，默认无配置不会外发。

通知商品名取真实购时明细快照；旧 PHP 使用发送当时的活动标题，这是明确的时点差异。小程序时间取成员参团时间，详情地址使用真实订单号。资格二次校验发生在生成消息/渠道记录时；渠道生成之后的退款不会再增加发送前第三次校验。这里恢复的是完整成团成功通知，不宣称开团和参团成功通知同时完成。原生验收中的短信 HTTP 为显式替身，不证明真实第三方投递。

拼团退款策略保存到购时 `store_order_cart_info`。后续修改活动或来源商品不改变已有订单的退款判断；普通订单继续使用原商品策略。实际受限 Admin 创建、app 确认/建单/钱包付款和退款申请链分别验证这一边界。

新增外部迁移 `0168_pink_success_notice.sql`、内嵌 `0174`，当前完整外部170份、内嵌175项。旧库使用独立 `runPinkSuccessNotice`，不能重新跑全部 bootstrap。升级仅将已知10事件 CHECK 扩为11；拒绝未知 CHECK、列类型/长度/空值/默认值/排序规则漂移、未验证约束、RLS及继承等异常。维护行预算10000，排他 NOWAIT，超时只收紧。保留业务行、非目标 catalog、既有权限和约束注释，重复执行不替换对象。迁移不创建或扩张业务角色权限。

九路径 ORM 审计把历史9个 CHECK 的验证与实际十到十一事件升级分别报告。历史55项漂移拒绝不能冒充新迁移的测试；迁移专项同时验证旧库独立 forward 和新建外部/内嵌完整 schema。此前父秒杀的已接受证据保留原 JSON 和源码字节归档，不累加到本轮测试数。

本机浏览器使用最终 Admin 构建与隔离 loopback 合成 API。它验证实际 DOM、富文本图片还原、权限界面、失败恢复和紧凑布局；不能证明真实 JWT、数据库写入、R2 或 provider。原生 SQL、实际受限 LOGIN、真实已装配 Hono HTTP、前端运行时和浏览器分别计账。完整 Linux CI、真实配置/设备/provider 和发布验收继续开放；本轮没有提交、推送或部署。

最终本机证据见[原生及目录审计](../audit/combination-native-20260927.json)和[实际浏览器验收](../audit/combination-browser-20260927.json)。本批原生范围去重155项，由冻结批次中完整通过的7文件135项和独立修订终态迁移20项组成；冻结批次自身为153通过/2失败，不伪称一次155/155。另9文件485项既有SKU、取消、付款、退款及确认规则回归通过，原生合计17文件640个不同用例。前端39项、兼容5文件113项分别通过，不累加早期诊断。九路径目录为279表/3885列/668约束/1076索引/227序列，两组五类差异全部为0；独立空库元数据拒绝门禁与九条完整路径分别计账。

浏览器共190条共享合成请求（含后台轮询），6次拼团内存写入；写响应丢失的一次POST产生单一活动，后续只GET核对。只读、管理和无图库管理界面、分页选源、失败原草稿保持、跨页图库、富文本稳定引用、已结束活动启停、坏配置拒绝及关闭/软删除提示通过。实际DOM390×844宽度无页面横向溢出；手机截图存在应用合成器缩放及灰边，未称真机验收。两页签关闭、viewport恢复、5201服务停止；最终PG集群夹具清零且独立核验停机。最初gM8fUa诊断的20个合成库保留在已停机目录，不冒称历史全部清零。63个明确本批源码/测试和最终157个Admin构建文件已按字节归档，旧父秒杀已接受证据独立保留。

前批源码清单 SHA256 为 `f2850eaeed0bc2d89bf47d2d5b0b76423aa3266fb3395163687be2b98db518a4`；当时 `Combinations.vue` 为 `ecb599cd2f1df87acd7969c2bbdd2e301b4f3e0c3d3b0f0feefea9614ae40d64`，完整表单39项测试文件为 `894856839eece072e9eb6be1997cfbd9d549c29ef27e932b9c9bb3683a7f6c9e`。这些哈希对应原验收归档，新增读取批次没有覆盖原 JSON、63份源码或157份构建字节，当前工作树和新构建不应再与前批页面哈希混同。出处为[前批验收清单](../audit/combination-acceptance-20260927.json)及上述原生、浏览器 JSON。

## 前批记录的后续读取计划（历史）

下一批优先补三个只读合同。商品目录增加日常价/拼团价、三项原始团计数及独立导出；全局团目录按团长pink行分页，成员明细以pink.id寻址；独立统计恢复六卡、团长列表和已付主订单列表。读取和导出沿独立权限，在同一只读快照中统一列表/总数，不修改本批冻结的额度、付款或团结算协议。

六卡须保留旧PHP的精确口径，不能使用虚拟补齐消费者的有效真实成员条件替换历史统计：

| 旧字段 | 统计集合 |
| --- | --- |
| people_count | 活动所有pink行的不同uid，包含退款和虚拟uid=0 |
| spread_count | 同活动k_id>0的不同uid，表示参团用户数，不是推广归因 |
| start_count | 同活动k_id=0行数，退款晋升和旧退款团长按原始行计数 |
| success_count | 同活动k_id=0且status=2行数，不额外排除退款 |
| pay_price | type=3、activity_id匹配、paid=1、pid为0/-1主单的支付毛额，包含后续退款和删除历史 |
| pay_count | 上述已付主单集合的不同uid，不是订单数量 |

全局两卡是全部pink行数及成功团长行数，独立于列表筛选。旧“活动参与人”实际为团长分页；订单list/count旧条件不一致，目标应统一已付主单集合并明确修正。过期status=1先显示待处理，不在只读投影中提前推断虚拟团失败；新真实人数或退款净额若需要，增加独立字段和解释。导出须验证完整容量、同筛选/顺序、稳定11列、金额精度及公式注入，拒绝截断或部分失败的下载，不能以现有受限1000行下载工具冒称完整导出。以上在前批冻结时尚未注册接口或计作通过；当前实现及验收边界如下。

## 新增读取批次当前合同（2026-09-27）

本批补齐目录价格、原始团计数、统计跳转和完整筛选 CSV，以及全局团目录、成员分页和单活动六卡/团列表/订单列表。四条旧页面现均列本地 candidate；源码、隔离原生、前端运行时和本地 synthetic CUA 已完成本批验证，真实运营及发布验收仍不勾选。新的原生和浏览器 JSON 已落盘，最终 acceptance 封存由主代理收尾。

| 旧页面 | 当前页面与合同 | 当前边界 |
| --- | --- | --- |
| `/admin/marketing/store_combination/create/:id?/:copy?` | `/activity/combinations` 的完整创建、原位编辑、复制与只读详情 | local candidate；完整表单语义沿前批冻结合同，新增读取没有更改 SKU 身份、额度或付款协议 |
| `/admin/marketing/store_combination/index` | 同页15条目录、价格/三项原始计数、统计跳转、独立筛选导出 | local candidate；CSV 是明确的新文件格式，不能称旧二进制 Excel 的字节等价实现 |
| `/admin/marketing/store_combination/combina_list` | `/activity/combination-groups`，全局两卡、团长过滤分页和安全成员弹窗 | local candidate；团列表按团长 pink.id 寻址，保留退款、失联用户及缺失活动的历史记录 |
| `/admin/marketing/store_combination/statistics/:id?` | `/activity/combination-statistics/:id?`，单活动六卡与两个15条分页列表 | local candidate；无 ID 时先选择/输入，不请求 NaN；读取不结算过期团，不把毛额误称退款净额 |

### 接口、权限与目录字段

旧9个完整表单 REST 操作加本批8个 GET，共17个操作；两前缀 `/adminapi` 和 `/api/admin` 共34条注册，不能把双前缀算作34个不同业务操作。下表路径相对两个前缀；旧9项仍为列表、选项、候选商品、完整来源、详情、创建、更新、启停、删除。

| 新增 GET 路径 | 权限与读取用途 |
| --- | --- |
| `/activity/combinations/export` | `combination_export.view`，完整筛选导出清单 |
| `/activity/combination-groups/head` | `combination_group.view`，全局两卡，不接收列表筛选 |
| `/activity/combination-groups` | `combination_group.view`，全局团长分页 |
| `/activity/combination-groups/:groupId/members` | `combination_group.view`，指定团长成员分页 |
| `/activity/combination-statistics/:id/head` | `combination_statistics.view`，单活动六卡 |
| `/activity/combination-statistics/:id/groups` | `combination_statistics.view`，固定活动团长分页 |
| `/activity/combination-statistics/:id/orders` | `combination_statistics.view`，固定活动已付主订单分页 |
| `/activity/combination-statistics/:id/groups/:groupId/members` | `combination_statistics.view`，活动及团长双重限定的成员分页 |

`combination.manage` 仅沿本实体隐含 `combination.view`，不授予团记录、统计或导出等敏感读取。导出匹配先于通用拼团匹配；仅有导出权限的账号可进入同一菜单、应用筛选并导出，但不会请求商品目录或配置选项。统计按钮不要求 manage，要求自己的统计权限。订单详情另需 `order.view`；图库、单位及运费模板权限继续独立，不因本批读取扩权。注册与权限证据：[adminapi.ts](../src/routes/adminapi.ts)、[v1/index.ts](../src/routes/v1/index.ts)、[AdminPermissionService.ts](../src/services/admin/AdminPermissionService.ts)；页面接线见 [router/index.ts](../../view/admin-ts/src/router/index.ts) 与 [AdminLayout.vue](../../view/admin-ts/src/layouts/AdminLayout.vue)。

目录 `price` 为活动拼团价字符串，`ot_price` 为基础商品当前划线价，来源商品缺失时返回空字符串并显示“—”；这与表单只读 SKU 日常售价及历史活动 SKU 价格快照分开。`people` 仍是配置成团人数；`count_people` 是全部 `k_id=0` 团长行数，`count_people_all` 是活动全部 pink 原始行数（含虚拟和退款），`count_people_pink` 是 `k_id=0 AND status=2` 行数，不去重或扣退款。旧 `group_count`、`completed_group_count` 保留兼容。实现见 [AdminCombinationService.ts](../src/services/admin/AdminCombinationService.ts) 和 [Combinations.vue](../../view/admin-ts/src/pages/activity/Combinations.vue)；旧目录字段及导出来源为 `cinashop-php/view/admin/src/pages/marketing/storeCombination/index.vue:221、236、251、256、329`。

### 历史统计、分页与成员安全

单活动六卡严格使用上表六个旧口径：四项 pink 统计保留退款和虚拟行；`pay_price` 为 `type=3、activity_id匹配、paid=1、pid IN(0,-1)` 的支付毛额，包含后续退款、用户删除和系统删除历史，`pay_count` 是同集合不同 UID。六卡不随列表关键字、状态、日期或 tab 改变。全局两卡分别是全部 pink 原始行数和 `k_id=0 AND status=2` 成功团长行数，也不随团列表筛选改变。旧来源为 `statistics.vue:326` 和 `combinaList.vue:237`，SQL 证据见 [AdminCombinationStatisticsService.ts](../src/services/admin/AdminCombinationStatisticsService.ts)。

团列表和成员列表默认15条，接口最大100条，offset 最多10000；列表与 count 在单次只读 REPEATABLE READ 事务中使用同一集合，团列表按参团时间降序、ID降序。全局团筛选有关键字、状态1/2/3、活动 ID、上海开始/结束日；结束日包含当日，转换为下一日零时的半开边界。固定活动团列表不接受客户端再次传 `combination_id`。单活动订单列表统一采用上述已付主单集合，关键字按字面匹配订单号、用户、电话、地址联系人、关联商品或活动；`%`、`_` 不是扩展匹配通配符。订单状态0额外要求未支付，与已付主单集合相交恒为空，UI 明示“未支付（此页无数据）”；不能因此把未付订单混入六卡或列表。输入验证见 [AdminCombinationStatisticsInput.ts](../src/services/admin/AdminCombinationStatisticsInput.ts)。

历史 `status`/`status_raw`、退款标记和缓存 `member_count_raw` 原值保留。`participant_record_count` 是所选团长加同活动所有子成员记录；`active_real_count` 仅表示当前 UID>0、非虚拟、非退款记录，不代表消费者的真实已付资格；`virtual_count` 另列。已过期但 raw status=1 只投影为 `expired_pending` 待结算；无效时间、未知状态、已注销/缺失用户、已删除/缺失活动通过 issues 保留，不悄悄修正或删行。所有这些 GET 不写状态、不提前成团、退款、扣额度或调用 provider。

成员弹窗使用团长 pink.id，保留所选团长和同活动当前非退款子成员；退款后替代团长 ID 只读展示。全局响应可保留历史 `combination_id=0`，但固定活动请求仍要求正 ID 且活动匹配；活动0不能跳统计页。UID0或虚拟标记明确显示“虚拟用户”。订单号只有服务端核对用户、活动、商品、人数、团长与订单身份唯一一致后才提供；前端同时要求 `detail_available`、未删除、真实成员、`order.view` 和合法字符串业务订单号，才跳转 `/order/{orderNo}`。原始 order key、数据库整数 ID、虚拟订单0、冲突或已删订单均不能作为详情入口。头像只展示安全公开预览，不签未知私有素材，也不 fallback 原始私有地址。实现见 [CombinationMembers.vue](../../view/admin-ts/src/pages/activity/CombinationMembers.vue) 与 [combinationStatistics.ts](../../view/admin-ts/src/api/combinationStatistics.ts)。

筛选先提交草稿再读取；切账号（含 ABA）、路由、tab、关闭弹窗或更新请求代际会取消并拒绝迟到结果。统计 head 和列表独立加载、独立重试。全局团、单活动列表、成员三处分页在加载或错误时不挂载，避免 count 临时清零将第二页夹回第一页；前端运行时包含实际 Element Plus 分页 setup 的双向翻页及错误挂载反例。页面证据：[CombinationGroups.vue](../../view/admin-ts/src/pages/activity/CombinationGroups.vue)、[CombinationStatistics.vue](../../view/admin-ts/src/pages/activity/CombinationStatistics.vue)、[combinationReadSession.ts](../../view/admin-ts/src/pages/activity/combinationReadSession.ts)。

### 完整筛选 CSV 与旧 Excel 的差异

旧 `index.vue:329–345` 逐页取数据后交二进制 Excel 工具；当前新增接口返回清单，浏览器生成 UTF-8 BOM、所有单元格双引号、逗号分隔及 CRLF 行尾的 CSV。固定11列为“编号、拼团名称、划线价、拼团价、库存、开团数、参与记录数、成团数量、销量、商品状态、结束时间”；兼容 key `people` 在导出中表示原始开团数，不是配置成团人数。金额全程字符串，不转浮点数；结束时间按 `Asia/Shanghai` 输出。标题公式注入在服务端处理，含前导空白/控制字符后的 `= + - @` 及首字符 TAB/CR/LF；内嵌换行保留，双引号仅按 CSV 翻倍，前端不 trim 或二次改变单元格。

导出每页默认及最大1000条，完整集合最多100000行、16MiB；单页 JSON 有4MiB上限（服务预留响应包装字节），超限明确拒绝并提示缩小范围或减小页量，不截断下载。第一页返回64位 hex `snapshot`，后续页必须带同一值；每页在独立只读 REPEATABLE READ 中重新核对全量有序集合指纹、筛选、limit、count 和完整 `csv_bytes`。数据变更即失败，需要从第一页重启，并非跨 HTTP 页长期持有数据库事务。

前端检查各页11列、key、snapshot、总数、容量和时区一致，拒重复 ID，必须直到 `has_more=false` 且行数、单 BOM/表头与所有行的 UTF-8 总字节精确一致，才生成一个文件。后续页失败、取消、换账号或数据变化均不留下部分文件；下载后 `URL.revokeObjectURL`。此容量内完整 CSV 是当前候选合同，不宣称无限数据量导出或原 Excel 格式等价。实现及验证见 [AdminCombinationExportService.ts](../src/services/admin/AdminCombinationExportService.ts)、[combinationStatistics.ts](../../view/admin-ts/src/api/combinationStatistics.ts)、[combinationCsv.ts](../../view/admin-ts/src/utils/combinationCsv.ts)。

### 本批验证状态与开放验收

本批[原生验证 JSON](../audit/combination-read-native-20260927.json)确认6文件 unique140项通过（新范围105、既有回归35）：初轮完整通过的4文件128项，加修订后2文件12项终态，不伪称一次140/140，也不把初轮135项加终态12项。权限26项、前端72项（新增读取33、既有完整表单39）通过；Worker 两种类型检查、Admin 类型检查与构建通过；目录台账17文件92/92通过。各层分别计账，不将前批640原生、39前端或113兼容项重新累加，也不计早期失败诊断。当前 raw Worker 注册1777条，Admin395个调用/419个变体；全 Admin 页面54 candidate/116 partial/97 missing/7 retired，营销15/17/16/0，四屏均为本地候选。

前端最终日志为外部 `combination-remaining-frontend-frozen-final-20260927.log`，SHA256 `8b5417f79e1dad187d9497c3c1bc4ed4bfea7cc67d7258be83209c87d9e9619a`；新增测试 [admin-combination-statistics-frontend.test.ts](../test/admin-combination-statistics-frontend.test.ts) 的 SHA256 为 `c547071131d53f63bb7a400c69bec6c484b5977982d4d6ba4c5b2a16744be578`。当前目录页面 SHA256 为 `0c58b2215d3c6f49339553cbde5d546aaab8f6b42b88fc0e8861d48824762b3a`；前批页面哈希仍只指原归档。新增读取源码归档 manifest 为 `3947f9f6069c5231219dc454e6f83f1994530d5ed4e03b21d16171420a12cb89`，最终 Admin 构建 manifest 为 `5c5408b329a9822b817163cb6bc43a3d3717d43fc5218ad4516becfbb8f2aade`，出处均在新原生 JSON。

本批[浏览器终态 JSON](../audit/combination-read-browser-20260927.json)使用最终本地构建和5202 loopback 内存 synthetic fixture，共192条共享请求，其中 `activityReads=69`、`backgroundPolls=94`；其余含登录、site_config 和 QA 控制请求，不混称业务读写。合成活动写入、真实业务写入和外部消息均为0。六种合成角色、跨页团/成员/订单、全局卡与筛选独立、head 与列表独立失败重试、过期待结算行、活动16六卡全零/空列表、订单状态0空集合均实测。样本活动六卡为31/16/16/5/支付毛额284.00/已付用户16，不能作为真实运营数据。

换号时 token 与 session storage 是两次独立写入，过渡窗口沿旧权限发出9条 GET，全部400011拒绝且没有返回数据；不能写“无权限视图零 GET”或“零权限错误”。角色稳定后，拒绝页面显示正确警告，缺少独立 `order.view` 时成员及订单详情按钮隐藏。fixture 为便于各角色导航提供全部菜单路径，因此真实权限和菜单映射由独立原生权限测试证明，不能用合成菜单冒充真实服务菜单；订单详情跳转合同由前端运行时证明，fixture 未验收真实订单详情正文。

浏览器实际执行的两页合成数据导出捕获1005条、11列、94543字节的 CSV Blob，BOM 为 `efbbbf`，1005个 ID 唯一、有序，公式保护、引号和内嵌换行已核对。通过临时转发 `URL.createObjectURL` 观察器捕获 Blob 的 arrayBuffer，不宣称 OS 下载完成或文件路径已确认。第二页 snapshot 变化和延迟第二页取消各产生0个 Blob。

实际390 DOM 中页面宽度/文档宽度均390，成员弹窗366，表格横向滚动局限于各自容器；桌面与移动布局均观察通过。手机图片仍有应用合成器缩放及灰边，这些 DOM 证据不是真机证明。两个验收页签 console 均为 `[]`，临时 Blob 观察器、CDP viewport 覆盖及 viewport 已恢复，页签9/10关闭。5202服务停止后独立确认 listeners=0，外部 `combination-read-browser-stop-20260927.json` 留存终态。以上不借用前批5201的190请求，也不能替代真实 JWT、数据库、R2、provider 或生产验收。

- [x] 本批隔离原生、权限及 Vue/Axios 运行时验证，Worker 双类型检查、Admin 构建。
- [x] 本批本地 synthetic CUA 六种角色、完整 CSV Blob 与桌面/390宽度验收、请求审计及 fixture/页签/viewport 清理终态；OS 下载完成未确认。
- [ ] 真实运营角色与 JWT、迁移部署后的数据库权限及真实历史数据读取/导出验收。
- [ ] 真实附件/R2 图片与头像、线上订单详情、生产配置及实际浏览器/设备验收。
- [ ] Linux CI、真实 provider/通知投递及正式发布验收。
