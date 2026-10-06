# 秒杀父活动管理合同与实施记录

最新增量：2026-09-27，本地候选／未发布。`/activity/seckill-activities` 与九项专用 REST（双入口共18项注册），以独立 `seckill_activity.view/manage` 承接父目录、上海日期、多场次、商品/SKU、新建、原位编辑、复制、级联启停与软删除。已补齐创建页剩余五项交互：分类/单标签筛选、跨页多选一次添加、跨商品批量设置/移除、选品类型/分类列及 SKU 自身图片；父列表和创建/编辑页均为 candidate。`/activity` 仍管理子商品，`/activity/seckill-times` 仍管理时段，三个实体和 ID 不混用。

分类选项为平台可见祖先分支，单次分类或标签最多5000项，超限拒绝而不截断。分类筛选包含所选分类的全部后代；标签包含隐藏/禁用项，关系状态不作为过滤条件，按关系存在判定并去重。`product_type` 展示商品实物/卡密/虚拟/次卡类型，与平台/供应商归属类型分开。分类列合并有效 type=1 关系与合法旧 cateID，验证平台或本商品供应商归属并去重；显示去重分类名称集合，与旧 PHP 直接父级/当前分类路径的格式有差异，损坏引用展示“未知分类 #ID”。跨页选择保留，批量读取全部源规格成功后才一次加入，失败/取消/换号不部分写入。批量额度保留已消耗量下限；历史移除退休规格并保留身份，未保存新商品可从草稿移除。

SKU 图片保存稳定引用，响应中只签名真实所属方的专用栅格附件；平台真实上传前缀为 `attachments/admin/1/`，供应商限定自身且仍有效，不用主图冒充 SKU 图片。公共 `ActivityService.seckillList` 主图同样按归属验证并生成新 HMAC，数据库引用不变。本轮最终原生5文件65项（业务33、并发及实际 Admin 8、实际 app LOGIN 12、媒体6、PC购买6），前端3文件75项、列表兼容单测2项及明确五文件台账33项均通过，零失败／零跳过；Worker双类型和Admin类型/生产构建通过。实际受限 Admin 已验证分类/标签/关系/附件读取，未扩大角色或授权。见[本轮原生证据](../audit/seckill-parent-extras-native-20260927.json)及[本轮浏览器证据](../audit/seckill-parent-extras-browser-20260927.json)。完整公共媒体、真实 JWT/R2/provider、完整 Linux CI 和部署验收仍开放。

实施以服务端源商品为权威，允许平台 type=0/1、relation_id=0 及有效供应商 type=2；重新检查来源、规格身份、库存、价格和配送。已有子商品/SKU 原位保留，配置总额度不得低于已消耗量；剩余额度按总额度减已消耗量计算。停用/移除退休历史规格，保留订单、取消和退款恢复身份。创建及编辑在锁后读取数据库时间，结束日期当天包含在活动内；已结束/损坏项仍可读取、关闭或软删除。普通保存保留各商品开关，列表启停明确级联全部关联商品，重新开启会重开此前单独关闭的商品，但不会取消软删除标记。复制先编辑预填内容再创建新父/子/SKU，不携带旧销售身份。

前批 core99 历史证据：真实受限 app LOGIN 通过父/时段 `UPDATE(id)` 加独立无语义改写锁边界取得 FOR SHARE 权限；Admin 仅补父 INSERT/UPDATE 和固定序列 USAGE，不授予父物理 DELETE。现存角色使用两步固定窄升级，原锁边界不改、迁移注册仍169外部/174内嵌。该批新权限、业务、实际购买/额度调整/退休后取消及并发共69项通过，另30项既有普通 LOGIN 回归通过；前端新23项、旧时段/活动列表30项及33项台账回归、Worker双类型和Admin构建通过。该批浏览器103请求以当时构建和本机内存合成 API 验证交互，不能替代数据库或真实生产身份/Provider 验收。其32份源码已按原字节归档，旧路由快照和runner另存哈希对应副本，旧dist输出已被本轮最终构建替换；历史证据不计入本轮65/75/33/2。见[前批原生证据](../audit/seckill-parent-native-20260927.json)、[前批业务细证](../audit/seckill-parent-business-20260927.json)、[前批浏览器证据](../audit/seckill-parent-browser-20260927.json)和[权限维护合同](seckill-runtime-privileges.md)。

以下保留实施前同日静态调查：其中“尚未实现／待确认／未运行”描述调查当时状态，当前实现及验收以上方增量为准。

## 实施前静态调查（历史）

调查日期：2026-09-27。范围是旧 Admin `/admin/marketing/store_seckill/list` 及其创建、编辑、复制、启停、删除流程，对照当时 Worker、PostgreSQL schema 和新 Admin。本节是静态源码调查与后续实施边界，不是运行验收；调查阶段未运行 PHP、浏览器、数据库或生产操作，未修改业务代码、测试、候选台账或已冻结的时段实现。

**调查当时新 Admin 尚未实现独立秒杀父活动目录及其管理流程。** `/activity` 的秒杀 tab 管理 `store_seckill` 子商品；已完成的独立时段目录管理另一种实体。两者不能证明旧父活动页面已迁移。调查时旧父活动列表对应的 ledger 状态保持 `missing`；静态调查本身不提升任何状态。

## 1. 实体和 ID 必须分开

| 实体 | 主键与关联 | 在本合同中的用途 |
| --- | --- | --- |
| 父活动 `store_activity` | `id`，`type=1` 表示秒杀 | 名称、日期范围、每日多个场次、统一限购、开关、氛围图、适用门店；旧列表的一行 |
| 秒杀子商品 `store_seckill` | `id`；`activity_id` 指父活动；`product_id` 指基础商品 | 活动价、额度、实际销量、子商品开关、配送及购买身份；一个父活动可以包含多个子商品 |
| 基础商品 `store_product` | `id` | 商品选择器传回的 ID；规格、库存、内容、所属方和配送规则的来源 |
| 活动 SKU `store_product_attr_value` | `product_id=子商品ID, type=1, unique/suk` | 秒杀计价、活动库存和额度；不是 `product_id=父活动ID` |
| 基础 SKU `store_product_attr_value` | `product_id=基础商品ID, type=0, unique/suk` | 真实商品库存与规格；购买时与活动 SKU 配对 |
| `store_activity_relation` | `activity_id, product_id` | 已迁移的通用关系表；本次查到的 PHP 秒杀父管理路径使用 `store_seckill.activity_id`，没有写此表，不能仅因表存在便替换关联模型 |

尤其注意：旧保存字段叫 `seckill_ids`，其中每项 `id` 实际是**基础商品 ID**。订单的 `type=1, activity_id` 则是**秒杀子商品 ID**，不是父活动 ID。后续 DTO 应明确区分这些命名，避免错误聚合限购或统计。

源码：[PHP 父保存映射](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:235)、[PHP 活动规格保存](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:241)、[Worker 订单写入身份](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderCreateService.ts:2474)、[Worker SKU 身份桥](C:/cinagroup/cinashop/workers-ts/src/services/activity/ActivityOrderSkuService.ts:15)。

## 2. 旧页面与 API 实际接线

旧路由 `store_seckill/list` 使用 `storeSeckill/list.vue`，权限标记为 `marketing-seckill_list`。创建和编辑共用 `store_seckill/create/:id?/:copy?`，权限标记为 `marketing-store_seckill-create`。列表默认 `page=1, limit=15`，筛选 UI 为“未开始/进行中/已结束”“开启/关闭”“秒杀名称、ID”。列为 ID、活动名称、活动日期、秒杀场次、参与商品数、活动状态、是否开启、创建时间、操作。操作包含编辑、复制、删除；删除尾页成功后回退一页重读。导出按钮被注释，不能把残留方法记作已提供操作。

| 页面 API 包装 | 旧 Admin 相对路径 | 意图与响应 |
| --- | --- | --- |
| `seckillListApi` | `GET marketing/seckill` | 父列表 `{list,count}` |
| `seckillInfoApi` | `GET marketing/seckill/:id` | `{info}`，包含父基础字段和 `productList` |
| `seckillAddApi` | `POST marketing/seckill/:id` | `id=0` 新建；正 ID 编辑 |
| `seckillStatusApi` | `PUT marketing/seckill/set_status/:id/:status` | 同步父开关和关联子商品开关 |
| 列表确认删除 | `DELETE marketing/seckill/:id` | 父、关联子商品软删除 |
| `seckillTimeListApi` | `GET marketing/seckill/time_list` | 创建表单的场次选项来源 |
| 商品选择器 `changeListApi` | `GET product/product/list` | 可分页筛选基础商品和规格 |

列表服务以 `type=1,is_del=0` 查询 `store_activity`，默认排序 `start_time asc,id desc`。`product_count` 是模型关系中 `is_show=1,is_del=0` 子商品的数量，**不是规格数，也不要求子商品 `status=1`**。`time_list` 根据父 `time_id` 连接可用场次；`start_day/end_day` 格式化为 `YYYY-MM-DD`，`add_time` 模型格式化为日期时间。父 `start_name` 根据父开关和整段日期计算，不代表当前分钟属于每日某一场。

已发现的旧静态接线问题，后续不应照抄：

- 父 controller `index()` 收取 `time/status/store_name`，没有收取页面发送的 `start_status`；父 DAO 虽有阶段筛选分支，页面请求未在此 controller 进入该分支。
- 父模型名称搜索器是 `searchNameAttr`，内部使用 `title|id`，与父表 `name`、controller `store_name` 均不一致。只能记作搜索接线缺陷，不能据此宣布旧名称搜索可用。
- `route/admin.php` 先注册父 `seckill`、详情、保存、删除、状态路由，随后又用相同 method/path 注册子商品 controller；`time_list` 也重复。本文记录页面与父 controller 的设计意图和重复注册事实，**没有运行验证 ThinkPHP 最终选择哪个 handler**。新 Worker 必须使用无歧义的父路由，不复刻重复路径。

源码：[旧路由](C:/cinagroup/cinashop-php/view/admin/src/router/modules/marketing.js:241)、[列表 UI/方法](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/list.vue:178)、[API 包装](C:/cinagroup/cinashop-php/view/admin/src/api/marketing.js:403)、[重复后端路由](C:/cinagroup/cinashop-php/route/admin.php:1039)、[父 controller 查询](C:/cinagroup/cinashop-php/app/controller/admin/v1/marketing/seckill/StoreActivitySeckill.php:39)、[列表投影](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:62)、[关系及搜索器](C:/cinagroup/cinashop-php/app/model/activity/StoreActivity.php:111)、[父 DAO 阶段查询](C:/cinagroup/cinashop-php/app/dao/activity/StoreActivityDao.php:42)。

## 3. 保存字段、日期、多场次

| 旧输入 | 存储/校验和可见行为 | 后续必须明确的边界 |
| --- | --- | --- |
| `name` | 必填；父表 varchar(128) | 长度、空白、控制字符由新服务显式校验 |
| `section_data:[开始日期,结束日期]` | 页面 date range；PHP `strtotime` 写 `start_day/end_day` 秒级 epoch | 固定 `Asia/Shanghai` 日历日期；开始日 00:00，结束日整日包含；验证真实日期、开始不晚于结束、PG int 范围 |
| `time_id:number[]` | 必填、多选；模型转逗号串；关联子商品继承同一组选项 | 接受真实正 ID，去重、有界；当前消费者最多 64 个；保留读取损坏历史数据的修复能力，不能伪造一个默认场次 |
| `num` | 必填且大于 0；UI 表示每用户、每商品整个活动累计购买上限 | 购买端按子商品 ID 累计，不是把父下全部商品混在一起；父配置须一致传给子商品 |
| `once_num` | 必填且大于 0，且不能大于 `num`；UI 标注单次限购 | 旧父 SQL 注释写“每日数量”，与 UI/子购买实现不一致；采用经购买代码核实的“单订单上限”须在实现合同写清 |
| `image` | 可选氛围图；旧页面图片选择器；父表 varchar(128) | 是父氛围图，不能覆盖子商品主图；要单独确定稳定图片引用、长度和公共预览策略 |
| `status` | 开关 0/1；页面新建默认 1，controller 默认 0 | 服务严格 0/1；启用前验证整套父、子、规格、排期可消费 |
| `seckill_ids:[{id,status,attrValue}]` | 必填商品列表；`id` 为基础商品 ID；`attrValue` 逐规格携带价格、额度、参与标记 | 不接受客户端供应的库存、所属方、配送和基础内容作为可信来源；从服务端重新加载 |
| `applicable_type` | schema 注释：0 仅平台、1 所有门店、2 部分门店；旧 controller 收取 | 父创建页面当前未提供对应门店控件；不能把 controller 能收取视为已完整提供门店工作流 |
| `applicable_store_id` | type=1 清空；type=2 必须非空；模型转逗号串 | scope、真实门店、是否开放门店购买须另行核对；不默认扩展到门店/供应商写入 |

父 `type/is_del/add_time` 应由服务控制。旧表另外保留 `start_time/end_time` 数字 HHmm、`discount/is_recommend/link_id`，但当前父表单和父保存 controller 不编辑这些字段；多场次不应被压回一个 `start_time/end_time`。损坏或 nullable 的旧字段不能因无关改名而被默认值覆盖。

PHP 配置时区为 `Asia/Shanghai`。父保存把日期写为当地午夜；结束日期不能早于“当前时间减一天”的校验实际是 `strtotime(end)+86400 < time()`。旧代码没有完整验证真实日历日期、数组恰有两项及开始不晚于结束。父列表阶段是 `end_day+86400`；每日场次在整个日期范围内重复开启。当前 Worker 的日历窗口采用开始包含、次日 00:00 结束排他，并将子日期与父日期取交集；这是后续父编辑必须满足的消费约束。

源码：[表单基础字段](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue:36)、[表单默认值](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue:307)、[旧校验](C:/cinagroup/cinashop-php/app/validate/admin/marketing/StoreActivitySeckillValidate.php:23)、[controller 日期/限购/门店校验](C:/cinagroup/cinashop-php/app/controller/admin/v1/marketing/seckill/StoreActivitySeckill.php:66)、[PHP 时区](C:/cinagroup/cinashop-php/config/app.php:38)、[父字段 SQL](C:/cinagroup/cinashop-php/public/install/crmeb.sql:3657)、[当前日期与多场次消费](C:/cinagroup/cinashop/workers-ts/src/services/activity/SeckillScheduleService.ts:22)。

## 4. 商品、规格、额度与内容继承

旧创建页分“基础设置/添加商品”两个 tab。商品选择器有分类、标签、名称搜索、分页；排除预售和 SVIP 专享商品，商品按基础 ID 去重。表内树形展开 `attrValue`，可逐规格选择参与/不参与、填秒杀价和限量；支持所选商品的批量价格/额度设置、批量移除商品、单商品全部规格开关。成本价、划线价、库存是可见字段；提交实际包含整个商品的 `attrValue` 数组。

详情先读所有未删除关联子商品及活动 SKU，再读未删除、审核通过的基础商品；按基础商品 ID 和 `suk` 合并。活动 SKU 存在即将对应基础 SKU 的参与标记置 1，覆盖活动价、成本价、划线价、当前剩余额度 `quota` 和原始额度 `quota_show`。详情失去基础商品或某个基础 SKU 时，其展示集合可能缩小；后续不能把“读不到”直接解释成用户要求删除历史身份。

父保存对每个基础商品创建一个子商品，并从服务端商品继承标题、简介、单位、轮播图、描述、商品类型、所属方、标签、保障、参数、配送方式、运费、模板、系统表单和自定义表单。父日期、场次、`num/once_num`、门店适用范围传入子商品；子商品 `status` 则来自每个商品项，未直接采用父 `status`。仅参与的 SKU 被写为活动 SKU，以 `suk` 匹配服务端规格。检查参与规格有非零活动价、单 SKU 额度不超过基础 SKU 库存，且商品总额度不超过基础商品库存；未参与规格跳过。额度必填校验在 PHP 中被注释，因此不能声称旧保存保证额度大于 0。

子保存将日期变为 `start_time/stop_time` epoch，取参与规格最小活动价和划线价，求和 `quota`，并把 `quota_show` 初始化为相同值；`stock` 来源是规格库存之和。活动 SKU 写入 `type=1,product_id=新子ID`，并设置 Redis 活动库存。此处是“配置活动额度”，并非商品库存已被订单购买；真正购买还要同时扣基础商品与基础 SKU。

**旧编辑不是原位更新**：父事务先更新父，`clearAcivityAttr` 物理删除旧未删除子商品、对应 type=1 的规格结果/规格/规格值/描述，再调用子保存 `id=0` 重建，子 ID 和活动 SKU 身份发生变化，历史销量及额度基线可能重置。后续不能照搬该算法：现有订单、购物车、退款恢复、购买累计和活动 SKU 桥都依赖旧子身份。既有商品/SKU 应原位更新并保留已售额度；移除使用有明确语义的停用/退休，保留退款和订单证据，必要时拒绝无法安全变更的项目。

源码：[商品树和批量 UI](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue:118)、[选择器来源/排除](C:/cinagroup/cinashop-php/view/admin/src/components/goodsList/index.vue:357)、[按基础 ID 去重](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue:532)、[详情规格合并](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:131)、[父事务与创建子商品](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:197)、[继承和规格验证](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:235)、[旧清除算法](C:/cinagroup/cinashop-php/app/services/activity/StoreActivityServices.php:321)、[子保存及 Redis 初始化](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:176)。

## 5. 复制、父启停和删除

复制是进入 `create/旧父ID/1`，读取旧详情预填，同一表单最后 `POST .../0`。虽然前端设置 `copy=1`，父 controller 的白名单不收取该字段；起决定作用的是 URL 中 `id=0`。所以没有独立父“立即复制”API，也没有列表点击后立即落库。复制保存会生成新父、新子和新活动 SKU；商品价和额度来自详情预填，其中 `quota` 为旧子当前剩余额度，并不是自动恢复旧 `quota_show`。不应带走旧销量、已购用户、订单或原 SKU identity。后续需要明确是否允许调整日期、名称和额度后再创建，并使用一次性写标识避免重复新建。

旧 `set_status` 先更新父 `status`，查所有关联子 ID 并逐个把其 `status` 改成相同值，更新缓存。因此“重新启用父”会连原先单独关闭的子商品也改为启用；并非仅对父做门控。controller 没有把整组操作包进同一个显式事务，也没有校验已结束/损坏排期或 SKU 可购买性。后续必须确定是否延续“级联重开”还是保留独立子开关；这一点不能由 UI 擅自猜测。当前 Worker 消费已经有父开关门控，保留子开关可行，但属于待确认的行为变更。

旧删除把父 `is_del=1`，再对关联子 `is_del=1`；删除相关库存缓存和商品属性缓存，不物理删父，也不删除历史订单。此 controller 没有完整组事务或未支付订单/退款的显式阻断条件。后续删除必须原子停用父及关联子、保留已有订单/SKU身份和恢复库存证据，验证与正在确认、创建、取消、退款操作并发时不产生悬空关联。是否允许已结束父归档或恢复，要单独定义，不能默认物理删除。

源码：[列表编辑/复制/删除入口](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/list.vue:304)、[复制保存](C:/cinagroup/cinashop-php/view/admin/src/pages/marketing/storeSeckill/create.vue:606)、[父 controller 接收字段](C:/cinagroup/cinashop-php/app/controller/admin/v1/marketing/seckill/StoreActivitySeckill.php:66)、[父删除](C:/cinagroup/cinashop-php/app/controller/admin/v1/marketing/seckill/StoreActivitySeckill.php:108)、[级联启停](C:/cinagroup/cinashop-php/app/controller/admin/v1/marketing/seckill/StoreActivitySeckill.php:141)。

## 6. 旧 PHP 公共消费行为与不能照抄的边界

公共 `getListByTime` 先按请求场次取父 `type=1,status=1,is_del=0`，要求父日期包含当前日，再按父 ID 取启用、未删除、日期有效且基础商品未删除的子商品。返回的商品 `id` 是子 ID，`activity_id` 是父 ID，`activity_image` 来自父氛围图。父与子 `time_id` 都是完整多场次逗号串；一个父下的一个基础商品生成一个子记录，没有按日期或场次生成副本。所读链路没有每日/每场重新生成库存或重置限购的逻辑。

详情按子 ID 读取，未以父状态、父删除、日期作完整过滤；父详情只取 `id,start_day,end_day,time_id`。详情中的时段显示用子 `time_id`，缺少时才用父场次。购买入口 `checkSeckillStock` 则调用子状态/删除/日期/启用场次校验，再查活动 SKU 和额度；该入口没有重新读取父开关，旧 Admin 的父→子开关联动因此影响其购买有效性。不能把详情展示、公共列表可见或缓存订单组当成持续有效的购买授权。

几个边界差异应在后续实现中明确修正，不定义为兼容要求：

- PHP 日期验证 `stop_time >= now-86400` 可在结束日次日恰好零点继续通过等号；购买时段使用 `[start,end)`，时段首页却使用 `current<=end`，末分钟展示可能与购买不一致。
- `once_num` 为本次数量上限，`num` 对子 ID 累计；没有日期/场次条件，没有每日重置。历史计数包含所有已支付主单及未删除未支付主单，未按退款状态排除；0 在购买代码中会阻止正数购买，并不是 schema 注释中的“0 不限”。
- 购买先扣 type=1 活动 SKU，以相同 `suk` 找基础 type=0 SKU 扣原商品库存；退款/恢复做逆向操作。旧 Redis SKU 队列也是按活动 SKU unique。重新生成子 ID/SKU 会影响这些引用。
- 所读订单创建链使用缓存订单组，Redis库存弹出发生在 API 下单流程；未看到再次调用完整秒杀日期/场次/限购校验。新 Worker 已有交易内重检，不能降级成旧缓存授权语义。
- `AutoSeckill` 每约 2000ms 清理结束日后的缓存，遍历旧 `routine_seckill_time` GroupData；没有修改父/子状态、恢复额度或清零限购。不能靠该定时器补父管理状态机。

调查限度：子总量更新继续委托 `BaseDao→BaseAuth`，后者是编码文件；本文只记录明文调用和 SKU DAO 更新，不宣称已验证该旧委托的原子性或所有字段。

源码：[公共父筛选和父氛围图](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:430)、[子目录过滤](C:/cinagroup/cinashop-php/app/dao/activity/seckill/StoreSeckillDao.php:132)、[日期/场次购买边界](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:104)、[旧首页结束包含](C:/cinagroup/cinashop-php/app/controller/api/v1/activity/StoreSeckill.php:55)、[详情与时段显示](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:480)、[购买校验及限购](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:734)、[限购历史订单查询](C:/cinagroup/cinashop-php/app/dao/order/StoreOrderDao.php:629)、[子/基础库存扣减和恢复](C:/cinagroup/cinashop-php/app/services/activity/seckill/StoreSeckillServices.php:649)、[退款恢复](C:/cinagroup/cinashop-php/app/services/order/StoreOrderRefundServices.php:980)、[购物车子身份](C:/cinagroup/cinashop-php/app/controller/api/v1/order/StoreCart.php:119)、[旧订单子身份](C:/cinagroup/cinashop-php/app/services/order/StoreOrderCreateServices.php:366)、[缓存订单组读取](C:/cinagroup/cinashop-php/app/services/order/StoreOrderServices.php:1752)、[API Redis库存操作](C:/cinagroup/cinashop-php/app/controller/api/v1/order/StoreOrder.php:275)、[定时清缓存](C:/cinagroup/cinashop-php/app/listener/activity/AutoSeckill.php:42)。

## 7. 当前 schema、消费能力和管理缺口

PostgreSQL 已有父表和关系表：external `0042_activity_catalog.sql`，embedded `migration_0049()`。父名称/氛围图为 128 字符；日期为 int 秒 epoch；`image/time_id/once_num/num/status/is_recommend/link_id/applicable_store_id` 保留 legacy nullable。关系表只有主键和双向普通索引，没有父子外键或唯一约束；子表 `activity_id/product_id/time_id` 也不能仅凭 schema 自动保证业务归属。迁移 manifest 将父/关系表安排在 activity phase 并在子表之前导入；子 `title→store_name`，字符串 epoch 的 `start_time/stop_time→timestamp`，`add_time→integer`。不可把旧 PHP 字符串 epoch 当成当前 Worker 子 timestamp 原样写入。

| 能力 | 当前 Worker/新 Admin 状态 |
| --- | --- |
| 独立父列表、日期和阶段筛选、参与商品数 | 未实现；通用列表只读子表，过滤未删除、keyword/status，分页默认 20、sort/id 倒序 |
| 父详情与多商品/SKU配置 | 未实现；`/activity` 通用编辑是单 `productId`、价格/库存等字段，没有父日期、多场次、多商品或秒杀 SKU 配置树 |
| 父新建、原位编辑、复制 | 未实现；`activity/save(type=seckill)` 只写子表，创建默认 `activityId=0`、`timeId='1'`、`num=2`，没有有效父/子排期、`once_num` 和活动 SKU 生成合同 |
| 父启停与原子删除 | 未实现；现有 status/del 按传入 ID 改一个子商品，不是父及其子集合 |
| 迁移旧父记录 | schema/manifest 已保留；这不代表已开放管理写入 |
| 公共子目录/详情的父门控 | 已实现；父 type/status/is_del、日期和场次都参与消费，不能绕过它们 |
| 购买与 SKU/累计限购 | 已实现；type=1 子 ID 身份、活动/基础 SKU 配对、库存与额度守卫；父编辑必须兼容 |
| 运行时父写权限 | 现有 app/admin business profile 中 `store_activity` 属只读；不能在 controller 里调用维护连接或临时授权解决缺口 |
| 受限 app 秒杀购买的排期行锁 | **真实权限缺口，尚未闭合**；app 对 `store_activity/store_seckill_time` 只有 SELECT，购买的 FOR SHARE 还需要 UPDATE 行锁权限 |

当前排期服务对非零 `child.activityId` 要求父存在、type=1、status=1、is_del=0、有效上海午夜日期；父/子日期和场次取交集，场次至多 64。同一天允许多个独立窗口，非活动分钟不可购买。公共浏览是在日期范围内按请求场次展示，允许当日场次尚未开始/已经结束的浏览，**不能把目录可见当成购买许可**。规格目录还校验子/基础商品可见、审核、限购正数、规格有效唯一和映射；每组最多 500 个 SKU。

订单确认及写入再次校验排期，写入使用既有父→子→场次锁顺序；累计限购按 uid+订单 type+子活动 ID 序列化，统计主单 pid=0/-1 的已付或未付未删订单；单次限购为单订单数量。库存扣减同时作用于子商品/活动 SKU 和基础商品/基础 SKU，历史购买、退款与取消依赖保留的身份与快照。新父编辑不能直接重建子记录来绕过已购累计，也不能把父总配置误当作父下全部商品共享一个额度池。

### 受限 app 行锁权限未验收

源码核对发现：`runtimeBusinessPrivilegePlan('app')` 将 `store_activity` 和 `store_seckill_time` 放在 `sharedRead`；两表没有列级 `sharedColumns` UPDATE，也不在 `RUNTIME_TABLE_LOCK_UPDATE` 或现有 `RUNTIME_LOCK_ONLY_RULES.app` 中。购买时 `loadSeckillSchedule(...,true)` 对关联父行 `FOR SHARE`，再对场次行 `FOR SHARE`。PostgreSQL 的这类行锁除 SELECT 外还要求至少一列 UPDATE 权限；当前 exact app profile 不满足，静态合同因此存在 42501 拒绝风险。独立旧子商品即使 `activity_id=0`，也仍需场次行锁。本文没有运行新复现，也没有修改或授权生产/app角色。

已有 **235 项消费者回归**覆盖纯策略与 native 业务行为，其中 native fixture 采用维护/setup 权限，不能证明实际受限 app 已能执行这条锁路径。已汇总的 **runtime LOGIN 30 项**覆盖权限协议及普通/预售的公开确认、创建、取消路径；源码中 `publicCreate` 使用 `type=0/6`，没有秒杀 `type=1` 完整购买。`auditRuntimeBusinessPrivileges.ready` 只能证明当前声明的权限 profile 符合其计划，不能反证计划遗漏业务所需行锁权限。

后续父活动与真实角色批次须先定义并验收**仅满足固定排期行锁的窄权限合同**：至少明确这两表的安全锁授权、阻止语义 UPDATE 的边界、grant/audit/安装重复与漂移行为，以及实际受限 app 下的秒杀确认→创建、父关联和独立子商品、并发启停/排期变更与库存恢复。不得把解决行锁需求扩大为 app 的父活动/时段业务编辑权限；父管理 DML 是另一个显式受限 Admin 合同。本调查和已冻结批次均不扩大 app/parent DML，也不据当前测试关闭该缺口。

源码：[app 两表只读声明](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:89)、[列级权限集合](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:101)、[计划合成](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:161)、[现有行锁边界及权限要求](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeLockOnlyBoundary.ts:8)、[父 FOR SHARE](C:/cinagroup/cinashop/workers-ts/src/services/activity/SeckillScheduleService.ts:147)、[场次 FOR SHARE](C:/cinagroup/cinashop/workers-ts/src/services/activity/SeckillScheduleService.ts:170)、[维护 fixture 身份](C:/cinagroup/cinashop/workers-ts/test/helpers/financePostgres.ts:95)、[runtime LOGIN 公开创建类型](C:/cinagroup/cinashop/workers-ts/test/runtime-business-login.test.ts:62)、[普通/预售公开回归](C:/cinagroup/cinashop/workers-ts/test/runtime-business-login.test.ts:188)。

源码：[PG 父 schema](C:/cinagroup/cinashop/workers-ts/src/models/schema/activity_catalog.ts:4)、[external 0042](C:/cinagroup/cinashop/workers-ts/migrations/0042_activity_catalog.sql:2)、[embedded 0049](C:/cinagroup/cinashop/workers-ts/src/services/MigrationService.ts:3363)、[迁移顺序/转换](C:/cinagroup/cinashop/workers-ts/scripts/data-migration/manifest.ts:732)、[通用子列表](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminActivityListService.ts:41)、[当前子保存](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/AdminCrudController.ts:2051)、[当前子启停](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/AdminCrudController.ts:1310)、[当前子删除](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/AdminCrudController.ts:2178)、[当前编辑 payload](C:/cinagroup/cinashop/view/admin-ts/src/pages/activity/ActivityList.vue:583)、[SKU目录](C:/cinagroup/cinashop/workers-ts/src/services/activity/SeckillSkuCatalogService.ts:44)、[排期读取/锁顺序](C:/cinagroup/cinashop/workers-ts/src/services/activity/SeckillScheduleService.ts:138)、[累计限购/库存写守卫](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderCreateService.ts:2157)、[只读父权限](C:/cinagroup/cinashop/workers-ts/src/migrations/runtimeBusinessPrivilegePlan.ts:89)。

## 8. 后续实施必须先落定的合同（以下尚未编码）

1. 独立父页面、路由和查看/管理权限，父/子/基础商品 ID 在 DTO 中明示；父路由不能与现有子列表、时段、统计路由混同。具体路径和权限名待实施批次定稿，不是本文新增的有效 API。
2. 父列表需要 page/limit、名称或精确 ID、启停、日期阶段各自清晰的筛选；统计 `product_count` 的可见/启用口径明确，阶段与开关分开，所有过滤在分页前执行。列表/详情展示损坏历史配置，不把坏数据写回默认值。
3. 父详情返回可校验的日期、场次 IDs、商品及活动 SKU 身份、当前额度和总额度；商品选择和 SKU 选择从已有真实目录能力取数，服务重新验证基础商品、SKU、库存、所属方和配送，不信客户端快照。
4. 保存原子提交父、子和活动 SKU；逐字段白名单、容量/日期/金额/数值范围、重复项、版本与写请求标识；保留无关字段、已售额度、订单及身份。未知写结果只读取核对，不能自动重放新建/复制。
5. 父限购到子的同步、父启用是否重开手动关闭子商品、编辑日期/额度对已有订单的影响、移除/复制 SKU 身份，必须在实现前明确。对历史零/null 限购选择可理解的修复合同，不把 schema 的“0不限”注释悄悄变成购买端有效合同。
6. 保留现有排期、库存、价格快照和退款/取消协议，按已存在购买锁顺序协调父集合与商品/SKU写入。先闭合上述 app 排期行锁权限缺口；父 DML 权限另通过受限 Admin 的明确维护协议和实际 LOGIN 验收取得，不在运行时提权，不扩成 app 父/时段语义编辑；schema 权限变化与应用代码验收分别记录。
7. 实施验收覆盖父目录分页/只读、日期末日与多场次、子/SKU原位保存与额度守恒、重复请求、复制新身份、独立子关闭行为、父删除/启停与并发购买/取消/退款、旧迁移坏数据和受限 LOGIN。这里列的是未来验收要求，本调查没有新增或运行这些测试。

台账仍是“父活动列表/创建/编辑未实现”。只有后续父管理工作流、后端事务、权限和真实验收完成后，才另行评审候选状态。
