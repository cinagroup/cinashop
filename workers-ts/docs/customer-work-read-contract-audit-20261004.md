# customer 手机经营读链独立合同审计（2026-10-04）

本阶段保留完整 work/customer 最终目标，实施七个实际读页面：工作台、统计、订单列表与详情、售后列表与详情、物流。履约操作、商品、用户、资金及代客闭环仍开放；七页读合同不能关闭整个角色或 `menuRoleGates`。此文件记录独立审计与后续实际验证，不以路由已注册、源码字符串或服务名字证明页面/角色合同。

## 入批与所有权

独立审计仅拥有本文件与 `workers-ts/test/customer-work-read-independent-contract.test.ts`。两个路径在实际工具 `exec_command` 的 chunk `d04cef`、退出 0 中分别于 `2026-10-04T01:09:15.065Z` 与 `.066Z` 观察为不存在；此观察在 Root 入批验证完成之后。写前回执为 `.cache/customer-work-read-independent-before-20261004.json`，SHA-256 `e6b67f0933d8f9dc4d4577823e9e578de4338c034511a3ea59fe31a099a6de77`（1,181 bytes），包含真实观察工具/时间及入批、继承 master/reader 的摘要。前一 PowerShell 只读尝试 `771faf` 为语法失败、退出 1，没有产生不存在证明或文件写入，保留工具历史。

继承客服 master `workers-ts/audit/kefu-mobile-workbench-acceptance-20261003.json` 的实际 SHA-256 为 `b0a1b6eeafb3135a8236e54857a97f05a515d5999c6c98943d816cd0ff8bb246`（14,549,958 bytes）；继承 reader 为 `.cache/verify-kefu-mobile-workbench-acceptance-20261003.cjs`，SHA-256 `8a33807d1b709fb1115a2d6d3fc869b0248d666f227933df0de57a012fae9d8d`（13,449 bytes）。本审计不改继承证据。

## 旧角色与实际范围

PHP `app/controller/api/v1/PublicController.php:162,198` 以 `uid/account_status=1/customer=1` 显示 `/pages/admin/work/index`，不要求客服 `status=1`。`app/services/message/service/StoreServiceServices.php:113` 明确该字段为“手机订单管理”。因此 customer=1/status=0 是必须覆盖的正例，不能套用 Kefu 登录、门店 manager 或 Admin 身份。

PHP `route/api.php:699-781` 的移动 admin 组有 56 条方法/路径声明，使用普通用户 token。`app/http/middleware/api/CustomerMiddleware.php:34` 还宽放行核销店员、配送员，并有历史路径例外；不应以这段宽门控授予迁移后的全站经营能力。当前 TS `src/routes/v1/index.ts:1382,1546-1550` 的同名 API 使用 AdminJWT 和 Admin DB；新 UserJWT 读链须单独授权并留在普通应用连接，不能把 UID 注入 adminId。

旧工作台真实 Vue `view/uniapp/pages/admin/work/index.vue:19-125,179-224` 含今日金额/订单数/支付人数/浏览量、待发货/售后/补货/预警及六个经营入口；底栏 `pages/admin/components/footerPage/index.vue:32-53` 为工作台、商品、订单、用户。`/pages/work/*` 是企业微信 userid 链（`view/uniapp/api/work.js:21-57`），不能代替 `/pages/admin/work/index`。

旧工作台没有门店 selector。范围是混合的：周期/趋势/日明细及普通订单列表全站；工作台待发货 badge 单独为平台（store_id=0/supplier_id=0）；售后与库存 badge 全站。必须继续追至 Model：`StoreOrder::searchPidAttr(:370)` 把整型 `pid=0` 搜索条件转为 **pid>=0**，BaseDao::withSearchSelect(:304) 与 ORM ModelRelationQuery::withSearch(:163) 真正执行搜索器。因此这些读查询包含原单及正子履约，排除拆单支付头pid=-1；不能从 Controller 的字面 pid=0 猜成根单。该范围不能整体变成门店范围或平台范围。

## 七页读链分布

下表新页面位于 `view/uniapp-ts/src/pages/customer-work/`，每一项都有独立实际 SFC；旧页面位于 PHP 参考树 `view/uniapp/pages/admin/`。所有新 GET 前缀为 `/api/mobile/work`，先读 `context` 绑定当前用户、唯一 customer 授权及全站范围，再以 scope/consistency 指纹读取业务数据。

| 新页／旧路径 | 旧 API 读合同 | 新 GET |
| --- | --- | --- |
| `index`／`work/index` | `api/admin.js:664,671` staging/time，work Vue:179-224 的用户资料与今日数据。 | `context`、`overview`。 |
| `statistics`／`order/index` | `api/admin.js:17,25,671,657` statistics/data/time/time-chart，旧 Vue:78-81 的真实导入；1/7/30与每日分页。 | `statistics`、`trend`、`statistics/orders`。 |
| `orders`／`orderList/index` | `api/admin.js:33` order/list，业务状态、日期、订单类型、支付方式与关键字。 | `orders`。 |
| `orderDetail`／`orderDetail/index` | `api/admin.js:65` order/detail/{order_id}，原单/履约商品、会员优惠、退款链接、表单与拆单。 | `orders/{order_id}`。 |
| `refunds`／`refundOrderList/index` | `api/admin.js:454` refund_order/list，退款selector0/2/5/6、申请类型、日期与关键字。 | `refunds`。 |
| `refundDetail`／`refundOrderDetail/index` | `api/admin.js:73` refund_order/detail/{id-or-order_id}，退款原因/金额/凭证/原单/退回物流。 | `refunds/{refund_id-or-order_id}`。 |
| `logistics`／`logistics/index` | 旧 Vue 导入 `api/order.js:207` order/express/{uni}[/{type}]，type=refund 为退回物流。 | `orders/{business_id}/logistics`，退款模式独立重新核归属。 |

旧详情仍有本阶段未实现的展示：赠券实体/赠积分（旧 Vue:130-146）、虚拟交付内容（:162）、优惠券/积分/活动减免展开（:268-278），其 Controller `app/controller/api/admin/order/StoreOrder.php:140` 还调用优惠活动、赠券及拼团状态服务。基础 Kefu 投影不等于这些完整详情；应归入后续商品/资金展示合同，保持开放。新读链通过也不证明这些历史字段、履约写操作及全 work 角色已经完成。

## AdminStatisticService.mobile* 精核

| 当前方法 | 旧合同与范围 | 可复用边界／有意修正 |
| --- | --- | --- |
| `mobileOrderStatistics`（:488） | PHP StoreOrderServices::getOrderData(:280) + StoreOrderWapServices::getOrderTimeData(:37)。该 Controller 传 plat_type=0，六项业务状态计数为平台范围，其中五项传int pid0→pid>=0、待核销项不传pid。今日/昨日/月金额及数量全站pid>=0。 | 当前 TS 全状态计数全站且硬pid=0，均不同。旧总order_count/sum_price还有uid=0条件，searchUidAttr(:452)不跳零，实际通常返回0；旧Vue仅赋census而模板未用，不复刻此坏字段。新全站总量及统一软删除过滤须明确为修正；平台状态范围仍保留。 |
| `mobileOrderStaging`（:590） | PHP getStagingData(:329)：仅待发货 plat_type=0；退款全站；库存 pid=0。 | 当前 SQL 保留混合平台/全站范围，但待发货硬 pid=0 同样漏正子履约，不能直接复用。商品模型的 pid=0 则是真实商品根节点。预警实际为 is_show=1/is_verify=1/is_police=1/stock>0；旧阈值分支已注释（StoreProduct::searchStatusAttr :660-692），不能改成 stock<=配置值。 |
| `mobileOrderData`（:626） | PHP WapServices::getOrderDataPriceCount(:61)、DAO(:581)：全站 pid>=0 已支付、退款状态0/3，Asia/Shanghai 日分组、降序分页。 | 当前硬pid=0会漏正子单。旧 MySQL group 取非聚合 add_time 不确定，TS使用 MAX。访问量按当天00:00取，而旧按任意组内 add_time+86400。页数/跨度/limit明确有界。 |
| `mobileOrderTime`（:664） | PHP Controller::time(:377-418)：1/7/30，Asia/Shanghai，全站 pid>=0 已支付、退款0/3，支付人数distinct uid，访问量全站。BaseDao::sum(...,true)(:399)使用搜索器。 | 当前硬pid=0会漏正子单；左闭右开到 now+1 含当前秒，等时长前期。旧外部 getFrontTime 定义未在可读参考树中找到，不能凭调用名证明所有前期边界逐秒一致。 |
| `mobileOrderTimeChart`（:707） | PHP Controller::timeChart(:427-478)、DAO(:595/612)：全站pid>=0；type=1昨日+今日；7/30含连续日期，空日补0。 | 当前硬pid=0会漏正子单；完整 YYYY-MM-DD 分组、Asia/Shanghai、is_system_del过滤、含当前秒修正旧只按MM-DD分组和漏系统删除过滤，明确保留差异。 |

当前 merchant manager 统计以 store_id 和 pid>=0 物理履约为范围，见 `StoreManagerScope.ts:34-50`、`StoreManagerOrderStatisticsService.ts:19-82`，不得直接赋给 customer。`OrderReadStatusPredicate` 可复用业务 selector，调用者必须另明确当前用户、范围、父子及删除条件。`AdminOrderReadService` 是现代物理履约和原始 status 合同，也不能直接冒充旧移动列表。

新 customer reader 统一六张状态卡的物理履约范围 pid>=0；旧待核销卡没有 pid 条件，因此可能包含负支付头。新排除负头是明确的去重修正，不能声称六项旧计数完全逐秒逐行同义。其余统一系统删除过滤、全站总量修复、完整年份日分组及确定性访问日期也各按上表保留差异。

## 首批必需验证矩阵

| 维度 | 必须覆盖的正例与拒绝例 |
| --- | --- |
| 当前身份 | 唯一有效 customer1/account_status1/status0、status1；普通用户、纯客服customer0、manager-only、verify-only、delivery-only、匿名、禁用/删除用户、删除/撤销/重复客服身份不得获得customer读能力。 |
| 统计范围 | 平台、门店、供应商原单与正子履约进入全站统计；pid=-1支付头不重复计；平台待发货badge及平台状态counts排除另两域；退款/库存badge保持全站；未付、退款状态、已删除/系统删除逐项。 |
| 库存 | is_police1且stock>0，包含高于旧配置阈值的商品；stock0、无police、下架、未审核不得冒充预警；售罄is_sold1或stock0，库存根商品pid0。 |
| 业务 selector | 订单全部转空值，0待付款不能被 falsy 丢失，1包括原始status0/4，2收货/核销，3待评价；退款0→[0]、2→[4,5]、5→[0,1,2,4,5]、6→[3,6]。 |
| 读快照／撤销 | 单请求 RR只读同快照；每次新请求重新核当前用户/customer归属；撤销、禁用、换号或同UID ABA 后旧返回不可应用；无Admin权限提升。 |
| HTTP域 | 实际签名UserJWT正例；AdminJWT、KefuJWT、visitor/伪UID、缺token拒绝；实际业务运行 ordinary LOGIN，不能SET ROLE或维护者假扮业务。 |
| 时间／分页 | Shanghai午夜前后一秒、当前秒/结束边界、today昨日+今日、7/30零填充、distinct人数、前期为0、日明细降序、page/limit边界与空页；非法日期/selector/多值/重复参数拒绝。 |
| 实际页面 | 七页从work进入；正确的列表→详情→物流/售后导航；loading/error/empty/重试；换号、超时、隐藏卸载、晚到结果不显示旧账号；未实现经营操作明确保留开放。 |

真实 PostgreSQL、签名HTTP及权限/撤销矩阵由后端独立普通LOGIN fixture验证。此审计的独立测试执行实际 service/解析器/DTO/composable/SFC方法，窄平台或HTTP传输可替身；替身测试不当作真实SQL、原生设备、provider或生产授权证明。

## 独立执行与发现

首轮窄 Vitest 执行 `run01` 在 `2026-10-04T01:24:16.914Z–01:24:28.016Z` 实际退出 1，suite 在收集阶段失败、0 个测试执行。实际工具 `4422d4` 启动 session `56279`，`2d180e` 取得退出码；前端 utils 正在从重复实现迁移到共用 parser，临时出现 `parseCustomerWorkQuery/customerWorkRoute` 重复导出。`execution.json` 为 `.cache/customer-work-read-independent-20261004-run01/execution.json`，SHA-256 `0c3f5808fb4ecf8437a94f601365f01f668a2e5dfc2eb2caea39f4bbdcb6974e`（1,888 bytes）。该目录保留原始输入、stdout/stderr 与 JSON 报告；Scope、types、utils 三个源码变动被 source_drift 检出，不把该轮记为通过。

独立检查已反馈三处实际消费者缺口：envelope actor 与 context.profile.uid 交叉绑定；合法 cancelled raw status=-2；statistics SFC 今天模式误把昨日+今日两点判作长度 1。这些须执行实际 DTO 与编译后的 SFC 方法来回归。图片 DTO 另需无 URL global 的 mini 场景，拒绝逐层解码后的 `..`、协议相对路径和凭据 URL，复用现有 common public-image validator。后续冻结后的执行回执在本节补齐。

`run02` 在 `2026-10-04T01:41:00.243Z–01:41:08.505Z` 实际退出 1，0 个测试执行。工具 `e0accb` 返回完整退出结果；独立 SFC harness 从空的主 checkout UniApp node_modules 解析 Vue 失败，utils/API 两个输入同时发生 source_drift。回执 `.cache/customer-work-read-independent-20261004-run02/execution.json` 的 SHA-256 为 `bea2ab882055c432df97b630e0cecd5258d98ada41cfdd75d9edd3a8058eee03`（2,152 bytes），保留失败输入及 JSON，不把错误计为通过。

`run03` 改用既有物理 UniApp 依赖 rehearsal，未安装或建立 junction。工具 `58dcd8` 在 `2026-10-04T01:44:45.715Z–01:44:53.979Z` 取得实际退出 0，**60/60 测试通过、0 pending、source_drift=[]**。回执 `.cache/customer-work-read-independent-20261004-run03/execution.json` 的 SHA-256 为 `b5bae8306c5aa97ac1cacbe2cacf0b5d3e626d08d678bdaec8952e566ada9dff`（2,060 bytes）；输入清单 SHA `56e38aef16763cc120fc8f03f0e34de651ade494089819939f6c85fe5de3cb7a`，JSON结果 SHA `7264b3c0638f6999197faad66d498150f3b20c615a257239a0ca2f4db44604e3`。29 个直接关键输入有原始副本，包含实际 service/DTO/helper、七页、composable/API/shared路由、Vue编译器/响应式实现及锁文件。实际 Vue 响应式与编译 SFC 保留，auth store、平台生命周期/导航及HTTP交付为受控边界。

该60例验证实际 Scope service 的快照内授权和发布前撤销、修改密码/身份/expiry拒绝；新 CustomerWorkReadService 的精确0.29−0.28金额投影、两日趋势、每日分页传真实FE守卫；UserJWT GET白名单、timeout、旧会话expiry不会清除新会话；七个SFC实际读取/清空，状态0、错误业务编号、重复分页、same UID登录revision ABA晚到及raw H5冲突。它们不验证真实SQL筛选、普通LOGIN、实际HTTP鉴权/路由、设备DOM或物流provider，这些由独立原生/运行时回执分别证明。

run03 后 Scope 增加“当前经营员没有自己的订单时仍将其资料纳入一致性摘要”的SQL，composable接口也发生类型明确化；旧源码副本与run03结论仍绑定旧版本。另独立发现“已删除”列表含 is_del1，但详情只读取 is_del0 的导航断链，旧 PHP detail 无此条件。最终源码必须独立重跑再登记最终输入，不以旧通过、函数语义相似或未执行例外覆盖新版本；重复执行同60例只计60个唯一验证。

最终修正后的 `run04` 已实际执行：工具 `557ce5`，`2026-10-04T01:56:14.473Z–01:56:22.776Z`，退出0，**60/60、0 pending、source_drift=[]**。回执 `.cache/customer-work-read-independent-20261004-run04/execution.json` SHA-256 `d4a3d2b5b2b0276d18218edb2652a180906006dfc7c93b2d97637f6e1e6ddc8d`（2,060 bytes）；输入清单 SHA `b9d45b204ca971dc1fed4506c5cf019a9ebd95eb4ced57b40b24206b6424cd42`，实际JSON结果 SHA `7465c1cbf0770cf7df9415d9baedf634a8f8193903135758435f0535061ff6a9`。此次30个关键输入原始副本增加新改动的 ExpressService，重新执行最终 Scope/Reader/composable，非未执行例外。独立唯一验证数仍为60。

后端原生最终回执已单独只读核对（工具 `b9676e/860268/1e10cb`），不是转述pass标签：`.cache/work-mobile-backend-native-deleted-express-final-20261004.execution.json` raw/LF SHA-256 `63fdf239d7b09f637e7a34aeb5c6701a5d280b17e4f4c1b45d1ec84a1534b1dd`（270,451 bytes），实际执行工具 `23b5ea`，`2026-10-04T01:53:55.504Z–01:54:19.654Z`，exit0/sourceDrift=[]；原始stdout SHA `3e83569c885c6487a11c7768d2fbff549de7a59b44854cd3f4f3e9fbb125ee54`（6,059 bytes）、stderr空。stdout逐项列22个实际native测试、22/22通过及fixture remaining=0/cluster stopped；包含全部10个SELECT-only普通LOGIN实际reader返回传真实FEguard、经营员资料一致性/actor复制、已删列表→详情→物流并保持默认读者拒绝删除/System删除不绕过。物流允许用户软删的选项只由已授权customer reader显式传true，默认行为不变。原生22与独立60是不同验证集合；H5/mini构建、用户中心/Theme页面真实运行时及生产规模另由Root收集，不能由本60或22替代。

run04后，前端真实H5验证又修复picker卸载异常，statistics模板改为picker常驻、summary单独清空；本审计编译SFC方法不冒认浏览器DOM验证。写after尝试 `25a7e4` 退出1，当前hash复核检出statistics.vue已变化，未生成producer JSON；已写出的第一份owned-after目录两文件原始副本保留。最终再运行 `run05`：工具 `5488aa`，`2026-10-04T02:00:47.142Z–02:00:53.294Z`，实际退出0，**60/60、0 pending、source_drift=[]**。回执 `.cache/customer-work-read-independent-20261004-run05/execution.json` SHA-256 `daef4021dbf61db271b026070bd5bfa66975ea3de711679fd6be4bc73fd5552e`（2,060 bytes）；30输入清单SHA `efea16a3e2cf20f5a362592f4d3cefa3b7380062322ba410d44274e0b25ccd5d`，JSON结果SHA `9ef95ee6d62bd7473bb84b8903288a6e2a50bcad97b543a626d311f9ba33a073`，实际新statistics页面SHA `31556009c7f4b56eaa1589f0dfe00d3fe88bcc0e579a1b12bac980adad3af51a`。五轮执行与失败after观察都保留，最终结论绑定run05的冻结输入；三次通过仍只计60个唯一独立验证。
