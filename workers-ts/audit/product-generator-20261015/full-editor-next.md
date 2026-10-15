# 完整六步商品编辑器：下一步实施清单（2026-10-15）

状态：证据收集中。本报告只读检查仓库，不修改产品实现。新系统部署不承接旧站真实数据，描述导入仅作为条件限制；优先补齐六步编辑器 UI 主线。

## 已确认范围

- 对照 TS 后端 `workers-ts/src/services/admin/AdminLegacyProductInput.ts`、当前管理端商品表单/API/列表/路由，与旧 PHP 管理端六步编辑器。
- 目标产物：可直接实施的字段映射、转换逻辑、可复用接口、入口/owner 限制，以及草稿与未知结果恢复差距。

## 实施清单（待补充证据）

## 1. 先接正确读写契约，再拆六步组件

- 当前 `view/admin-ts/src/pages/product/ProductForm.vue:402` 是简化单页 model（单个字符串分类、单品牌数值、`image`、主价格/库存）；`:463`/`:465` 调用 `src/api/product.ts:411-425` 的 `/product/add`、`/product/edit/:id`。这不是完整旧契约。
- 完整后端白名单已存在：`workers-ts/src/services/admin/AdminLegacyProductInput.ts:19-28` 共59项；完整 GET 为 `AdminLegacyProductReadService.ts:142`，返回 `{tempList,cateList,productInfo,editor}`（`:248`），不是现有 `apiAdminProductDetail` 平铺 `AdminProductEditor`。
- 下一步增加显式 `LegacyProductEditorDto`、`LegacyProductSavePayload` 与纯 `fromLegacyDetail` / `toLegacySave` 适配器，再把表单分成旧六步；不要将现有 `form` 展开直接 POST 到完整端点。
- 完整 GET 的 `productInfo.attr` 是单规格；`attrs` 仅多规格（Read `:212-214`）；现有 form 统一 `attrs`，应读时合并、写时统一送 `attrs`。`editor.retired_attrs` 应单独保存 UI 状态，不混入 active attrs（`:227`）。

### 必须落实的转换

| UI/GET | 完整保存格式 | 证据/注意 |
|---|---|---|
| 分类 `productInfo.cate_id` 字符串数组 | `cate_id: number[]`，必选、多选 | Input `:186-187`，当前 Form `:412` 是字符串单选 |
| 品牌当前 `number\|undefined` | `brand_id: number[]` | Input `:188`；GET `:201` 已为数组 |
| 主图当前 `image` | `slider_image: string[]`，1–10项；首项自动为 image | Input `:189-191,306` |
| SKU当前 `image` | `attrs[].pic` | Input `:209-210`；GET `:110` 为 pic；不能丢 identity `unique` |
| 会员/佣金当前 `is_vip` 标量 | `is_sub: Array<0\|1>`：0会员价、1独立佣金 | Input `:194-196,242-243`；GET `:203` |
| 标签 GET `{id,label_name}[]` | `store_label_id: number[]`、`label_id: number[]` | Read `:202`；Input `:188,274-281` |
| GET `coupons: {id,title}[]` | `coupon_ids: number[]` | Read `:206`，Input `:282` |
| 推荐 GET `{product_id:string,image}[]` | `recommend_list: number[]` | Read `:216`，Input `:282` |
| 活动 GET 中文名列表 | `activity: ['默认','秒杀','砍价','拼团']` 的用户顺序 | Input `:284-287` 将中文映射0/1/2/3；不能回传已映射数字 |
| 次卡当前 `write_start/end` Unix值 | `attrs[].section_time:[date,date]`；天数 `days`（或write_days） | Input `:228-247`，GET `:114`；日期按 Asia/Shanghai 还原（Read `:25-31`） |
| 上下架/预售 | `auto_on_time/auto_off_time` 日期字符串或合法秒；`presale_time`二元数组 | Input `:255-266`；定时上架自动强制 is_show=0 |
| GET `custom_form` / `editor.stored_custom_form` | 选择模板/保留实际快照需明确 UI 语义 | GET `:198,210,227`：前者来自当前模板；后者才是商品已存快照 |

当前后端已规范化重量、体积、金额两位小数，SKU单次200个、3维、每维50值（Input `:198-203,237-250`）；UI生成组合须同限并保留已有 identity。
## 2. 六步 UI 的直接实施分组与缺项

旧六步定义在 `/home/cina/cinagroup/cinashop-php/view/admin/src/pages/product/productAdd/index.vue:2328-2334`。非实物隐藏物流步、清邮费和供应商（`:3252-3276`），次卡保存时强制配送方式2（`:4249-4251`）。下表覆盖59白名单字段；隐藏/兼容字段也应进入 model/适配器，避免编辑时清零。

| 步骤 | 应接字段 | 当前TS表单状态与具体工作 |
|---|---|---|
| 1 基础信息 | `product_type,supplier_id,cate_id,store_name,unit_name,slider_image,brand_id,store_label_id,bar_code,code,video_open,video_link,is_show,auto_on_time,auto_off_time` | 类型/名称/单位/单分类/单品牌/标签/上下架已存在；轮播排序与素材选择、主条码/编码、视频开关/链接、定时上下架、多分类尚无；supplier旧源UI被注释（`:215-233`），可作为受控归属信息而非强行开放切换 |
| 2 规格库存 | `spec_type,items,attrs` | 已有模板生成、行价/成本/库存/条码/编码、卡密固定内容、次卡与退役/恢复；缺手工增删规格维度和值、生成接口接线、批量设置、重量/体积、供应商结算价展示；SKU行中的佣金/会员价与第5步共享；当前只展示维度标签（Form `:220-225`） |
| 3 商品详情 | `description` | 当前表单无详情字段/编辑器/预览；旧源 `:1153-1165` 为富文本+手机预览。新系统应直接编辑规范素材HTML，显示后端 sanitized signed preview，不把 preview 写回description |
| 4 物流设置 | `delivery_type,freight,postage,temp_id,is_postage,mer_use` | 当前没有物流字段UI；快递/自提、包邮/固定费用/模板必须补齐。后两项是兼容白名单项，旧主界面无显式活跃控件，需保留值并在明确适用时显示 |
| 5 营销设置 | `ficti,sort,give_integral,coupon_ids,label_id,is_vip_product,is_sub,is_limit,limit_type,limit_num,is_presale_product,presale_time,presale_day,is_good,activity,recommend_list,is_hot,is_benefit,is_best,is_new,recommend` | 当前仅sort、简化is_vip/vip_price可编辑。其余缺 UI；佣金取 `attrs[].brokerage/brokerage_two`，不是独立主字段；`recommend`是回显兼容列表，四个旧推荐开关在旧模板注释（`:1597-1606`），应保留现值而非默认为0覆盖 |
| 6 其他设置 | `keyword,store_info,command_word,recommend_image,ensure_id,specs,specs_id,is_support_refund,custom_form,system_form_id,tao_words,soure_link,type` | 关键词/简介/保障/模板值/退款已存在。缺口令、推荐图、模板外参数增删及名称排序状态编辑、自定义留言模板/快照；末三项属于导入/复制上下文，保留兼容但不占新系统UI主线；`type`必须固定为保存来源模式，与owner `productInfo.type`分离 |

### 表单验证应与后端同步

- 完整保存入站上限1MiB（Input `:9,101`），description最多512KiB文本（`:303`），SKU图片最长128字符（`:209`）；素材应使用短 canonical `/api/assets/:id` 引用。现有图片URL输入无限长，需在投影层统一处理。
- 实物配送必选；固定邮费必须>0；模板邮费必须有temp_id；卡密/手工虚拟后端强制无配送且邮费归零（Input `:288-297`）。次卡的配送方式2和单SKU不可被第4步误改。
- 会员价开启后各SKU不能为0；佣金开关关闭后后端写0（Input `:215-216,242-243`）。UI需提示后果，开关切换与SKU投影同步。
- 预售起止时间均须不早于保存时刻；后端按旧源语义不比较二者顺序（`:255-263`）。前端若增加结束晚于开始应明确为新UI校验，不声称旧后端已有。
- 用户标签、优惠券空数组目前**保留既有关系**，不是清空：Save `:176-189` 仅非空时替换。用户标签主表label_id亦按旧PHP遗漏语义保留（Input `:275-280`）。这是新UI“取消全部选择”的真实契约缺口：不能给可清空控件然后提示成功；需要独立显式清空语义/专门新接口，并在读DTO中回显关系type4而非仅旧主表labelId（Read `:182,192`）。
## 3. 可直接复用的 metadata / 素材能力

| 能力 | 当前路径/行 | 复用方式与边界 |
|---|---|---|
| 基础候选合集 | `view/admin-ts/src/api/product.ts:406` → GET `/product/editor/options`；`workers-ts/src/services/product/ProductAssociationService.ts:352-485` | 已有品牌、商品标签、用户标签、赠券、系统表单、邮费模板、保障、参数模板（带值）、SKU模板。当前Form已请求但未使用用户标签/赠券/表单/物流候选。各集合 `.limit(500)`（`:369`等）没有完整性标记；编辑时历史已选项须保留/单独回显；更大目录需分页搜索，不能误称候选全集 |
| 分类/品牌树 | `src/api/productCatalogFilters.ts:34-40` | 已封装 `/product/category/cascader_list/1`、`/product/brand/cascader_list/2`；分类为多选ID，品牌旧UI提交路径数组。可抽出复用，维持其1000节点/3层响应校验；完整GET另带cateList（层深可16），不要混成未经确认相同契约 |
| 供应商 | `src/api/productCatalogFilters.ts:61` | `/supplier/list`；旧供应商控件已注释，优先只显示真实owner再决定平台新建是否开放supplier选择 |
| 单位/保障/SKU规则/参数模板 | `src/api/productMetadata.ts:179,214,257,274,314,323` | 复用现有管理页 `/product/metadata` 与详情接口，不重复建设；当前单位只读100条（Form `:832`），大集合需搜索或分页 |
| 系统表单实际内容 | `src/api/systemForms.ts:170,188` | `/form/index`、`/form/info/:id` 返回value数组；options只有id/name，选择后需要detail才能创建custom_form快照，不能只保存id而把custom_form置空 |
| 素材列表/上传/分类 | `src/api/attachment.ts:41,53,87` | `/file/file`、`/file/upload`、`/file/category`；`AttachmentItem.canonical_url` 与signed `att_dir/satt_dir` 分离（`:6-20`）；保存canonical引用，展示预览URL。后端 `AttachmentService.ts:994-996` 明确这三项；可从现有文章选择素材交互抽组件（`pages/content/ArticleList.vue:536-555`），无需新增另一素材中心 |
| SKU旧生成 | 后端 `routes/adminapi.ts:308` → POST `/product/generate_attr/:id/:type` | 根任务正在验证的接口。新前端API尚未封装；请求 `{attrs:维度数组,product_type}`，响应 `{info:{attr,value,header,product_type}}`，value组合标识叫`values`（GenerateService `:93`）。返回未分配unique；现有SKU身份须从读DTO按suk合并，不能生成时抹去已有unique。mode1/2不是trusted copy（`:56-57`） |
| 赠券清空 | `AdminCrudController.ts:274-295`；`routes/adminapi.ts:358-359` | 已有 GET/PUT `/product/coupons/:id` 和原子replace。可复用接口能力，但将其在完整save后另发请求会失去整体原子性；需定义新UI保存契约或明确独立操作 |

视频缺口需准确标注：Admin只有图片上传路由（`routes/adminapi.ts:387-389`），旧源期待 `/file/video_upload`（旧index `:2351`）。现有分片视频服务已实现，但只接Supplier路由 `/file/video_upload`（`routes/supplierapi.ts:91`，`controllers/system/AttachmentController.ts:260-262`）；不能声称Admin上传视频已通。先可提供已审核外链输入；若要完整旧视频上传体验，需补Admin owner授权、上传API和UI。图片上传API不能直接上传视频。

描述渲染边界：完整GET返回byte-preserving规范 `productInfo.description`（Read `:211,239`）及清理后签名 `editor.description_preview`（`:241-253`），前者是编辑源、后者仅显示。保存仅规范素材引用并验证owner（Save `:54-72`），不是HTML导入转换服务。新部署不迁旧站真实数据，因此先做本地图文编辑与预览；只在实际接入外部导入时处理旧不受支持HTML/远端图片，不把导入当本轮六步主线阻塞。
## 4. 旧入口、权限与owner编辑限制

- 旧route `/admin/product/add_product/:id?`（旧 `router/modules/product.js:48-54`）尚无TS alias/redirect；TS只有 `/product/create` 和 `/product/edit/:id`（`src/router/index.ts:55-64`）。目前仅旧商品列表地址已有redirect（`:45-46`）。需补旧创建、`id=0`草稿、正整数编辑入口的严格映射，不能把字符串`"0"`当编辑：当前Form `:401` 只做truthy判断。
- 旧 `?copy=:sourceId` 会从来源GET，再以id0提交、清soure_link（旧index `:2790-2795,4011,4245-4248`）；旧 `?type=`打开采集弹窗（`:2880-2884`）。TS无这些入口处理。应先明确受支持复制入口；采集导入维持条件限制。
- 目前TS列表只在销售中/仓库中开放编辑（`ProductList.vue:299`，canMutateState），并且**卡密商品仅有库存入口，没有编辑按钮**（`:110-118`）。六步表单虽支持卡密，但列表用户进不去；需同时展示“编辑”和“卡密库存”，各自权限/状态限制保持清楚。
- 当前路由守卫只检登录（`router/index.ts:743-752`），ProductForm本身没有与列表相同的live auth/session/permission检查；列表已有会话绑定模式（`ProductList.vue:287-299`）可抽用。进入编辑后若账号变化、权限过期或读取失败，应禁保存/清旧敏感状态，避免默认空表单覆盖。
- owner应单独存为 `{type,relation_id}`。GET `productInfo.type` 为owner（0平台/1门店/2供应商），保存白名单`type`是导入/复制模式 -1/0/1（Input `:54-63,183-185`），二者不能Object.assign混用。旧源 `infoData`把relation_id设supplier_id（旧index `:3442`），但真实TS保存对已存在非平台owner强制保留（Input `:62`；`ProductAssociationService.ts:657-663`）；UI应显示readonly真实归属。
- 创建/既有平台商品可由非零supplier_id选供应商归属；后端验证supplier存在未删除（Save `:129-131`）。既有门店/供应商不能切owner，不应通过表单type或supplier_id假装迁移归属。保留product_type创建后不可改（Association `:618-627`）。
- 旧源供应商商品结算价列只读（旧index `:748-752,876-880,1048-1052`），ERP开启/卡密禁止直接编辑库存（`:775,904,1088`）。当前TS表单仅卡密库存禁改，尚未接ERP状态，供应商结算价也无展示（Form `:242-245`）。完整Input开启ERP时还强制主商品与全部SKU code非空（`:252-253`），因此需要读取ERP状态、说明编码要求、统一库存入口策略。
- metadata合集只提供平台候选（Association `:373-375,383-385,403-405,420-422,442-444`），完整保存支持平台或同owner的标签/模板/媒体（Save `:133-145,70-72`）。编辑非平台商品时需保留其既有专属已选项；若要切换同owner候选，需新增owner-aware查询，不能把平台候选当全部并在加载时清选项。

## 5. 草稿容量、静默截断与TTL：现状和必修

- 草稿接口：`GET/POST/DELETE /product/cache`，前端已封装（`src/api/product.ts:526-549`）。当前仅新建自动保存、1秒debounce（Form `:797-827`），挂载时直接恢复（`:881-884`），编辑无草稿。
- 当前请求和缓存文档均**512KiB**：`AdminLegacyContentController.ts:109`，`DatabaseCacheService.ts:6,30-31`。完整保存允许1MiB、完整GET productInfo允许768KiB（Read `:223-224`）；合法完整商品不一定能保存草稿，UI必须显式标注/返回容量不足，不能一律显示“已自动保存”。
- normalization会**静默截断**每个字符串到200,000 UTF-16 code units、数组到2000项、对象到256字段；嵌套深于8直接拒绝（`LegacyContentService.ts:16,192-207`）。description支持512KiB，所以200k字符截断会丢稿；slice也可能切断代理对。草稿保存接口会返回裁剪后的info，但当前Form `:801-802`不比较返回值，仍显示成功。
- TTL是**68,400秒=19小时**，每次保存续期（LegacyContent `:10,330-333`）；不是24小时。key仅`${adminId}_product_data`（`:222-226`），同账号多窗口/多草稿共享一个槽。GET没有保存时间、过期时间、版本；目前无法向UI解释“从哪个表单恢复/是否过期”，也无并发覆盖保护。
- 白名单覆盖59字段中的58项：`recommend`未列入（LegacyContent `:45-59`）；UI辅助的`sku_rule_id`、`write_times/write_valid/write_days/second_card_range`也不在其中。现有自动保存直接展开form，次卡新改的顶层核销值在下一次prepareSkuPayload之前尚未写入attrs，刷新可丢（Form `:654-676,744-752,801`）。完整编辑器草稿应从同一payload投影器派生（或独立versioned UI draft schema），不要复制一份字段维护逻辑。
- autosave缺请求顺序保护：debounce只取消未开始timer，不能阻止前一次请求晚于后一次落库；清稿/成功后delete也可能被已有in-flight save重新写回。下一步要串行或带单调revision、会话/表单快照绑定、失败/截断明确状态，保存成功后等待当前草稿写停止再删除；清稿应防后续旧请求恢复。
- 最小可实施顺序：先让草稿拒绝而不静默裁剪、对齐完整表单容量并报告上限；补版本/保存时间/到期元信息；再接六步统一draft encode/decode与恢复提示。若本轮保持单槽19h，也应明确显示而不承诺多商品草稿。
## 6. trusted copy 与未知保存结果恢复：真实缺口

### trusted copy

- Input已经接受**仅代码上下文**`localCopy:true`（Input `:30-35`），并清空固定卡密内容、unique、卡密库存、soure_link且不导入virtual_list（`:218-226,236-239,312`）；这只是底层能力。
- 当前HTTP Controller调用 `service.save(id,body,actor)` **没有传context**（`AdminLegacyProductSaveController.ts:22`）。保存也拒绝任何query（`:14`）。因此UI的`?copy`、body `type=1`、generate mode1/2均不能激活trusted copy；不应把复制支持打勾。
- 新建请求若保留`soure_link`，Save会按链接查找已存在商品并转为更新（Save `:89-96`）；因此普通表单复制后仅改id为0并不等于安全新建。默认新建/复制payload都应避免从owner DTO误抄导入上下文。
- 完成复制需要一个明确受权的服务入口：验证sourceId、读取来源和目的owner/素材权限、由后端构造`localCopy:true`，再调用完整Save；新UI仅提交复制来源与编辑结果，不从用户query/body信任localCopy。若本轮先交付普通创建/编辑，复制按钮应暂不开放并在Checklist标成独立缺口。

### 未知结果恢复

- 后端事务已完整回读、审计和持久outbox，服务结果有 `{id,committed:true,outboxId}`（Save `:214-246`）；提交后effects派发失败会记事件并仍成功（`:248-250`），不应前端误判保存失败再提交。
- 但旧兼容HTTP响应刻意只返回空数组和message（Controller `:23-25`），新建UI无法拿到新id。当前 `src/api/product.ts:413-425`预期的`{id,associations_verified,sku_verified}`是**另一简化端点契约**，不能用它包装完整POST。
- Controller只把已分类的回滚409/503变旧business error，其余unknown继续抛出（`:27-30`）；这是正确边界。当前Form catch一律“保存失败”，finally立即解锁重试（`:472-475`），没有unknown/pending状态、操作receipt、结果查询或防重复创建能力。
- 请求层已有 `AdminResponseError` 可识别business status（`src/utils/request.ts:19-22,40-53`），但超时/断网/中断/5xx不能据此证明未提交。UI必须在unknown时保留草稿和原payload并禁自动重放；已知编辑ID可以重新读取供人工核对，但只有GET相同字段不足以证明某次操作提交（并发覆盖/动态库存存在），不可把它标成可靠恢复。
- 完成恢复需要新TS专用完整save响应/route，保留旧route旧返回：发起前生成稳定operation key，后端在同一事务持久化操作者+key+payload摘要+最终productId+结果；相同key重放只返回原结果，摘要不同拒绝；提供当前session/权限下的状态查询并把“未开始/进行中/已提交/已明确拒绝/无法确认”与可重试策略分开。返回id/committed本身只能改善正常成功，并不能解决响应丢失。
- 既有`soure_link`查重不是通用幂等机制；不能为恢复临时伪造采集链接。现有audit/outbox可提供证据，但没有客户端key/查询契约，不能声称已具备客户端安全恢复。

## 7. 建议落地顺序与完成判据

1. **独立契约适配（首个可编码切片）**：新增 `view/admin-ts/src/api/productEditor.ts` 与 `src/pages/product/productEditorModel.ts`（建议路径）；定义59字段+嵌套GET/完整POST/generate响应，逐项投影；API保留旧response空数组事实。先验收普通实物单规格创建→完整GET→无改动保存、类目多选、轮播、`pic`、is_sub和日期。现有64KiB简化创建/更新端点（`AdminCrudController.ts:303,316`）不承载六步详情。
2. **六步壳与基础/规格**：保留当前SKU退役/恢复、卡密/次卡行为，补主图素材轮播、分类树、schedule、手动规格编辑、受限generate与批量设置；不能因替换表单丢失historical unique。创建/编辑/草稿用显式mode，支持旧route映射并给卡密编辑入口。
3. **详情/物流**：规范HTML编辑源+预览、素材插入、视频外链（上传独立缺口）、快递/自提/邮费模板及类型联动。description无导入内容时无需先修旧站迁移器。
4. **营销/其他**：补缺字段、用户标签/赠券/推荐商品选择、佣金与会员价、限购/预售、表单快照、参数行。先解决label/coupon“空即保留”及label读写差异，再宣称取消选择可用；不要用保存后独立请求伪装整体原子保存。
5. **保存与草稿可靠性**：上线完整写入口之前至少完成unknown防重放与明确状态；真正安全重试需要上节operation receipt协议。草稿去静默截断、容量一致、版本/时间、串行in-flight与成功清稿、次卡/完整59字段往返；只在明确success后清稿。
6. **可信复制单独完成**：普通六步UI可先完成；copy只在后端信任边界、目的owner和卡密清理协议全部具备后开放，采集type=-1维持“素材处理未接入”受控限制（Save `:123`）。

最终最小验收矩阵（后续实施时再运行，本次只读未跑）：

- 59字段投影/DTO往返，不漏默认和隐藏兼容值；单/多规格，既有unique保留，generate重排不把历史SKU变新SKU，退役/恢复功能保持。
- 实物、卡密固定/一次性库存、手工虚拟、次卡三种有效期；物流/预售/限购/会员佣金和参数/表单快照；已停用历史候选显示且不被静默清空。
- 旧入口含id缺省、id0、正整数、copy明确支持/未开放；跨账号/失权/加载失败不能保存旧数据；owner只读、ERP要求清楚。
- description、canonical媒体与preview分离；草稿超过字符串/总容量明确报错不截断，19h语义、并发窗口/在途保存/删除竞态、刷新恢复次卡字段。
- 超时发生在提交前/提交后、响应body畸形、outbox派发失败：不重复创建、不清未确认草稿，按operation receipt恢复最终ID。

## 本次审查状态

只读代码检查，未改仓库、未运行tsc/Vitest/Vite等重验证；已遵守 `/home/cina/cinagroup/AGENTS.md`。轻量脚本确认六步分组恰好覆盖59项白名单（59/59，无缺项/额外项）。报告证据按阶段增量落盘，路径行号对应审查时工作区，根任务仍在验证generate相关未提交改动，后续若改动行号需重新定位。
