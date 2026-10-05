# Admin marketing 旧路由逐屏代码审计

## 2026-09-30 第N件N折两屏续批

旧 `/admin/marketing/discount/pieces_discount` 与 `/admin/marketing/discount/add_pieces/:id?` 两屏missing→candidate，营销48屏 **31候选／12部分／5缺失／0退役**，全Admin274屏 **83／111／73／7**。新 `/marketing/nth-discounts` 列表与创建/编辑页接双Admin前缀各10项接口，独立 `nth_discount.view/manage` 精确承接旧1397/1401菜单。恢复三种规则类型、名称/启停筛选、15条分页及真实统计；表单恢复第二件半价(2,50)、买一送一(2,0)、自定义正整数门槛与0..100百分比、付后标签100、叠加1/3/5及具体父商品SKU/品牌/商品标签范围。按参与件数合计达标后最低价单件仅优惠一次，不循环，不增加赠品；排除SKU与自定义0%为旧UI隐藏输入扩展，限购字段不成为新管理能力。

隔离PG16九文件 **86/86** 通过，真实管理/报价/建单、付后标签、履约拆单及第N件连续退款物化均有证明，夹具清零、集群停机；前端 **4/4**、审计 **27/27**（含API10/10）、Worker双类型及Admin类型/构建通过。桌面与390px合成API浏览器通过，真实受限角色、生产统计/规模、Linux/Hyperdrive、UniApp原生类型/构建及发布仍开放。本地未提交、推送或部署。Worker **2038**、新Admin **97** 业务页、**529** 调用点／**553** 可执行变体，旧PHP903精确/46.7%有效覆盖，Checklist仍 **246／158／404**。见[合同](admin-nth-discount-route-contract.md)、[验收](../audit/admin-nth-discount-acceptance-20260930.json)、[日期营销台账](../audit/admin-legacy-marketing-route-parity-nth-discount-followup-20260930.json)与[路由分布](checklist-route-contract-distribution-20260928.md)。下方保留前批口径。

## 2026-09-30 满减满折两屏续批

旧 `/admin/marketing/discount/full_discount` 与 `/admin/marketing/discount/add_discount/:id?` 两屏missing→candidate，营销48屏 **29候选／12部分／7缺失／0退役**，全Admin274屏 **81／111／75／7**。新 `/marketing/full-discounts` 列表与创建/编辑页各使用双Admin前缀的10项接口，`full_discount.view/manage` 精确承接旧1396/1400菜单。列表恢复名称、启停及满元/满件筛选、15条分页、商品数、规则说明和支付订单/客户/实付金额；表单恢复100级以内递增阶梯满减/满折、单层循环满减、上海秒级时段、付后标签、叠加1/2/5及具体父商品SKU/品牌/商品标签选择。旧UI隐藏的排除SKU为明确扩展。满折历史0%可回显；跨页选品保留具体SKU，失效身份、未知保存及状态变更均受保护。type1/type3共用 `time_discount_catalog/platform_type_1` 目录锁，管理独占、建单共享，锁后按数据库时间重报价。

隔离PG16本批11文件 **85/85** 通过；真实拆单/退款补充发现并修复补偿旧均分错误，最终四文件 **95/95** 通过，两批有重叠不合计为180项，夹具清零且停机。前端两文件 **8/8**、审计 **27/27**（含API合同10/10）、Worker双类型及Admin类型/构建通过。桌面1440×1000与移动390×844合成浏览器API流程通过。本批纠正此前限时折扣实际统计仅计pid=0的遗漏，pid=-1原支付根仅计一次，子单不重复；版本化快照归属使用精确活动分配。两种管理付后标签统一100上限，超出拒绝且不截断。真实受限角色、生产规模与统计对账、Linux/Hyperdrive、UniApp原生类型/构建及发布后流程仍开放。Worker **2018** 条，新Admin **95** 条业务页、**519** 调用点／**543** 变体均可执行；旧PHP精确匹配/有效覆盖仍为903/46.7%，Checklist仍 **246／158／404**。见[满减满折合同](admin-full-discount-route-contract.md)、[验收记录](../audit/admin-full-discount-acceptance-20260930.json)、[日期版营销台账](../audit/admin-legacy-marketing-route-parity-full-discount-followup-20260930.json)、[路由分布](../audit/route-distribution-full-discount-followup-20260930.json)、[Admin清单](../audit/admin-frontend-inventory-full-discount-followup-20260930.json)和[Admin API合同](../audit/admin-frontend-api-contracts-full-discount-followup-20260930.json)。下方各节保留前批口径。

## 2026-09-30 限时折扣两屏续批

旧 `/admin/marketing/discount/list` 与 `/admin/marketing/discount/add/:id?` 两屏missing→candidate，营销48屏 **27候选／12部分／9缺失／0退役**，全Admin274屏 **79／111／77／7**。新 `/marketing/time-discounts` 列表与创建/编辑页使用双Admin前缀各10项接口，`time_discount.view/manage` 分别承接旧1394/1398菜单。列表恢复名称/启停筛选、15条分页、参与商品数与实付、优惠、订单、新老客户统计，管理操作附revision确认；表单恢复上海秒级时段、整数0–100%折扣（90%=九折）、每人每商品限购、付后用户标签、叠加选项、全部/指定父商品和具体SKU/品牌/商品标签范围，跨页选品保留具体规格身份。type3排除SKU是受控扩展；旧复制按钮虽跳转，旧创建页未消费copy参数，不计为复制能力。

本地真实服务合同已验证普通购物车、确认与建单、折扣叠加、跨SKU每人限购、付后标签、精确促销账本、拆单和连续退款；Kefu订单、供应商导出及配货单读取精确行额。隔离PG16八文件 **52/52** 通过、夹具清零且集群停机；桌面与390px合成浏览器API日期流程通过。candidate仍是本地候选：真实受限角色、生产规模与统计对账、Linux CI、UniApp原生类型/构建及发布后流程未完成，UniApp缺少 `@dcloudio/types`。Worker **1998** 条，新Admin **93** 条业务页、**509** 调用点／**533** 请求变体全可执行；旧PHP精确匹配/有效覆盖仍为903/46.7%，Checklist仍 **246／158／404**。见[限时折扣合同](admin-time-discount-route-contract.md)、[验收记录](../audit/admin-time-discount-acceptance-20260930.json)、[日期版营销台账](../audit/admin-legacy-marketing-route-parity-time-discount-followup-20260930.json)、[路由分布](../audit/route-distribution-time-discount-followup-20260930.json)、[Admin清单](../audit/admin-frontend-inventory-time-discount-followup-20260930.json)和[Admin API合同](../audit/admin-frontend-api-contracts-time-discount-followup-20260930.json)。下方各节保留当批口径。

## 2026-09-30 活动背景两屏续批

旧 `/admin/marketing/activity_background` 与 `/create/:id?` 两屏missing→candidate，营销48屏 **25候选／12部分／11缺失／0退役**，全Admin274屏 **77／111／79／7**。新列表/编辑固定type6，双前缀各9项接口，独立背景权限精确映射旧1542/1546菜单。范围只保存审核通过父商品，普通列表/推荐/详情消费 `activity_background`；旧UI没有的排除范围作为明确扩展。共用服务恢复背景及边框的一层同类型派生记录删除，门店派生行同样软删，异类型及历史关系保留。

合并10文件72通过/2原生专用并发项跳过；原生PG16背景12/12、真实双前缀HTTP2/2、边框7/7，前端7/7，类型/构建/严格API审计通过。背景四种范围错位辅助行正反回归核对参与数与公开消费，type1–4价格促销保持原合同；桌面与390×844合成API浏览器核对编辑、跨页选择/取消、版本化保存、启停、只读角色、权限撤销和未知结果禁重提。真实角色/素材/规模/商品渲染与发布验收继续开放。证据见[背景合同](admin-activity-background-route-contract.md)、[日期版台账](../audit/admin-legacy-marketing-route-parity-activity-background-followup-20260930.json)、[本批验收](../audit/admin-activity-background-acceptance-20260930.json)。Worker1978、Admin91业务页及499调用点/523变体全可执行；Checklist246/158/404。下方保留历史口径。

## 2026-09-30 活动边框两屏续批

旧 `/admin/marketing/activity_frame` 与 `/admin/marketing/activity_frame/create/:id?` 从 **missing → candidate**；营销48屏最新 **23 candidate／12 partial／13 missing／0 retired**，全 Admin274屏 **75／111／81／7**。新独立列表与编辑页在 `/marketing/activity-frame`，双 Admin 前缀各9项资源/选项接口由 `activity_frame.view/manage` 控制。旧数字页面菜单 1541 仅获查看、1543 获管理；同名不匹配的规则不授予权限。新状态/删除有确认与材料版本，编辑支持名称、边框图、时间、开关和四种旧 UI 范围；新 type3 排除范围是额外能力，并修复旧 PHP 未标 `is_all=1` 与商品数固定0的问题。

商品普通列表和推荐通过同一促销数据输出 `activity_frame`，显式 `promotions_type=5` 的商品活动读取进入旧接口的 `promotions` 数组，默认促销类型受商品详情 DIY 开关控制。新的两屏和消费者均为本地候选，旧 PHP 动态 URL 无精确别名；真实数据、受限角色、媒体、发布后商品卡片和完整 Linux CI 仍待验。证据见[日期版营销台账](../audit/admin-legacy-marketing-route-parity-activity-frame-followup-20260930.json)、[本批合同](admin-activity-frame-route-contract.md)与[最新路由分布](checklist-route-contract-distribution-20260928.md)。Checklist 维持 **246勾选／158开放／404总项**。下方保留历史批次口径。

专项 **42通过／1原生专用项跳过**、逐屏台账 **15/15**、Admin 前端 **3/3**；隔离原生 PostgreSQL16 活动边框 **6/6**、超过200个活动的目录 **3/3**、受影响价格／结算 **53/53**。双类型、Admin 构建和严格 API 审计通过，见[本批验收](../audit/admin-activity-frame-acceptance-20260930.json)。

## 2026-09-28 积分日志导出续批

旧 `/admin/marketing/user_point/index` 从 **partial → candidate**；营销48屏最新为 **21 candidate／12 partial／15 missing／0 retired**。新 `/marketing/user-point` 已有旧日志列表、统计和15条分页，本批补双 Admin 前缀的有界导出。独立 `integral_log.export` 承接旧 `export-userPoint` 按钮授权，页面同时要求查看权限；按旧七列及当前筛选逐页取得完整数据，并用全结果快照、行数和文件字节数阻止漂移或截断。每页最多1000条，总量最多100000行／16MiB；输出是 Excel 可打开的 CSV，与旧 XLSX 格式不同。隔离 PostgreSQL16 服务/HTTP **7/7**、前端 **10/10** 通过；生产历史规模与实际角色仍待验。

[营销日期版台账](../audit/admin-legacy-marketing-route-parity-user-point-followup-20260928.json)叠加抽奖续批，结合[本批合同](admin-speechcraft-user-point-route-contract.md)与[最新分布](checklist-route-contract-distribution-20260928.md)核对。全 Admin 最新为 **72候选／112部分／83缺失／7退役**，Checklist 仍 **246勾选／158开放／404总项**。下方保留前批当时口径。

## 2026-09-28 抽奖目录与中奖记录续批

旧 `/admin/marketing/lottery/index` 与 `/recording_list` 分别由 `/marketing/lottery`、独立 `/marketing/lottery-records` 本地承接，均从 **partial → candidate**；创建页仍 partial。营销48屏最新为 **20 candidate／13 partial／15 missing／0 retired**。目录补齐每页15条、活动阶段/状态/类型/名称或 ID、三项参与统计及受控管理；记录页补齐组合筛选、15条稳定分页、备注和商品发货。`lottery.view/manage` 不授予中奖身份，记录查看/管理为 `lottery_record.view/manage`，管理详情只为物流预填返回公司与单号，列表不含收货资料、用户电话或物流号。双前缀 HTTP 与隔离原生 PostgreSQL16 已验权限和敏感字段，生产角色及历史活动仍待验。

旧 DAO 将不限期活动重复放入进行中与已结束，新阶段修为互斥；旧中奖人数统计的 PHP 数组并集吞掉 `type>1` 条件，新统计按中奖 UID 去重。记录参与条件筛选保留全部历史活动，修正旧服务只找一条启用活动造成的漏项。旧目录“复制”按钮跳转后，创建页的 `query.id/copy` 读取代码已注释，因而本批不把无效旧复制动作计作已迁移。日期版[营销逐屏台账](../audit/admin-legacy-marketing-route-parity-lottery-followup-20260928.json)、[本批合同](admin-lottery-feedback-route-contract.md)和[路由分布](../audit/route-distribution-lottery-feedback-followup-20260928.json)覆盖此结论；下方原台账及历次数字为当时口径。全 Admin 最新为 **70／114／83／7**，旧 PHP URL 精确覆盖不变，Checklist 仍有158开放项。

## 2026-09-28 付费会员批分布补充

新付费会员两键属于旧用户设置子域，营销48屏仍 **18 candidate／15 partial／15 missing／0 retired**。Worker注册增至1823、Admin调用点/变体418/442，旧营销PHP精确路径匹配仍未增加。用户域旧充值配置与新充值档位页按同一业务组核对后由 missing 修为 partial，最新全Admin274屏为 **57／115／95／7**；营销域数字不受此修正影响。优惠券动态系统配置旧路由仍 missing；其实际共享表单/安装元数据边界见下方九键批的核查说明。见[两键合同](admin-paid-membership-config-contract.md)与[新路由分布](../audit/route-distribution-paid-membership-20260928.json)。

## 2026-09-28 分布补充

普通等级卡激活九键属于旧用户设置 `/admin/user/setup_user` 的子域，新 `/config/level-activation` 可选择 `receive_type=3` 的发行券，但不等于旧营销 `/admin/marketing/coupon/system_config/:type?/:tab_id?` 的动态系统配置页。后者仍 **missing**，营销48屏维持 **18 candidate／15 partial／15 missing／0 retired**。新专用路由使Worker注册数增至1819、Admin调用点/变体增至416/440，旧营销PHP精确路径匹配没有随之增加。详见[九键合同](admin-level-activation-contract.md)与[日期版路由分布](../audit/route-distribution-20260928.json)。下方2026-09-27数字为当批历史口径。

对该旧动态路由继续核到源码和当前安装SQL：它复用 `setting/setSystem/index.vue`，按 `type/tab_id` 读动态分类，实际落到 `marketing/integral_config/edit_basics`，写入动作由服务端返回；当前安装数据的322项配置、52个tab和985个菜单中没有优惠券专属tab/menu。`checkParam('point')` 虽定义白名单，但没有被调用，不能据此断言此别名仅写积分字段。这里仍缺一个可验的独立优惠券配置字段合同，不能按路由名称新造开关，也不能把新人或激活选券页当作旧动态页整体完成。

## 消费者修复补充：赠券固定使用期（2026-09-27，本机验收通过／未发布）

新人注册及付款商品赠券补齐 `day>0 OR (day=0 AND useEnd>=操作整秒)`：固定截止包含该秒，过期／缺失截止／负day跳过，未来开始允许预发。锁后最新行判断、原有限／无限库存解释和调用方时钟保留；实际付款先提交，后置赠券失败回滚其事务并可重放。本批没有新路由、页面候选、schema或权限变更，优惠券配置整屏仍missing。

原生接受 **110项＝四个完整回归文件91＋最终完整新文件19**，不是单次110/110。首轮8失败／11通过及unhandled、修正版109通过／1夹具失败均保留，失败新文件整份排除。最终19项覆盖两入口截止相等、写者先行、真实并发、晚SQL回滚及幂等重试；兼容22、台账17文件95与双类型分别通过。三座本机PG夹具清零、独立确认停止并删除data，保留日志；35份输入按字节归档。详见[赠券合同](coupon-gift-use-window-contract.md)与[新原生证据](../audit/coupon-gift-use-window-native-20260927.json)，前批已接受胶囊不覆写。

当前计数仍为Worker1813、Admin413／437、全Admin57候选／114部分／96缺失／7退役、营销18／15／15／0、复选框246／158／404。配置选券过滤、普通会员激活9键与负day边界、真实会员权益、自动赠券渠道及真实配置／provider／设备／Linux／发布继续开放。

## 当前增量：发行列表与完整新建／复制（2026-09-27，本地候选／本机验收通过／未发布）

旧 `store_coupon_issue/index`、`store_coupon_issue/create/:id?` 两屏由专用 `/coupon` 列表和完整草稿表单承接，分别partial→candidate。营销48屏为 **18候选／15部分／15缺失／0退役**，全Admin274屏为 **57／114／96／7**。最终审计Worker **1813**、Admin **413调用点／437请求变体全部可执行**，未解析／未注册／受控不可用0；11份逐屏台账274条无重叠记录，复选框 **246／158／404**。新增9项操作双前缀共18条注册，旧PHP精确匹配分子保持892，可执行871；新增REST及页面候选不关闭1016条旧路径静态缺口或158项真实验收。

列表恢复类型、领取方式、标题／精确ID与状态过滤，15条分页并可访问100条以后的记录；默认全部以显式空status请求，API缺省仍有效。新建／复制完整保留普通／会员、满减／折扣、通用／品类／商品／品牌、限量与上海固定时间。复制始终新id、cid0、库存复位且不继承proof／领取／自动赠券配置，历史85.99按现有结算85%付款明确展示；缺失商品、无效祖先或不支持受众拒绝，不能伪装为空的新表单。完整跨页商品集合在确认后一次采用，取消不采纳草稿。

五项GET按 `coupon.view` 查看，第六项精确 `/:id/claims` 单独要求 `coupon_record.view`；管理不授权领取人身份。普通按原始issue_user证据保留重复与空／负／孤儿UID，会员按owned来源，不做膨胀连接。三写项要求 `coupon.manage`、实际actor／UUID／revision／范围与发行锁及事务审计。历史-1实例可独立启用而不恢复源模板；软删除保留已领／订单／scope／proof／赠券配置。未知结果只保留当前页面UUID/body后GET核对，人工解除不是服务端证明，刷新无持久恢复。旧generic财务原位写入口仍为既有兼容合同，不扩称全入口已获得新保护。

公共普通手领兼容category0／旧1，只允许receive_type1/app_type0，固定使用期结束后拒绝，receive_limit0按PHP公开一次解释；会员权益与自动渠道未由此验收。本轮不新增DDL或运行授权。详见[发行合同](admin-coupon-issue-contract.md)，其中列明owned金额／时间快照与仍读取发行折扣／范围的边界。

业务原生 **4文件38项唯一通过＝初轮两完整绿文件22＋最终两完整文件16**，首轮formal和HTTP整文件排除，33通过／5失败历史保留；消费者 **7完整文件225项**原生通过。输入／权限／钱包 **50项**、Vue／Axios **47项**、全部台账 **17文件95项**分开记录，零跳过，两种Worker类型、Admin类型和最终构建通过。早期PGlite失败／跳过批不计接受数。实际最终dist166文件重建同字节，CUA六种合成权限、六项GET故障、复制身份／库存、固定UTC时间、未知创建单次请求、软删除关系及390×844 CSS布局均核对；28条观察不当作28项自动测试，模拟视口不代表真机，合成导航不证明真实菜单授权。三座隔离PG已清零／停止／删除，服务和标签／模拟已清理。证据见[原生](../audit/coupon-issue-native-20260927.json)、[浏览器](../audit/coupon-issue-browser-20260927.json)、[最终验收](../audit/coupon-issue-acceptance-20260927.json)。优惠券配置、真实会员权益、自动赠券／关注／新人及完整Linux／真实角色／配置／设备／provider／发布仍开放。旧证据按原字节保留。

## 历史增量：优惠券模板与独立发布（2026-09-27，本地候选／本机验收通过／未发布）

下段保留模板批的当时计数和冻结证据，其中发行partial与55候选由上方本轮覆盖。

旧 `/admin/marketing/store_coupon/index` 的模板工作流由新 `/marketing/coupon-templates` 承接，源码映射由 missing 提升 candidate。只调整这一屏；旧发行列表、发行编辑仍为 partial，优惠券配置仍为 missing。更新后营销48屏为 **16候选／17部分／15缺失／0退役**，全Admin274屏为 **55／116／96／7**。当前源码只读审计为 Worker **1795** 条注册、Admin **404调用点／428请求变体全部可执行**，未解析、未注册及受控不可用均为0。语义及当前审计JSON已统一核对；复选框仍 **246／158／404**，旧PHP精确匹配及功能缺口分母不变。

新页恢复名称/精确ID和状态筛选、15条分页、`sort DESC,id DESC`、范围/面额/使用门槛/领后天数/排序/状态，以及创建、立即失效、软删除和发布。旧页没有实际编辑或重新启用操作，不新增这两项后冒称旧合同；旧 `image` 是选品对象，不是图库封面。通用、单品类和指定商品三种范围分别校验，分类须含可见平台祖先，商品跨页选择保留且最多100项/500字符。新面额须大于0、有效天数1–3650，明确比旧允许0更严格；新列表默认有效，旧默认全部。

| 本轮接口与权限 | 本地源码合同 |
| --- | --- |
| `GET /marketing/coupon-templates`、`/options`、`/products`、`/:id`、`/:id/issues` | `coupon_template.view`；五项读取均有界、同响应count/list使用RR READ ONLY及5/2/5秒局部期限，private no-store。 |
| `POST /marketing/coupon-templates`、`POST /:id/invalidate`、`DELETE /:id` | `coupon_template.manage`；源revision、管理员+UUID/内容摘要与事务审计，保留范围锁和源行锁。表内后两条均接在 `/marketing/coupon-templates` 后。 |
| `POST /marketing/coupon-template-issues` | 同时要求 `coupon_template_issue.manage` 与 `coupon_template.view`；只有发布权限可以看到导航，但无模板查看权限时稳定页面显示拒绝状态且服务器拒绝发布；换号过渡GET仍受服务器校验和响应代际丢弃。 |

9项操作同时注册于 `/adminapi` 和 `/api/admin`，新增18条Worker注册。新增 `store_coupon_template` 与不可变归属证明 `store_coupon_template_issue` 两表；`issue.cid` 仅兼容，绝不按旧孤儿cid认领发行。商品范围关系始终写新发行 `issue.id`。每次发布复制金额、期限、范围及领取参数，普通/新人/赠送映射为receive_type 1/2/3；普通手动领取还须category=0、app_type=0。新人仍需独立注册开关与 `register_give_coupon` 配置，赠送仍需明确渠道；用途flag和full_reduction不意味着自动满赠或首次关注投递已闭合。proof保留源revision，不阻止既有发行页独立编辑发行实例，也不代替其未完成功能。

立即失效只将proof关联发行置status=-1；软删除只改变模板is_del。两者保留发行范围、已领/已占券及订单。未知写在当前页面内存保留原UUID/body并阻止后续写入，只GET重读后经人工确认解除；相似记录不能证明原请求成功，人工误判后新UUID可能重复发行，不宣称服务端结果回执或跨刷新恢复。会话变化、跨标签换号及迟到响应会清除旧身份结果。

两表通过外部0169/内嵌0175注册，正式链为171外部文件/176内嵌步骤/281表。DB保证范围形状、正int32和容量，规范CSV排序/去重由应用校验；DDL与运行权限升级均为显式维护入口，不自动执行线上修复或广泛GRANT。Admin模板仅SELECT/INSERT及status/is_del列UPDATE，proof仅SELECT/INSERT，APP对新表无权；`pre-coupon-templates` 保持历史权限阶段。详细合同及验证边界见[优惠券模板合同](admin-coupon-template-contract.md)。

本机业务55项唯一通过、既有消费者381项唯一通过，分别来自完整文件替换后的两批，不能称为单批全绿。结构批59包含27项PGlite/静态和32项原生；九路径281表/228序列与零结构差异、页面41、权限28、台账93、unit/runtime类型及最终Admin构建均通过。实际最终dist的合成浏览器已核对三范围、三用途、跨页与取消、五权限、五读取故障和未知结果只读核对；合成导航菜单不作为真实菜单授权证据。原生与浏览器证据见[最终验收](../audit/coupon-template-acceptance-20260927.json)。九路径旧序列门禁及磁盘不足的失败日志保留，第三次完整通过；测试集群、浏览器服务、临时标签与视口模拟已清理。旧拼团、秒杀、充值已接受证据及哈希不覆写；完整Linux CI、真实配置/角色、真实设备/渠道及发布继续开放。

## 历史增量：拼团剩余三个只读屏（2026-09-27，本地候选／未发布）

旧拼团目录、全局团记录和独立统计已分别恢复本地操作合同，由 partial 提升 candidate；完整创建/编辑/复制仍沿用前批 candidate，四屏分别计账。当前营销48屏为 **15候选／17部分／16缺失／0退役**，全Admin274屏为 **54／116／97／7**。Worker **1777** 条注册，Admin **395调用点／419请求变体全部可执行**，未解析、未注册及受控不可用均为0；独立新REST不提高旧PHP精确路径匹配分子。复选框仍为 **246勾选／158开放／404总项**。

| 旧拼团路由 | 当前页面及本轮GET合同 | 权限与判断边界 |
| --- | --- | --- |
| `store_combination/index` | `/activity/combinations`；新增 `GET /activity/combinations/export` | 目录沿用 `combination.view/manage`，导出独立 `combination_export.view`；仅导出身份可导出，不借此读取目录。 |
| `store_combination/combina_list` | `/activity/combination-groups`；新增GET目录、`/head`、`/:groupId/members` | 独立 `combination_group.view`；恢复全局两卡、15条分页和成员历史，不能由旧generic活动弹窗抵账。 |
| `store_combination/statistics/:id?` | `/activity/combination-statistics/:id?`；新增GET `/:id/head`、`/:id/groups`、`/:id/groups/:groupId/members`、`/:id/orders` | 独立 `combination_statistics.view`；缺ID提供选择入口，恢复指定活动六卡、团/订单双列表及成员查看。 |
| `store_combination/create/:id?/:copy?` | `/activity/combinations` 的既有完整表单及9项REST | 维持前批candidate；本轮只读能力不扩充前批写入、通知或生命周期验收范围。 |

表内旧路径均以 `/admin/marketing/` 为前缀；8个新增GET同时注册于 `/adminapi` 和 `/api/admin`，因此增加16条Worker注册。目录价格分别来自活动主行 `price` 与当前基础商品 `store_product.ot_price`，基础商品缺失仍保留活动、划线价为空，不混用SKU购时划线价。`people` 保持成团配置人数；新增三个计数分别为原始团长记录、全部pink记录（含退款/虚拟）及成功团长记录，均不冒充真实付款人数。

导出保持旧11列的业务含义，人数列明确显示“开团数／参与记录数”，格式改为浏览器本地CSV。每页最多1000条、全集最多100000行／16MiB、单响应最多4MiB；每页在有界只读REPEATABLE READ事务内核算精确总数、完整导出单元格与排序/版本的snapshot及总CSV字节，后续页必须匹配。金额为精确十进制字符串，时间固定Asia/Shanghai，UTF-8 BOM、完整引用与公式保护一致；全部页收齐且行数/字节数吻合才生成文件，空结果也保留固定表头，取消、失败、容量超限或快照变化均不产生部分下载。

全局团两卡为全部pink记录数及成功团长数，不随列表筛选变化。列表仅原始团长，按上海日历半开日期、状态与关键字筛选；过期raw status=1仅显示pending待结算，GET不执行到期消费者。成员保留退款旧团长、虚拟uid0、缺失用户/活动、软删和历史cid0的问题标记；活动限定入口仍须正ID且不能跨活动。已填订单双身份键必须同时匹配type/activity/uid/pink关系，缺失、删除、重复或矛盾订单不造详情链接；有效链接使用业务order_id并另验order.view。晋升后的旧团不合并新团，无法证明的replacement保持空。

独立统计六卡保持PHP口径：pink不同UID（含0）、子成员不同UID、原始团长数、成功团长数，以及 `type=3 AND paid=1 AND pid IN(0,-1)` 的已付主单毛额和不同付款UID。毛额包含后续退款及已删除主单，排除未付和拆单子单；“参团不同UID”不称推广归因。团与订单分别分页，关联搜索用EXISTS避免放大；已付订单集合的status=0筛选恒为空。汇总、列表和成员独立失败/重试，单响应使用只读RR快照及5/2/5秒局部期限，不声称不同请求共享数据库快照；会话变化、跨tab换号及迟到响应均失效。

本轮原生去重 **140项**（本轮范围105＋回归35），来自初轮4个完整绿文件128项及最终两个文件12项；初轮整体135通过／5失败保留，旧formal6整文件排除、旧HTTP6由最终同文件结果替代，不写成单次140/140或135＋12。前端 **72项＝新33＋原表单39**、权限定向 **26项**、完整路由/前端API/语义台账 **17文件92项**，Worker双类型、Admin类型及最终构建均通过。使用既有受限Admin只读权限，未新增schema、迁移或授权，不由这些读取测试宣称交易消费者闭合。前批155／485／640与39项表单证据及其JSON/hash保持原样，不能把两个批次的数字直接累加。

最终实际Admin dist的CUA已覆盖三屏、分页、各区错误重试、六个合成角色和跨tab换号。换号过渡中曾按旧权限发出使用新token的GET，服务端以400011拒绝且未返回数据；界面拒绝迟到payload，稳定后显示无权限警告，不宣称换号过程零越权请求。1005行导出实际生成 **94543字节** 的CSV Blob，按CSV引号规则解析确认1005个唯一ID、11列、BOM、公式保护、内嵌换行和排序；快照变化及取消均无Blob。下载事件未提供OS文件路径，因此只证明真实生成的Blob，不冒称磁盘落盘核验。390宽DOM无页面横向溢出，局部表格可横滑；截图合成器的灰边/缩放不代表真机。夹具对各角色均给导航path，不能据此证明服务器菜单权限，真实菜单映射由原生权限测试核验；订单详情导航由前端运行时测试覆盖，浏览器夹具未验订单详情正文。两tab控制台均为 `[]`，已关闭并重置viewport；临时服务已Ctrl+C，5202端口已独立确认监听数0。证据：[本轮原生](../audit/combination-read-native-20260927.json)、[本轮浏览器](../audit/combination-read-browser-20260927.json)、[本轮验收汇总](../audit/combination-read-acceptance-20260927.json)。完整Linux CI、真实配置/角色、完整公共媒体/R2、provider、真实设备及发布继续开放。

## 历史增量：拼团完整表单与到期闭环（2026-09-27）

以下保留前批验收当时的状态、数值和证据引用；其中三屏partial及路由分布已由上方当前增量更新，不代表当前缺口。

拼团完整表单本地候选（2026-09-27，历史批次）：四屏分别计账，create提升candidate，index/combina_list/statistics仍partial。专用 `/activity/combinations` 的9项REST双前缀注册，独立combination.view/manage；完整单来源表单、锁源复制、SKU身份/消耗、图片富文本、配送退款与买方快照已由原生/HTTP、实际Vue和CUA分别验收。generic拼团写不再是有效目标API。到期虚拟补齐及成团成功通知有独立原生消费者证据，不由页面virtual字段推断闭合，开团/参团通知未宣称完成。

本批原生8文件155个去重用例（冻结7完整绿文件135＋独立修订迁移20，不伪称单次155/155），另9文件485回归，合计640；FE39、兼容113、台账19、双类型/最终Admin构建通过。九路径170外部/175内嵌完整目录五类diff为0。CUA共享190合成请求含轮询、6次内存拼团写、真实业务写0；390DOM无横向溢出，手机截图灰边/缩放不代表真机。临时服务停止，最终PG夹具清零；早期gM8fUa的20合成库留在已停机诊断目录。历史父秒杀证据按字节独立保存，不累加通过数。当前Worker1761，Admin388调用点/411变体全部可执行，营销12/20/16/0、全Admin51/119/97/7；复选框246/158/404未变。详见[原生证据](../audit/combination-native-20260927.json)、[浏览器证据](../audit/combination-browser-20260927.json)、[拼团合同及剩余三屏](admin-combination-contract.md)。

## 审计范围与当前分类

本台账以 `audit/admin-frontend-inventory.json` 为权威导航分母，只审计 `/admin/marketing*` 下 `surface=page` 的 48 条旧业务路由。旧模块另有 4 条导向 `commonForm` 的辅助路由：`store_bargain/setting`、`integral/system_config/:type?/:tab_id?`、`setup_recharge`、`sign_config`。它们在 274 条业务路由之外，不能加进本批分母。

`audit/admin-legacy-marketing-route-parity.json` 由 `scripts/admin-marketing-frontend-parity-audit.ts` 从权威清单和 48 条显式语义结论生成。每条记录保留旧路由、组件、路由权限、新 Admin 页面、Worker API、目标权限、已覆盖行为、剩余缺口及源码证据。生成器要求路径唯一、48 条全部分类、目标页面与 API 已注册、本仓库目标证据文件存在；`test/admin-marketing-frontend-parity.test.ts` 固定路径顺序、状态计数、关键误判边界及 JSON 字节一致性。

旧路由与组件位置来自权威清单中 `marketing.js` 的 SHA-256 `9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed`。旧 `meta.auth` 是逐路由固定的审计结论。旧 PHP 路径仅作来源定位；生成及 CI 不读取或要求相邻的 `cinashop-php` 仓库，只检查本仓库目标证据文件。旧路由快照哈希变化时生成器会要求重新审计。

| 状态 | 屏数 | 判断边界 |
| --- | ---: | --- |
| candidate | 15 | 优惠套餐列表和创建/编辑、用户优惠券领取记录、秒杀父活动列表与完整创建/编辑、拼团目录含导出/全局团记录/完整创建/独立统计四屏、秒杀统计、积分统计、签到奖励、积分分类、充值金额及秒杀时段已有本地 Admin 与 Worker 操作面；仍待真实配置/角色和发布后流程验收。 |
| partial | 17 | 新页面可承接有意义的部分操作，但旧筛选、字段、导出、发行或渠道闭环尚不完整。 |
| missing | 16 | 无可执行的新 Admin 整屏替代；仅有 Worker API 或前台业务能力不足以提高状态。 |
| retired | 0 | 未发现足以证明旧路由是无效占位页的证据。 |

容易混淆的映射：

- 新 `/coupon` 的 Worker 读写 `store_coupon_issue`，只能部分承接旧发行目录和表单；旧 `store_coupon` 模板屏仍缺。新发行列表未过滤 `is_del`，删除后的软删记录仍可见。
- 新 `/marketing/coupon-records` 用独立 `coupon_record.view` 权限读取 `store_coupon_user` 领取实例，与发行实例列表分开。旧页只读，按状态、领取人和券名筛选，按 ID 倒序每页 15 条并展示 10 列；新页及 GET 合同对齐这些本地行为，列为 candidate。旧 `store_coupon_issue.coupon_type` 在数据迁移时映射至新表 `type`，用于区分金额券和折扣券。真实历史领取记录、受限角色和发布后流程仍待验收。
- 领取记录旧筛选标题写“是否有效”，实际请求 `status`（0/1/2）；新页改为“状态”，并明确支持目标表已有的 3=未支付订单占用中。旧 `is_fail` 用勾/叉图标，新页用有效/失效文字。旧未知领取来源显示空值，新页显示“其他获取方式”；旧零时间显示空白，迁移后的空时间显示“—”；旧跨页空列表返回零总数，新接口保留真实总数。这些显示与分页差异不改变只读领取记录范围。
- 新 `/activity` 汇集秒杀、拼团、砍价、积分商品与优惠套餐。按商品查看的团/砍价参与弹窗不能替代旧跨商品记录与统计。旧 `/store_seckill/list` 是 `store_activity(type=1)` 父活动目录，现由独立 `/activity/seckill-activities` 承接日期范围、多时段、参与商品数、编辑和复制；后续五项旧UI差异补齐后，父列表与完整创建页均列为本地 candidate，范围见下方同日最新段。旧 `/store_seckill_data/index` 的 `config.vue` 实际调用 `/marketing/seckill/time` 管理 `store_seckill_time`，并非 `setting/seckill_data` 通用组合数据页；独立 `/activity/seckill-times` 承接标题、起止时间、图片、描述和启停、状态筛选、20条分页及增删改，列为本地 candidate。父活动、子商品与时段是三个独立实体，不能合并计账，也不能用子商品或时段目录抵作父活动恢复。
- `/activity/seckill-statistics` 用独立 `seckill_statistics.view` 查看指定秒杀商品四卡、参与人和已支付主单；活动目录中的统计入口也只对该权限可见。旧 `pay_rate` 实为剩余额度/展示总额度，页面直接标明；旧订单列表与总数过滤不一致，目标两者统一为同一已支付主单集合。订单搜索限于订单快照的订单号、姓名、电话和 UID，暂未复刻旧通用 DAO 的用户、地址、商品和活动标题关联搜索；参与人搜索保持订单姓名、电话、UID。真实历史订单、受限角色和发布验收仍开放。
- `/activity` 四类目录已补本地分页候选（2026-09-26历史批次）：默认每页20条，显示真实总数，按 `sort DESC,id DESC` 排序，可按活动名称和启停状态筛选；砍价同时搜索 `title/storeName`。列表与总数在同一只读 REPEATABLE READ 事务查询，排除软删行；单页上限100、offset上限10,000，非法/重复/未知参数拒绝，关键词中的通配符按字面处理，四接口统一禁止缓存。显式分页请求返回 `{list,count,page,limit}`，无分页参数的旧调用保持数组形状且最多100条。前端切页、查询、切tab会清空旧结果，取消旧请求并拒绝迟到响应；错误有独立重试，删除空尾页回退，只读角色不显示写按钮。旧默认每页15条、新目录20条是明确差异；仅名称/启停筛选不等同旧活动时间状态、ID搜索、复制、导出及完整字段合同，该批四屏当时均为partial。拼团现由上方独立目录和完整表单承接并升为candidate，其余通用活动目录不随之提升。
- 旧软删行过滤、非砍价编辑保留销量/创建时间与已绑定秒杀时段、三类活动软删除已在本地候选修复；这里的 `/activity` 子商品简化新建表单仍未选择时段，旧通用Worker保存默认 `timeId="1"`，不指下方已有多场次的新父活动表单。通用子商品完整表单与并发销量变化时的库存/额度边界、真实历史数据和角色仍须验收。
- 新 `/marketing/lottery` 具备活动和中奖记录操作面，但未恢复旧时间状态筛选、中奖记录完整筛选/翻页，并拒绝新建旧微信红包和未明确等级奖品，因此三屏均为 partial。
- 旧营销渠道码映射到跨域 `/content/wechat-qrcode`。目录、编辑和统计均有本地入口；公众号扫码回调尚未启用，三屏仍为 partial。
- 新 `/marketing/user-point` 的独立只读权限、分页积分流水与四项统计可部分承接旧积分日志。旧页只有用户 ID/标题和时间筛选，统计卡在初始化时单独加载；新页增加可选精确类型并按同条件查询统计。旧 Excel 导出尚未恢复，历史流水和受限角色仍待验收，因此保持 partial。`/marketing/sign-rewards` 用连续/累积两个页签、15 条分页和添加/编辑/确认删除承接旧签到奖励页，沿用 `config.view/manage`，列为本地 candidate；生产非空规则、受限角色与发布后签到结果仍待验。积分分类和充值金额已由下方独立候选承接；促销规则及活动边框/背景仍无整屏替代。
- 新 `/marketing/point-statistic` 用独立 `point_statistic.view` 权限读取积分汇总与趋势，承接旧独立统计页，列为 candidate。历史积分数据、受限角色和发布后流程仍待验收。

秒杀父活动恢复（2026-09-27 最新，含后续五项UI能力）：新 `/activity/seckill-activities` 使用独立 `seckill_activity.view/manage`，`/activity` 的父管理入口只对查看权限可见。父列表默认15条，按名称或精确ID、日期阶段和父开关查询，展示父ID、名称、上海日期范围、每日多场次、参与商品数、阶段、开关与创建时间。日期阶段与开关分别判定。详情、编辑和复制均读取完整父/子/SKU材料；超出100商品、每商品500SKU、全父5000SKU时明确拒绝编辑，不能截断读取后默删。SKU按商品折叠展开，损坏来源、已退役规格和已删除子商品保留可见，不把缺失来源自动当作删除指令。

| 旧路由 / 实体 | 新操作面 | 当前台账状态与边界 |
| --- | --- | --- |
| `/admin/marketing/store_seckill/list` / `store_activity(type=1)` | `/activity/seckill-activities` 的父目录、详情、原位编辑、复制预填及确认启停/删除 | candidate；父工作流已有本地实现，仍须真实配置、完整Linux CI与发布后验收。 |
| `/admin/marketing/store_seckill/create/:id?/:copy?` / 父、多个子商品和活动SKU | 同页双页签完整表单，恢复日期、多场次、限购、氛围图、分类/标签选品、跨页批量添加、跨商品批量配置/移除、规格图及价格/总额度、只读成本价/划线价/库存 | candidate；五项真实旧UI差异已补齐并完成本机合成交互验收，仍须真实配置、完整Linux CI与发布后验收。 |
| `/admin/marketing/store_seckill_data/index` / `store_seckill_time` | `/activity/seckill-times` 的独立时段CRUD | candidate；仍是独立时段实体和独立权限，既有6接口不计入父活动9接口。 |

父活动固定9项REST同时注册在 `/adminapi/activity/seckill-activities` 与 `/api/admin/activity/seckill-activities`，合计18条Worker注册；旧重复PHP动态URL没有因此注册或恢复。

| 方法与相对路径 | 用途 |
| --- | --- |
| `GET /` | 父列表，默认15条，关键词、日期阶段与开关筛选 |
| `GET /options` | 完整时段、可选平台分类树、全部平台商品标签及容量：64场次、100商品、每商品500SKU、全父5000SKU、分类/标签各5000 |
| `GET /products` | 基础商品名称/ID、单分类及单标签筛选与分页；返回业务类型和安全归属分类名称 |
| `GET /products/:productId` | 权威基础商品及完整规格来源，含各SKU自身稳定图片引用与授权预览 |
| `GET /:id` | 完整父详情及材料revision |
| `POST /` | 新建；复制读取来源预填后使用同一接口创建新身份 |
| `PUT /:id` | 原位编辑父、子商品和活动SKU |
| `PUT /:id/status` | 原子级联父及全部关联子商品开关 |
| `DELETE /:id` | 原子软删除父及关联子商品，保留订单、退款和SKU身份 |

表单恢复上海日期、多场次、累计/单次限购、可选平台氛围图、多个商品及SKU参与、活动价和配置总额度。图选择/上传保持独立 `attachment.view/manage`，保存稳定引用、展示签名预览；成本价和划线价取服务端真实值，只读且不进入写体。服务端继承来源商品、所属方、内容与配送规则。新写入的规格字段是 `quota_total`，原位编辑用总额度减已消耗量计算剩余，保留旧子/SKU身份和销量；停用规格采用退役并保留恢复库存证据，不能用新身份绕过退役旧规格。复制清除父/子/SKU写身份及旧revision，以来源当前剩余额度预填新总额度，来源坏项仍可见且可显式移除。创建/编辑不能保存已经整天结束的结束日期，复制过期来源需显式调整日期；详情、关闭与删除仍可处理历史项。

保存字段时父开关与各商品自身开关分别保留，父关闭负责购买门控；独立启停接口沿旧PHP合同改写父及全部关联子商品，开启确认明确提示“之前单独关闭的商品也会被重新开启”。删除先确认再软删除父/子，不重建或抹去旧购买身份。每次写入带UUID `request_id`，编辑/启停/删除还带材料 `revision`；审计、版本检查及变化在同一事务，未知响应只GET重读核对，不自动重写。前端会话更换、关闭编辑器及迟到列表/详情/选品/图库响应均取消或丢弃，查看角色不能调用写入或选品动作。

完整创建页前批尚缺的五项旧UI能力，本次均已闭合，因此从partial调整为candidate：

| 已恢复的真实旧UI能力 | 当前实现及来源证据 |
| --- | --- |
| 商品分类级联与商品标签筛选 | 单路径可搜索Cascader可选择上级或末级，单值标签Select可清空；隐藏/停用平台标签仍可筛。旧 `goodsList/index.vue:11,21`。 |
| 选品器跨页多选、一次添加多个商品 | 稳定商品ID缓存跨分页和筛选，支持当前页全选/退选、单项取消与清空；确认后逐个权威读取完整规格，全部成功后一次加入。旧 `goodsList/index.vue:299,306,438` 和 `create.vue:245,536`。 |
| 跨商品批量价格/额度设置与批量移除 | 商品级复选跨筛选保留；批量价格/总额度先验证全部目标，再同步修改参与且非退役规格。移除先确认，已保存子商品/SKU保留身份并关闭，新草稿商品移除；已删除历史项保持可见。旧 `create.vue:123,124,418,460,497`。 |
| 选品器商品类型、商品分类列 | 展示真正业务类型0普通/1卡密/2优惠券/3虚拟/4次卡及分类名称；未知类型明确显示编号，不混淆商品所属方type。旧 `goodsList/index.vue:188,193`。 |
| SKU自身图片展示 | 每个来源/活动SKU使用自身图片，由后端核所属方及附件scope后提供`image_preview`；空或不安全预览用占位，不用商品头图填充，也不写入SKU媒体字段。旧 `create.vue:149`。 |

分类/标签选项以`categories:[{id,pid,cate_name}]`、`labels:[{id,label_name,status,is_show}]`返回，`max_categories/max_labels`均为5000；数量哨兵超限、分类循环/缺父/非法ID整体拒绝，不返回截断树。分类选项排除隐藏祖先的整枝，选择可见上级筛选仍包含其隐藏后代。`category_id`和`label_id`均为单值，缺省、空字符串或0代表全部；其他值须为规范正整数，未知/重复参数、未知标签及不可选分类明确拒绝。分类筛选使用商品关系表type1和pid后代，标签使用type3单ID关系；平台标签不按status/is_show过滤。

分类列存在明确显示差异：旧页拼接直接父级/当前分类名称路径，新页合并关系表与历史`cateId`分类ID并去重，按安全归属展示名称集合，无法解析的分类显示`未知分类#id`，不声称重现旧路径格式。此差异不改变选品筛选关系。批量价格/总额度只修改enabled且非retired的参与规格，保留已消耗量、当前剩余、库存及身份；总额度小于任一目标已消耗量时整批拒绝，价格也不部分更新。旧批量全选分支修改非参与规格的行为不照搬，不能由批量操作隐式重开已退役/已删除身份。

跨页缓存仅用于选择和显示，确认添加会逐ID重新读取权威商品/完整SKU；任一明细失败、身份不符、来源无有效规格或超过100商品/5000SKU时整批不加入，保留选择可重试。关闭选品器、编辑器或更换会话会取消共享来源请求并丢弃迟到结果。加入和批量配置均先修改草稿，保存活动前不发送活动写请求。

上述PHP来源位于 `cinashop-php/view/admin/src/components/goodsList/index.vue` 和 `cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue`。旧父controller可收取适用门店字段，但旧创建模板没有门店控件，不能据此新增一个UI缺口。旧模板绑定的 `onchangeIsShow` 没有同名methods实现，也不能把该旧bug当作必须照搬的有效批量开关合同。图库删除图操作在新页可通过清空氛围图字段完成。

前批父活动核心证据已按当时输入归档：真实Vue/Pinia/Axios父前端23/23，含原位额度、复制、身份保留、只读权限、独立附件ACL、未知响应及会话取消；父入口追加后既有活动列表/时段两文件30/30、零跳过，Admin类型与构建成功。前批父原生为6文件99个不同用例（新69及既有LOGIN30），见[前批父原生证据](../audit/seckill-parent-native-20260927.json)，不与下方后续修改后的回归重复累加。受限app排期锁与Admin父DML是分别维护和验收的权限合同，见[秒杀运行权限](seckill-runtime-privileges.md)；旧时段批次235消费者及普通/预售LOGIN30不能直接计作新父管理与实际app秒杀购买的权限证明。源码调查文档是实施前历史快照，见[父活动合同](admin-seckill-parent-contract.md)。

前批父浏览器已完成本机合成验收：CUA内置浏览器访问当时最终构建Admin与隔离loopback内存API，验证只读详情/分页、15条父列表与名称/ID查询、合成平台图库及无附件权限时禁用、分页选品/规格配置、新建/原位编辑/复制、级联取消/确认与重开提示、软删确认、缺失日期和历史场次99显式修复、列表失败重试及未知写响应后只GET重读。桌面1280×850和手机390×844的页面scrollWidth分别为1280/390，无页面横向溢出，SKU表可在局部横滑；console error/warn均为0。共103个API请求，95 GET、2 POST、5 PUT、1 DELETE，8笔写入的UUID均唯一；未知结果场景观察到一次PUT后仅GET，不据此保证底层网络永不重传。截图、请求、控制台及夹具哈希见[前批父浏览器证据](../audit/seckill-parent-browser-20260927.json)。页已关闭、viewport恢复、服务已停且5199无监听。该证据不覆盖后续新增的五项UI交互，也未被覆盖或改写。

该浏览器证据只证明合成API下的实际渲染和交互，不是数据库、真实Admin/JWT、R2上传、生产签名图片或Provider验收；真实受限角色与事务由[父原生证据](../audit/seckill-parent-native-20260927.json)另行证明。本轮未连接生产，完整Linux CI、实际发布角色/配置与生产流程仍开放，不能以运行时测试、构建或合成浏览器关闭这些边界。

五项UI能力后续验证（2026-09-27）：修改后的父业务33、并发8、实际受限app12及媒体6共59项原生通过；另既有PC购买6项通过，本次5文件合计65个不同原生用例。PC首轮用受限运行模式在建角色阶段失败并跳过6项，保留为执行历史；正确的既有schema-maintenance模式下最终6项全部通过，不放宽断言。真实Vue/Pinia/Axios三文件75/75、零跳过，其中父活动45项（原23加新增22）、既有活动列表8项和时段22项。新增前端场景覆盖分类/隐藏标签、跨页缓存/当前页全选退选、逐源权威读取、第二来源失败整批零加入及重试、来源身份/容量完整性、迟到结果和会话取消、跨商品批量原子校验/历史身份/取消确认、SKU预览及写体媒体白名单。五文件台账回归33项及兼容单元2项通过，兼容单元不计入原生分母。Worker顺序unit/runtime类型与Admin vue-tsc/Vite构建通过；最终父页面包为`SeckillActivities-D-2SDxvu.js`。前批99原生、23+30前端和103请求浏览器证据保留为历史输入记录，本批回归不与其重复累计。

后续五能力已由CUA使用最终构建Admin和隔离loopback合成API实测：上级分类10、隐藏标签22筛选、跨页多选一次添加、第二来源失败时零加入并保留选择重试、两商品批量价格/总额度、低于历史已消耗2时整批拒绝且价格不部分改变、批量移除取消/确认后保留历史SKU身份200/201、新草稿商品518本地移除、每个SKU红/蓝独立签名图预览，以及新建后重新读取。真正手机390宽时文档宽390、弹窗366、内部body334，SKU表在局部横滑；桌面1280宽无页面溢出且截图清晰。手机合成器截图存在灰色padding，不能将DOM布局观测等同截图完美。具体请求、截图与夹具输入记录见[后续父浏览器证据](../audit/seckill-parent-extras-browser-20260927.json)。这是合成API下的实际页面证据，不能计作真实JWT、生产附件/R2或发布验证。

本批共享夹具日志为114次请求（112 GET、1 POST、1 PUT），包含Root两次只读HTTP详情读回；CUA自身为112次。父活动API共32次（30 GET、2笔写入），其中包含上述两次读回，CUA自身父API为30次；另79次`new_push`后台轮询及3次`site_config`不计为父业务请求。两笔写入仅落在合成内存夹具，各带不同UUID，真实业务写入为0。验收后5200监听数为0，验收页签4/5/6已清理，浏览器viewport及CDP metrics已恢复。前批核心32个源文件的字节归档32/32核验一致，旧Vite包已被本批最终构建替换，不能将当前dist当作前批构建；前批audit与历史计数保持独立。最终原生、前端和输入哈希见[后续父原生证据](../audit/seckill-parent-extras-native-20260927.json)。

公共秒杀列表主图本批已由`ActivityService.seckillList`复用共享`ProductAssetPolicy`核商品所属方、附件类型/模块、稳定canonical及真实对象前缀后签名；平台图片和活跃供应商自己的/平台共享图片按各自归属处理，越界图片不签。专门媒体原生6项及实际app12项中的新增1项已核HMAC和图片归属，均包含在上方59中，不重复累计。Admin来源/活动SKU同样只展示自己的`image_preview`，父氛围图仍限平台scope。完整公共商品详情/其他图片字段、真实R2对象与生产媒体流程验收仍开放，不能以本批列表主图证明所有公共媒体闭环。

本次生成台账为营销48条：11 candidate、21 partial、16 missing、0 retired；全部11域274条：50 candidate、120 partial、97 missing、7 retired。Admin前端379个调用点、402个调用变体均已注册且可执行；这组API分母与逐屏功能状态分别记录，不意味着缺失/部分页面闭环。真实配置/角色、完整Linux CI、发布和跨域E2E仍开放，FE-001D不因本轮父列表/创建页candidate关闭。

积分分类候选（2026-09-26）：`/marketing/integral-categories` 管理 `category.group=5` 的平面积分区间。它不是普通商品分类树；没有父子、图片或商品分类ID绑定。保留名称、最低/最高积分、显隐、排序五字段，以及名称/ID与状态查询、15条分页、添加、读取详情编辑、显隐确认和删除。列表/总数使用同一只读快照，按sort/id倒序，禁止缓存，limit<=100、offset<=10000，通配符按字面搜索；空状态兼容全部。名称1–30字，积分/排序为0–2147483647整数，最低严格小于最高。

新REST在 `/adminapi/marketing/integral-categories` 与 `/api/admin/marketing/integral-categories` 同步提供目录GET、详情GET/:id、创建POST、编辑PUT/:id、显隐PUT/:id/status、删除DELETE/:id，使用独立 `integral_category.view/manage`。旧7条动态表单接口没有据此宣称恢复。每次写入带UUID `request_id`，非新增还带确认时的 `revision`；组内事务锁串行处理名称/范围/显示数量，审计与变化一并提交。重放先核管理员、操作、目标及载荷指纹，再返回原结果，不重复变更或审计；新请求的陈旧版本拒绝。名称以PostgreSQL lower判重，常见大小写同名拒绝，未声称完整等价旧MySQL utf8mb4_unicode_ci的重音和Unicode折叠。

范围使用完整闭区间交叠判断（包括隐藏分类），修复旧PHP漏掉新区间完全包住旧区间的情况；两个范围共用端点也冲突。公开消费者最多读取1000个显示项，新增显示/隐藏转显示在同一锁内检查上限，仍允许隐藏或删除超限旧数据。删除沿用物理删除，但仅移除范围导航，不删除积分商品，已打开客户端持有的min-max筛选仍可使用。公开 `store_integral/category` 的label/value合同及商品、积分余额不变。

本轮新及相关后端PGlite/消费者/权限28/28，原生PostgreSQL16.15四文件35/35、零跳过，其中7个并发场景；临时夹具清零且实例停止。前端15项真实Vue/Axios运行时、另18项审计回归、Worker双类型及最终Admin类型/构建通过，独立源码/测试复核无剩余问题。CUA内置浏览器在loopback合成API验证只读、分页搜索、范围校验、新增编辑、开关取消/确认、筛选移出、末页删除、失败重读及部分响应断线后的未知结果提示；1280×850及390×844无页面横向溢出、控制台error/warn为空。修正了分类状态初始显示英文Select的问题，现为全部状态。截图及请求记录保留在本次外部本机验收目录，未连接生产，浏览器服务已停止。

验收曾观察到Chromium在PUT空响应断线后自动以相同UUID/body重传；首版合成API没有重放记录而返回版本冲突，这是夹具缺口。真实后端已有同key/旧revision重放且数据和审计不变的PGlite及原生PG测试。夹具随后补齐重放，并用部分响应中断验证页面提示未知结果后只重读；不能把“前端不自动重新写入”描述为底层网络绝不重传。生产实际范围、角色、完整Linux CI和发布后商城过滤仍须验收。

充值金额候选（2026-09-26）：旧 `/admin/marketing/balance_recharge` 由 `/marketing/recharge-options` 承接，恢复充值金额、赠送金额、排序、显隐，以及新增、详情编辑、确认显隐/删除和全部启用档位预览。旧页本身没有查询或分页控件，也没有跳转充值设置的按钮；`setup_recharge` 是旁边独立辅助路由。预览采用新Admin样式并明确仅作配置示意，不显示实际余额、发起支付或承诺旧页写死的充值政策。旧六色手机主题没有按图复刻。

后端按 `system_group.config_name=user_recharge_quota` 唯一解析组ID，不硬编码旧种子的gid62。只提供固定六项REST，分别在 `/adminapi/marketing/recharge-quotas` 和 `/api/admin/marketing/recharge-quotas` 注册：GET目录、GET/:id详情、POST新增、PUT/:id编辑、PUT/:id/status显隐、DELETE/:id删除；权限为 `recharge_quota.view/manage`，读响应禁止缓存。不得借该接口管理其他组合组、组结构或任意JSON。Admin及按套餐ID下单对缺失或重复组明确报错，公共目录对缺组返回空档位以保留自定义金额充值；重复组仍拒绝。同日追加的外部0166/内嵌0172负责全新建库的空组初始化，既有库按下方增量维护入口处理，HTTP请求本身不自动建组。旧嵌套 `{type,value}` 及平面金额可解析，损坏项保留在管理目录并标记无效，可修复、隐藏或删除，不能直接启用。

目录与公开档位恢复 `sort DESC,id DESC`，修正此前Worker同排序ID升序的差异。档位总数含隐藏项最多20；只限制新增，允许已满或遗留超限时编辑、隐藏和删除，修复旧PHP满20也拒绝编辑的问题。管理页一次读取page1/limit100，数量不完整即报错且停止预览；21–100条遗留记录可逐项恢复，超过100条需先核查历史配置。公共读取最多21条哨兵，超过20个显示项明确报错，不静默截断；继续允许隐藏/删除恢复，并阻止再次突破显示上限。充值本金范围0.01–100000.00元，沿用Worker既有单次充值上限；赠送范围0–99999999.99元，保持旧八位整数金额意图，允许赠送大于本金。写合同采用十进制字符串并转整数分处理，拒绝多余小数和隐式舍入，排序为非负整数。

全部写入带UUID `request_id`，非新增还需材料 `revision`；以固定充值组事务锁串行检查和写入，同事务登记管理员日志。同管理员/操作/目标/载荷的相同请求可重放原结果且不重复审计，新请求持陈旧版本则拒绝。套餐下单在同一窄域锁内重新读取启用档位并将本金与赠送额快照写入 `user_recharge`；生成订单号、配置读取和支付provider调用不放入这个锁区。后台更价、下架或删除不改已有订单，结算继续使用订单快照。旧客户端只传套餐ID而无档位revision，因此保证的是服务端选取与管理变更的确定先后，不能保证用户先前页面所见赠送额与下单瞬间仍一致。

充值空组初始化增量（2026-09-26）：正式外部 `0166_recharge_quota_group_seed.sql` 与内嵌 `0172` 使用同一SQL，缺组时只新增 `cate_id=0`、名称“充值金额设置”、说明“设置充值金额额度选择”及售价/赠送输入字段元数据，ID由现有序列分配。这些元数据来自旧安装脚本；不生成金额档位、余额、支付开关或订单。新增时同事务记录一条 `admin_id=0/type=recharge_quota_seed` 的迁移日志，已有唯一组则完整保留其名称、分类、说明及任意历史fields文本，并且不写日志、不取序列号。重复组明确拒绝，不猜测合并。

新建库由正常外部/内嵌注册顺序执行；已有数据库只能用根维护连接调用固定 `runRechargeQuotaGroupSeed(db)`，由入口建立独立 READ COMMITTED 事务。`MigrationService.runAll()` 是完整建库入口，会重放历史DDL，不能用作本项增量升级。未新增HTTP初始化接口、任意SQL参数、应用运行角色授权或前端“修复”按钮。statement/lock/idle上限分别为5/2/5秒，并保留调用方更严格的限制；固定充值组锁与管理写入、购买快照共用。

缺组时校验表所有权、普通持久表、无RLS/继承，以及插入目标的有效主键、唯一配置名、依附序列和默认值；拒绝活动自定义触发器、规则、生成列或额外列默认值带来的未审查副作用。组、数据和日志表先锁定再复核元数据，覆盖并发DDL。由于 `system_group_data.gid` 无外键，持有其SHARE锁并在取得新组ID后检查所有同gid数据，隐藏或损坏的孤儿档位也会导致整笔回滚，不能意外接回商城。拒绝时不改原有业务行，也不自动认领或修正序列；PostgreSQL的nextval可能留下正常序列间隙，这不属于可回滚的业务状态。

九路径结构审计（2026-09-26执行，2026-09-27复核）：隔离PG16.15完成当时冻结的external168文件、embedded173步骤以及ORM新建与六类升级路径。九份目录均为279表、3885列、668约束、1076索引、227序列，五类完整定义精确一致；所有审计数据库/角色清理已确认，实例pg_ctl显示停止。该轮168文件输入哈希与持久结果一致，精简证据见[充值种子结构审计](../audit/recharge-quota-seed-catalog-20260927.json)。后续秒杀锁能力追加0167/0173后为169文件/174步骤，其三条完整建库与升级路径另行验证，不能沿用旧九路径哈希宣称当前输入已完成九路径复验。本项证明结构合同，不能把ORM仅建表路径当作已经初始化业务组，也不代替三路完整种子数据测试或完整Linux/线上验收。

充值种子最终数据/回归验证（2026-09-27）：普通非superuser原生七文件149/149覆盖27项种子SQL、实际Admin→公共目录→充值订单快照流程1项、173步注册79项，以及管理写入17项、并发9项、付款8项和ACL8项。PGlite同组种子/流程/注册104通过、3项仅原生跳过，不另计为新增通过。初轮原生注册字节比较在运行中修改SQL时失败，冻结输入并补RLS竞态用例后最终149项全部通过。无可恢复摘要的旧维护批MUiNMA未计入；重新以既有10分钟门禁分三座维护集群完整跑十三文件，结果分别3文件93项、5文件158项、5文件152项，共403/403、零失败／跳过，未改代码或放宽断言。该批包括新三路全建库/升级数据测试和所有受影响旧迁移suite，以及refund-runtime-permissions的真实受限LOGIN合同；与七文件合计20文件552个不同用例。

三路数据测试实际从旧外部≤0165完整库仅执行forward0166、从168份外部SQL全新建库、从173内嵌步骤全新建库，均证明只产生一个空配置组和一条actor0迁移日志，业务数据不被初始化。旧库逐表序列化快照覆盖所有public表，排除允许新增的组/日志两行后完全一致，同时catalog及relation OID/owner/ACL保持；重复seed不再改变行。三座集群QrAVq6/57206、3zHMDt/63635、hfpryP/53506均remaining=0、STOPPED，维护身份最后复核pg_ctl status=3及监听数0。持久完整日志和输入哈希摘要见[原生种子验证](../audit/recharge-quota-seed-native-20260927.json)；Worker unit/runtime最终类型及最终五文件18项台账回归通过，独立复核无新增阻断。上述是本机候选证据，完整Linux CI、真实配置/角色/渠道及发布验收仍开放。

秒杀时段候选（2026-09-27）：旧 `config.vue` 的真实表是 `store_seckill_time`，商城 `/seckill/index` 消费启用时段的title/pic/describe；顶部图另来自 `seckill_header_banner`。新 `/activity/seckill-times` 保留8列、标题/状态筛选、20条分页与增删改，时段按混合旧HHmm/HH:mm数值升序、id倒序，损坏项末尾可见并可修复；写入严格HH:mm，开始须早于结束，明确支持24:00结束、不支持跨午夜。原 `/activity` 只读widget已换为独立权限入口，continuedTime/持续天数字段已移除。

固定6项REST同时注册 `/adminapi/activity/seckill-times` 与 `/api/admin/activity/seckill-times`，使用独立 `seckill_time.view/manage`。目录与总数同一只读快照，默认20、limit<=100、offset<=10000，重复/未知参数拒绝、通配符按字面搜索、响应禁缓存。材料revision保留原始完整行及xmin，UUID重放绑定管理员/操作/目标/载荷，业务和审计同事务；陈旧新请求拒绝，未知响应只重读不自动重写。旧坏status安全显示为隐藏而valid保持false，原始行不因读取被改写。

所有时段写入共用事务锁；半开区间交叠包含隐藏项，允许相邻端点。其他坏时间阻止新增或启用，但旧坏项可逐项修复为合法隐藏时段，仍检查所有合法区间。显示上限1000只限制新增显示/隐藏转显示，允许隐藏、删除和旧显示项编辑。编辑与显隐沿用旧合同，不额外禁止已占用时段；删除则保护父/子真实ID引用及旧父时间对，包括隐藏、未来和截止日整天，损坏的相关排期失败关闭。

购买仍按父SHARE→子UPDATE→排序后时段SHARE锁定；删除先调用固定无参数 `public.admin_lock_seckill_time_references_v1()` 锁父/子引用表，再锁时段并在READ COMMITTED重读，封住引用插入与购买交错。外部0167/内嵌0173只注册窄能力，显式独立NOLOGIN owner、固定search_path和5/2/5秒事务期限；本批Admin新增时段UPDATE/DELETE及该函数EXECUTE，父活动仍只读，子商品既有权限保持，本批不新增父/子活动DML，App不得调用该函数。正式配置和授权须经既有维护/commissioning入口，未向运行角色开放父活动DML，也未在生产安装。完整边界见[引用锁维护合同](seckill-time-reference-lock.md)。

图库沿用独立attachment权限，可上传或选平台图片；保存稳定canonical_url，预览和公共slot.pic按平台type=1/relationId=0/moduleType=1/fileType=1及对应资产ID校验后签名。私人、客服、供应商、视频或缺失资产不签；无APP_KEY时既有静态/HTTPS图片仍可读。图片签名在事务外，资产元数据锁在写事务内。该时段批次的媒体证明仅覆盖slot.pic；同日后续父扩展批已补公共秒杀列表商品主图共享policy签名，见上方最新段，完整公共媒体/R2验收仍开放。

浏览器验收使用实际构建页与隔离合成API，桌面1280×850及手机390×844验证只读、分页/筛选、24:00新增、显隐取消/确认、平台图库/上传、坏项修复、占用删除拒绝、成功删除、失败重试及已持久化但响应未知时只GET重读。共82请求，74 GET、2 POST、3 PUT、3 DELETE；7笔时段写入与1笔合成上传的各UUID出现一次，不据此保证底层网络永不重传。页面无横向溢出，手机表格内部可横滑；服务已停、5198无监听、页关闭并恢复viewport。证据见[浏览器验收](../audit/seckill-time-browser-20260927.json)。原生和类型验收由本批独立证据记录；完整Linux CI、真实配置/角色及发布验收仍开放。该时段批次结束时，父活动日期、多时段、复制和商品/规格关系仍待下一批恢复；同日后续核心实现见上方最新段，不能用此时段页抵作父活动完成。

最终原生PG16.15为11文件342/342，零失败／零跳过：业务28和购买并发14、真实固定能力33（32原生权限/锁用例及1外部SQL一致性）、三条完整schema路径2、实际受限LOGIN30、既有六消费者文件235。末次owner列级INSERT/REFERENCES及grant option拒绝补丁后，业务/能力/升级77项和LOGIN30项分别复跑通过；重跑替代先前结果，不累加。初轮ACL夹具、idle连接owner设置、Windows文件错误及initdb超时保留为历史，不能提升为通过。PGlite28使用窄能力替身，不作为真实权限证据；轻量注册/计划91通过、29原生跳过与最终native分开。前端22项时段和8项目录、五文件18项台账回归、Worker顺序unit/runtime及Admin最终类型/构建通过。所有已跑实例夹具清零、pg_ctl停止、端口无监听；冻结源码及完整日志哈希见[原生验收](../audit/seckill-time-native-20260927.json)和[固定能力验收](../audit/seckill-time-reference-lock-20260927.json)。历史seed九路径168/173证据未被计作当前169/174九路径复验。

时段批次结束时记录的受限秒杀购买权限缺口：当时app profile 对 `store_activity`、`store_seckill_time` 只有SELECT，而真实购买使用FOR SHARE行锁，需要额外的锁授权合同。该批固定删除函数只给Admin，不解决该app缺口，也不扩大父活动DML。235项消费者和新增购买交错使用原生维护夹具，证明SQL/并发行为；runtime-business-login的30项验证实际受限普通/预售业务，未覆盖实际app角色秒杀购买。不能合并宣称该生产购买权限已验收；同日后续父批次另补窄锁合同与实际角色回归，终态以独立新证据为准，不能沿用旧计数。字段、日期、多场次、商品/SKU及复制的实施前源码调查见[父活动合同](admin-seckill-parent-contract.md)；当时父目录missing，同日核心批创建页partial，后续五能力闭合后当前列表/完整创建页均candidate，见上方最新段。

签到视觉配置仍为missing：旧 `sign_day_num` 仅包含day/sign_num、sort/status及静态六色手机图。当前旧PHP与Worker的签到逻辑均消费 `sign_mode`、基础积分和 `system_sign_reward`，没有读取这组7天遗留数据；现有 `/marketing/sign-rewards` 不能算该旧页的等价替代。后续须核清历史配置用途再决定恢复或退役。

充值候选验证：新SQL17项、既有checkout-payment8项及ACL8项在PGlite33/33通过；最终原生PostgreSQL16.15四文件42/42、零跳过，新增9个独立连接场景覆盖改价/隐藏/删除与下单双种先后、20条容量竞争、同key创建和陈旧版本更新/删除。成功下单后实际结算及重复回调只按快照入账一次，未知请求重放不重复写记录或审计，审计失败全部回滚。原生测试使用隔离非superuser finance_test，夹具余留0并正常STOPPED，两个本轮实例端口62699/51351均核验无连接。测试最初将H5建单渠道误作provider入账类型，已改为实际weixin并完整复跑最终42项。前端17项真实Vue/Axios运行时、另18项前端API/路由审计、Worker unit/runtime类型及Admin最终类型/构建通过；前端测试的未用变量已清理后复验。

CUA内置浏览器连接127.0.0.1:5198的实际构建Admin与合成内存API：只读隐藏所有写控件；12.345金额被阻止，12.34/1.20按两位金额保存并置顶预览；损坏档位可读取详情修复为25.00/0.00；显隐取消不写、确认后预览移除；20条禁新增但仍可编辑，删除后恢复19条与新增按钮；读取失败清空旧预览并可重试；已持久化的赠送51.25在部分响应中断后显示未知结果并只GET重读。记录共37个API请求：32 GET、1 POST、3 PUT、1 DELETE，未知写请求只有一次；该合成场景不代表底层网络永不重传。1280×850及390×844页面无横向溢出，手机表单可见，console error/warn为空。桌面初验发现固定操作列遮挡排序，已收紧列宽并重新构建、截图确认。截图recharge-desktop.jpg、recharge-mobile.jpg、recharge-mobile-form.jpg及未知结果截图/请求日志保存在本次外部本机验收目录；浏览器页已关、viewport已恢复、loopback服务已停且5198无监听。没有连接生产或支付provider，真实基础组/档位、受限角色、完整Linux CI和渠道验收仍开放。

历史统计快照（拼团完整表单阶段，2026-09-27）：当时11份逐屏台账合计 **274/274 已审**；其中营销域为12条candidate、20条partial、16条missing、0条retired，全部域为51条candidate、119条partial、97条missing、7条retired。逐屏状态仅为本地候选，最新增量见本页顶部；已审不等于功能已覆盖，跨域真实角色/数据 E2E 及发布验收仍开放，不用此历史快照改变FE-001D的代码审计勾选范围。

2026-09-26 分页候选验证：`admin-activity-list.test.ts` 与权限回归31项、活动编辑保留与砍价SKU/内容/配送表单84项、实际Vue/Axios目录运行时8项、路由/前端API/逐屏/UniApp审计35项，共158个不同用例通过；Admin类型与完整构建、Worker unit/runtime类型检查通过。Browser插件未列入当前会话，按前端测试技能使用已有Playwright 1.62.1和无头Edge，访问仅回环的实际Vite Admin页；1280×800与390×844验证123条合成记录的第2页保持、第7页超过100条仍可达、名称/状态筛选与重置、四tab、失败重试、空集及页面无横向溢出。只读角色无新增/编辑按钮，23次合成API请求均GET，外发与控制台错误均0。第一次状态选择自动化点到被placeholder遮挡的内部input超时，改点击实际可见选择器外框后通过；未据此改动产品组件。该浏览器验证使用合成API，SQL行为另由PGlite真实SQL测试覆盖，不声称原生PG、真实账号/数据、Linux CI或已发布。

额外执行既有 `bargain-admin-retirement.test.ts` 得到10通过、6跳过、3失败：两个取消/退款场景在下单夹具阶段因缺pricing capability失败，一个故障注入场景被PGlite的prepared多SQL限制拒绝；失败路径不调用本轮修改的列表。保留为未通过证据，未降低断言或改写资金业务以获得通过。

同日后续复核：已确认 Browser 插件安装且 CUA 内置浏览器可调用；上段“未列入当前会话”不能据此推断未安装。内置浏览器重新确认活动目录第2/7页、超过100条记录可达及只读权限。砍价退役回归改用 `node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/bargain-admin-retirement.test.ts`，在隔离loopback PostgreSQL16.15中20/20通过、零跳过，夹具余留0且实例停止。此结果取代上段PGlite失败作为该文件最新验证状态；最初失败保留为执行历史。默认沙箱启动原生PG时遇Windows restricted-token error87，按相同隔离方案获执行权限后通过，未连接生产。

定向复核命令：在 `workers-ts` 下运行 `node node_modules/vitest/vitest.mjs run test/admin-marketing-frontend-parity.test.ts`。重新生成台账用 `node node_modules/tsx/dist/cli.mjs scripts/admin-marketing-frontend-parity-audit.ts --write`。
