# 优惠券模板本地合同

日期：2026-09-27。本文件描述 `/marketing/coupon-templates` 的当前实现，承接旧 `/admin/marketing/store_coupon/index` 的模板操作。模板目录与独立的发行管理、发行创建、用户领券记录分别计账。本文件不是生产开通记录，也不单独决定路由候选状态；本轮测试终态与浏览器证据仍须按文末核对。

## 旧页依据及明确差异

旧组件为 `cinashop-php/view/admin/src/pages/marketing/storeCoupon/index.vue`，路由在 `view/admin/src/router/modules/marketing.js`。`route/admin.php:955–967` 的七个旧接口分别服务列表、创建动态表单、保存模板、删除、立即失效、发布动态表单和发布。旧控制器、服务与 DAO 为 `app/controller/admin/v1/marketing/coupon/StoreCoupon.php`、`app/services/activity/coupon/StoreCouponService.php`、`app/dao/activity/coupon/StoreCouponDao.php`。完整冻结分析见[旧 PHP 合同分析](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-template-contract-analysis-20260927.md)。

旧可见操作只有添加、有效模板立即失效、删除、有效模板发布。未挂按钮的 `edit` 方法及 API import 不构成编辑合同，旧模板路由也没有对应更新接口。新页同样不提供编辑或重新启用；关闭状态的新模板不能通过本页重新开启。立即失效是单向业务操作，不是可逆开关。

旧动态表单由 `components/from/from.vue` 为模板 action 添加通用、品类、商品三个范围选择。商品字段 `image` 是包含 `product_id` 的选品对象，不是封面或图库资产。新页使用真实商品 ID 选择器，不要求图库权限，不新增模板媒体上传、R2 或外部图片消费者。

旧列表按 `sort DESC,id DESC` 排序，默认每页15条，过滤软删模板。旧页面初始状态为空、显示全部；新页按明确取舍初始显示有效，仍可切换全部/有效/失效。名称搜索改为字面匹配，额外支持正整数 ID；`%`、`_` 不作为用户可控通配符。新页增加详情及发布次数、发布记录，时间明确按上海时区显示，不依赖浏览器本地时区。

旧创建表单的面额和领后有效天数允许0。新实现要求面额大于0、有效天数为1–3650：当前领取链中 `day=0` 需要固定使用结束时间，而模板表单没有该字段，不能把零天冒充永久有效。最低消费仍可为0。旧限量配置也允许矛盾的0数量，新实现要求限量数量大于0、不限量数量为0。这些是明确的输入收紧，不宣称数值宽容度与旧页完全相同。

旧模型指向 `store_coupon`，但所检旧安装 `public/install/crmeb.sql` 没有对应建表，只有发行及领取链表。不能据旧模板源码宣称旧安装包已经具备可运行模板表，也不能据缺表将整个旧页自动退役。本轮建立新系统的独立实体，不迁入旧模板数据。

## 接口、页面与权限

九个操作在 `/adminapi` 和 `/api/admin` 各注册一次，共18条路由。静态 options/products 及 `/:id/issues` 先于动态详情注册。见[双面主路由](../src/routes/adminapi.ts)、[v1 路由](../src/routes/v1/index.ts)、[专用控制器](../src/controllers/api/v1/AdminCouponTemplateController.ts)。下表省略两个前缀。

| 方法与路径 | 行为 | 权限 |
| --- | --- | --- |
| GET `/marketing/coupon-templates` | 模板列表与总数 | `coupon_template.view` |
| GET `/marketing/coupon-templates/options` | 可选平台分类、容量合同 | `coupon_template.view` |
| GET `/marketing/coupon-templates/products` | 分页选品 | `coupon_template.view` |
| GET `/marketing/coupon-templates/:id` | 完整模板、引用状态、revision | `coupon_template.view` |
| GET `/marketing/coupon-templates/:id/issues` | 仅归属证据关联的发行记录 | `coupon_template.view` |
| POST `/marketing/coupon-templates` | 创建模板 | `coupon_template.manage` |
| POST `/marketing/coupon-templates/:id/invalidate` | 模板失效并停止关联发行 | `coupon_template.manage` |
| DELETE `/marketing/coupon-templates/:id` | 仅软删模板 | `coupon_template.manage` |
| POST `/marketing/coupon-template-issues` | 从有效模板创建独立发行 | `coupon_template_issue.manage` 且 `coupon_template.view` |

管理权限沿现有规则包含本组查看权限，不能跨组获得发布权限；原 `coupon.view/manage` 仍属于发行实例管理。发布控制器除路由认证外再次校验模板查看权限。两个权限组使用同一页面路径，因此只有发布权限的角色可能看到导航入口，但没有模板查看权限时稳定页面显示警告，不再读取目录或选项，后台复合发布检查也拒绝；换号过渡GET仍由服务器拒绝并丢弃旧上下文响应。菜单可见不等于获得数据权限。见[权限与旧菜单映射](../src/services/admin/AdminPermissionService.ts)、[页面](../../view/admin-ts/src/pages/marketing/CouponTemplates.vue)、[前端 API](../../view/admin-ts/src/api/couponTemplate.ts)。

响应使用 `Cache-Control: private, no-store`。五种读取采用同一事务内的 REPEATABLE READ、READ ONLY；列表与 count 不跨快照。statement/lock/idle 上限分别为5/2/5秒，保留调用方更严格的限制。列表、选品、记录默认15条、最多100条，偏移最多10000；超界拒绝，不能把截断集合称为全量。分类读取有5000项完整容量界限，发现超量、孤儿或循环时拒绝。

查询参数采用白名单，拒绝重复或未知参数。详情、选项和写接口不接受 query。写 body 必须是最多16KiB的 JSON 对象；路径、body 身份及字段均严格校验。发布只从 body 的数字 `template_id` 取得唯一身份，不能通过 body 覆盖源模板的金额或范围。

## 独立实体与约束

模型见[coupon_templates.ts](../src/models/schema/coupon_templates.ts)。新增两表，没有把发行目录重命名为模板，也没有给既有商品范围关系混入模板 ID。

| 实体 | 固定字段与约束 |
| --- | --- |
| `store_coupon_template` | `id serial`；非空白 `title varchar(64)`；`scope_type` 为0/1/2；`category_id integer`；`product_ids varchar(500)`；`coupon_price numeric(12,2)` 大于0且有限；`use_min_price numeric(12,2)` 非负且有限；`valid_days` 为1–3650；`sort` 非负；`status/is_del` 为0/1；`add_time` 为非负整数。 |
| `store_coupon_template_issue` | `issue_id` 为主键并外键引用既有 `store_coupon_issue.id`；`template_id` 外键引用模板；`issued_at` 非负；`source_revision varchar(64)` 必须为小写 SHA256 十六进制。两外键均不级联删除/更新。`template_id,issue_id` 索引覆盖按模板读取与外键首列需要。 |

范围0要求分类为0、商品串为空；范围1要求单个正分类 ID、商品串为空；范围2要求分类为0及非空商品 ID 串。数据库约束 CSV 形状、正 int32 范围、最多100项及500字符容量；数据库不负责排序、去重或查验商品/分类业务状态。应用输入拒绝重复、排序成规范 CSV，并在创建、发布时检查真实范围。不能把应用的 canonical 保证写成数据库可拒绝所有乱序或重复 CSV。见[严格输入](../src/services/admin/AdminCouponTemplateInput.ts)。

分类只允许平台分类，选中节点及全部祖先必须可见、没有断链。写入按 ID 顺序锁定祖先链并复核父关系、显示和归属；商品写入锁定完整已选的未删除商品集合，少一项就拒绝。商品选择跨页保留已选 ID，不仅提交当前页。超出100项或500字符时保留选择供减少，不静默截断。历史引用缺失或被删除会以无效原因显示，阻止发布；仍可失效或软删。

`issue.cid=template.id` 只保存兼容字段，归属权威是新 proof。新序列生成的模板 ID 即使与旧孤立正 `cid` 相等，也不会自动认领旧发行、补 proof、改旧 `cid` 或在失效时停止无 proof 的发行。发布商品券时，`store_coupon_product.coupon_id` 仍只能是新发行的 `issue.id`。

模板 revision 是源定义、状态、软删标记及创建时间的摘要，发布次数不参与它；独立发布可以复用未变化的源 revision。proof 的 `sourceRevision` 固定来源版本与关联身份，不是发行所有字段的永久不可改历史。既有发行管理仍可独立编辑发行实例；发布记录显示该实例当前标题、标记和数量。结算仍由现有 issue/user 及范围权威判定，不改为读新模板。

## 创建、发布、失效与删除

[服务](../src/services/admin/AdminCouponTemplateService.ts)仅暴露创建、失效、删除、发布四种写操作。模板定义创建后不能经本 API 修改或恢复；数据库的状态列授权本身不是禁止维护者恢复状态的单向触发器。受限 Admin 无权修改定义列或 proof，维护连接仍是明确的信任边界。

创建只写模板及审计，不创建发行或用户券。标题按 NFC/去空白规范并限制64字符，金额必须使用至多两位小数的十进制字符串，不接受浮点数、指数或非有限值。排序与数量为有界整数。发布持模板行锁后复核 revision、有效/未删除状态及范围，复制标题、金额、最低消费、领后天数、排序与范围到新的发行实例，同时写商品范围、proof、审计。每次不同 request ID 的发布都是独立发行，不等于已经给用户发券。

| 旧发布用途 | 新发行字段与实际边界 |
| --- | --- |
| 普通 | `receive_type=1`、`category=0`、`app_type=0`，进入普通领取路径。每人限领固定1；并非模板表单新增可编辑限领项。 |
| 新人 | `receive_type=2`，保留 `is_give_subscribe=1` 元数据。发布不会自动配置注册投递；仍须独立的新人开关、注册赠券开关及 `register_give_coupon` 明确发行 ID。 |
| 赠送 | `receive_type=3`，保留 `is_full_give=1` 与 `full_reduction`。须通过明确后台/商品等赠券渠道关联发行 ID；满赠金额不是自动投递指令。 |

旧 `upIssue` 仅写用途 flag、未补当前消费者需要的 receive_type。上述桥接是明确的新合同。未发现旧满赠求和方法对应的实际自动投递调用链；本轮不实现或宣称金额自动满赠、首次关注自动投递、自动修改注册配置。新人弹窗或用途标签也不是领取资格证明。真实消费者分别见[注册赠券](../src/services/activity/StoreNewcomerService.ts)、[商品支付后赠券](../src/services/activity/ProductCouponService.ts)。

公开[手动领取](../src/services/activity/ActivityService.ts)现在在发行行锁内要求 `receive_type=1/category=0/app_type=0`，拒绝以直接 ID 绕过目录领取新人、赠送、未知或会员/弹窗类型。此处不是新增完整会员、新人自行领取授权。可信注册和商品赠券保持各自配置、发行锁、领券来源及幂等证据。

领取窗口可两端全空，或同时提交精确 UTC 时间且开始早于结束、结束晚于数据库当前时间。页面输入按上海时区转换为 UTC。窗口决定能否领取，不代替领后使用有效天数。不限量发行固定总/余量0；限量固定正总量并令初始余量等于总量。

立即失效先持模板锁，再按发行 ID 顺序锁定所有 proof 关联发行并设 `status=-1`，最后模板 `status=0`；关闭发行也包括在内。集合在 SQL 中处理，不无界拉入应用内存。发布、失效、删除在同一模板锁上串行；发行锁与领取、可信赠送保持现有同步边界。

删除只设模板 `is_del=1`。两种操作均不删除 proof、发行商品范围、用户券，不改已领取或已预占的券，不取消订单或改写其重试身份。现[结算范围权威](../src/services/order/CheckoutCouponTemplateAuthority.ts)的 Template 名称实际上指既有发行实例；仍用已领券金额/时间及现发行范围核验，不因新源模板失效而撤销已领权益。对于已预占/订单边界，应以最终实际建单原生测试结果为证据，不能用手工插入用户券替代。

所有写入为 READ COMMITTED 同一事务；模板、发行、范围、proof、审计任何一步失败都会回滚。审计记录兼作内容摘要重放证据；序列在事务回滚后可能留间隙，不做 setval 修复。

## 幂等、未知写及会话

服务按管理员 ID 的 advisory 锁串行检查 `actor + UUID`，指纹绑定操作、目标、源 revision 和规范化 body。相同 UUID 且完全相同 intent 重放原身份；更换操作、目标、版本或内容会拒绝。发布重放还必须找到匹配模板与源 revision 的不可变 proof；不能仅凭 `cid` 或相似列表行猜结果。不同 UUID 的相同内容是新操作，允许再次独立发布。

前端对明确业务拒绝保留草稿并只读刷新。网络中断、超时或不能证明成功身份的响应会保留本次 UUID 与完整 body，进入待核对状态，阻止新写。恢复只 GET 列表、详情和近期发行记录，不自动重提 POST/DELETE，也不因相似记录或查询不到记录就自动认定成功/失败。没有按 UUID 读取权威操作状态的新增接口。

“已人工核对，结束此次操作”经过再次确认，仅解除本地待核对状态，没有数据库写入。随后再次保存/发布会生成新 UUID；该人工判断是信任边界，不能声称系统已经证明旧请求未提交，或绝对杜绝错误人工确认后的重复发行。待核对内容保存在当前页面内存，不是跨刷新、关闭页面或退出账号的持久恢复队列。

页面对请求、确认框、编辑器与选品分别维护代际和 AbortController，校验 token、用户、权限及 storage 会话。跨标签换号和 A→B→A 会使旧响应失效；迟到写响应不能关闭新账号表单。会话切换清理旧账号的数据和草稿。取消客户端请求不能撤回已经到达服务器的写入。浏览器合成会话验收与真实 HTTP 权限检查须分别报告，不把导航 fixture 当真实菜单授权证据。

## 建库、显式升级与运行权限

新增[外部 0169](../migrations/0169_coupon_template_catalog.sql)与[内嵌 0175](../src/services/MigrationService.ts)，当前正式链为外部171文件、内嵌176步、281表。两种 SQL 来自同一[固定目录合同](../src/migrations/couponTemplateCatalog.ts)。新建路径注册两张空表；没有业务模板种子，不写发行、商品、领取、余额、配置或历史日志。

已有系统使用显式维护入口 [runCouponTemplateCatalog](../src/migrations/runCouponTemplateCatalog.ts)，不通过 HTTP 自动建表，不用重跑完整 bootstrap 代替独立升级。入口开启自己的 READ COMMITTED 写事务，固定维护 advisory gate，锁既有发行及新表，验证精确列、默认值、约束、索引、普通表属性、无额外触发器/规则与 serial 归属；拒绝部分对象和漂移，不自动修复。重复执行保留对象身份、权限和数据。DDL 不授予运行角色权限。

运行权限另由显式[新系统 commissioning](../src/migrations/runRuntimeBusinessCommissioning.ts)或[既有角色窄升级](../src/migrations/runCouponTemplateRuntimeUpgrade.ts)开通。Admin 仅获得两表 SELECT/INSERT、模板 `UPDATE(status,is_del)`、模板序列 USAGE；无模板物理 DELETE/定义列 UPDATE、无 proof UPDATE/DELETE、无序列重置或转授权。APP 不获得新表及序列权限。状态列 UPDATE 允许业务行锁，不等于开放全表 UPDATE。

既有角色升级只接受精确 `pre-coupon-templates` 阶段，固定增加以上权限，复核 current 后返回；不接受任意对象/权限清单，部分或过量授权一律拒绝。原秒杀 schedule/parent forward 固定其历史权限阶段，不把新 current 的缺表要求套到旧库，也不重放新权限。已完成新阶段的系统不应把历史 forward 当成通用重开通入口。

current 的只读[权限审计](../src/migrations/auditRuntimeBusinessPrivileges.ts)同时要求精确新表目录及维护者所有权。首次 commissioning 与窄升级在结构校验后取得固定两表锁，再次校验；最终授权后再校验。并发维护 DDL 若先持锁，等待结束后的结构变化会拒绝授权。不会把 schema 修复或默认广泛 GRANT 混入业务请求。

## 验证入口与截至记录

以下为2026-09-27最终本机验收。混合数据库套件、完整文件通过和失败套件内的部分绿项分别计账；不把这些结果视为生产开通。

| 检查 | 现有证据及当前结论 |
| --- | --- |
| 模型、DDL、权限计划、本机元数据门禁 | [catalog 测试](../test/coupon-template-catalog.test.ts)、[权限计划测试](../test/runtime-business-privilege-plan.test.ts)、[表目录门禁](../test/table-catalog-gate.test.ts)，本机单元3文件51/51。此数不再与后续重跑重复相加。 |
| 业务、领取、正式并发及HTTP | 首批仅保留[模板 SQL](../test/admin-coupon-template.test.ts)30项和[手动领取](../test/coupon-manual-claim.test.ts)8项；旧HTTP7项和失败的旧postgres7项整文件退出最终计数。最终[原生并发](../test/admin-coupon-template-postgres.test.ts)9项与[实际HTTP](../test/admin-coupon-template-http.test.ts)8项完整17/17。四文件共55项唯一通过，来自两批，不能称一批55/55。实际App/Admin LOGIN、JWT、组合发布权限及正文冒充uid均已验证。 |
| 结构及升级批次 | [运行权限9项](../test/runtime-coupon-template-privileges.test.ts)、catalog28项、[拼团迁移20项](../test/pink-success-notice-migration.test.ts)、[秒杀路径2项](../test/seckill-time-reference-lock-upgrade.test.ts)，隔离 PG16 运行器4文件59/59、无 skip、fixture=0 且已停止。catalog28包含始终使用 PGlite/静态断言的27项与在该运行中使用真实 PG 的 ORM1项，不称59项全部是原生 SQL 用例。 |
| 已领与已占券消费者 | 原生9项包含实际App报价、钱包及StoreOrderCreateService未付款建单、占用券、停发后的同key重试；停发保留已有券资格，已有占用仍不能被另一单复用。旧消费者23文件首批21个完整文件370项通过；两份Out源文比对因CRLF/LF失败，保留失败日志并仅规范换行后整文件重验11/11。最终23文件381项唯一通过，含静态及原生用例，不能称一批381/381或381项全为原生SQL。 |
| 九路径完整 schema | [审计脚本](../scripts/orm-ddl-audit.ts)九路径均通过：281表、3901列、679约束、1080索引、228序列，外部/内嵌/ORM差异为零。每条路径先确认两张新表已注册，再重复独立升级，空表无seed、身份/ACL保留。首轮旧227总数门禁和第二轮磁盘不足的失败日志保留，第三轮完整通过且fixture=0、集群已停止。 |
| 页面、类型与构建 | [真实Vue运行时测试](../test/admin-coupon-templates-frontend.test.ts)41/41，Admin类型检查及最终构建通过；Worker unit/runtime类型检查通过。实际最终dist合成浏览器验证三范围、三用途、跨页选品、取消、五种权限、五读取故障、未知结果只读核对及人工确认。390 CSS像素下根页面无横向溢出；截图尺寸与DOM模拟尺寸分别记录，不冒称实体设备。 |
| 权限与台账 | 权限/认证2文件28/28；逐屏台账17文件93/93。Admin404调用点/428变体全部注册可执行；全Admin55候选/116部分/96缺失/7退役，营销16/17/15/0；复选框246/158/404不变。 |

原始阶段日志：[业务首轮](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-template-native-scope-20260927.log)、[结构59项](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-template-native-schema-20260927.log)、[九路径首轮](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-template-orm-nine-paths-20260927.log)。[独立结构核对](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-template-schema-review-20260927.json)记录结果边界、当前快照推导与冻结源 hash。

最终证据：[业务与结构](../audit/coupon-template-native-20260927.json)、[合成浏览器](../audit/coupon-template-browser-20260927.json)、[总验收](../audit/coupon-template-acceptance-20260927.json)。原拼团、秒杀、充值已接受JSON与字节归档保持历史口径。所有本轮测试集群和浏览器服务已停止，临时标签页及视口模拟已清理。完整Linux、真实配置/角色、真实设备/渠道及发布仍开放；本轮本地验证不等于生产投递或部署完成。
