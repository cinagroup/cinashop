# 已发行优惠券本地合同

2026-09-27。本批发行列表与完整新建／复制表单已通过本机原生、实际最终dist浏览器及统一台账验收，为未发布的本地候选。原生业务38项来自22＋16两个完整文件批次，既有消费者7文件225项原生通过；输入／权限／钱包50项、前端47项、台账17文件95项分别计账，Worker两种类型与Admin类型／构建通过。首轮33通过／5失败及早期PGlite失败／跳过历史保留且不计接受数。见[原生证据](../audit/coupon-issue-native-20260927.json)、[浏览器证据](../audit/coupon-issue-browser-20260927.json)和[最终验收](../audit/coupon-issue-acceptance-20260927.json)。上一批优惠券模板的已接受记录保持原字节和历史口径。

旧源分析：[38个文件的合同与SHA](C:/Users/cina/.codex/visualizations/2026/09/26/01a0db11-74a0-7cc2-b1f9-ee3b8653056a/coupon-issue-contract-analysis-20260927.md)。主要源码是 `cinashop-php/view/admin/src/pages/marketing/storeCouponIssue/index.vue`、`create.vue`、`app/controller/admin/v1/marketing/coupon/StoreCouponIssue.php` 与对应服务、DAO。

## 操作归属

旧列表实际绑定新增、复制、开关、删除与领取记录。`create/:id` 从copy接口读取，提交不带原id且永远INSERT新发行；它不是原券的财务字段编辑。未绑定的动态 `edit/createForm` 只编辑状态，其拒绝 `-1` 的检查不代表实际列表开关：列表调用的直接status接口可以把未删除的 `-1` 发行改成0/1。

本页恢复完整新建与复制，复制可修改草稿后创建新id。已有通用 `/coupon/save` 的原位经济编辑作为已有兼容行为仍存在，继续依赖结算范围权威与原子关系写入；新页面不再提供该入口，也不声称发行财务定义在所有写入口都不可改变。

模板源与发行实例分开：`store_coupon_template_issue` 是不可变来源证明，`issue.cid` 单独不能证明归属。独立恢复发行不会恢复失效源模板，也不会更改proof。复制初始化新库存，`cid=0`，不继承proof、领取历史、自动赠券配置或来源渠道flags。

## 独立接口与权限

以下均在 `/adminapi` 与 `/api/admin` 注册。

| 方法与路径 | 合同 | 权限 |
| --- | --- | --- |
| GET `/marketing/coupon-issues` | 列表、同快照总数、过滤与分页 | `coupon.view` |
| GET `/marketing/coupon-issues/options` | 完整可选分类与品牌树、容量 | `coupon.view` |
| GET `/marketing/coupon-issues/products` | 商品最小投影与分页 | `coupon.view` |
| GET `/marketing/coupon-issues/:id` | 原发行详情、诊断、版本与proof | `coupon.view` |
| GET `/marketing/coupon-issues/:id/copy` | 无写入的完整复制草稿 | `coupon.view` |
| GET `/marketing/coupon-issues/:id/claims` | 按精确发行ID的领取历史 | **独立 `coupon_record.view`** |
| POST `/marketing/coupon-issues` | 直接新建或锁源版本后的复制新建 | `coupon.manage` |
| POST `/marketing/coupon-issues/:id/status` | 明确确认独立发行0/1状态 | `coupon.manage` |
| DELETE `/marketing/coupon-issues/:id` | 软删并停止后续领取 | `coupon.manage` |

本组manage包含本组view，不自动授予领取人数据权限。菜单/页面可见不能代替HTTP授权；旧PHP发行菜单回退只映射发行查看，不误授予模板管理。控制器从实际 `adminInfo` 取得actor，body中的uid/admin身份不参与授权。读取和写入响应均 `private, no-store`。

列表恢复优惠类型、领取方式、标题/精确ID和状态过滤，15条分页、最多100条、偏移最多10000，按id DESC。旧页面初始全部，因此页面显式发送空status；API未传status时仍按旧PHP控制器默认有效。全部与失效状态可核对历史。搜索 `%`、`_`、反斜杠按字面含义，不作为用户输入的SQL通配符。未知/重复查询字段拒绝。

## 完整发行定义

定义通过 `discount_type`、`scope_type` 区分折扣与适用范围，避免旧PHP的 `coupon_type/type` 与Worker列 `type/coupon_type` 恰好反转造成混淆。

- 优惠类型1满减、2折扣；金额采用精确decimal(12,2)字符串。折扣保存百分数，例如85代表8.5折。旧小数85.99沿现有PHP/Worker结算截为85%付款，不能在页面称为8.599折的实际结算。
- 适用范围0通用、1单品类、2商品集合、3单品牌。实际分类和品牌完整祖先可见、品牌属平台且未删、商品未删。最多100商品/500字符，排序去重由应用负责；全树超过5000项拒绝，不能截断后宣称完整。
- 普通新发行规范为category0，旧普通1复制明确规范为0；会员2保留会员身份。新表单不支持的appType受众不能被复制为公共券：读取给诊断，copy_input为null，POST复制也拒绝绕过。
- 使用期限选择领后1–3650天或有效固定UTC区间，领取窗口成对或均null；固定使用开始/结束不得分别早于领取开始/结束。接口时间为精确UTC，页面输入与显示为上海时间。
- 限量总量正整数，剩余初始化为总量；不限量总/余0，禁止有限总量0的两种消费者解释歧义。新人2必须不限量；旧复制隐藏的领取方式2/4可保留元数据，不能默改成普通手领。
- 标题1–64字符，确保实际已领券标题容量；规则为至多4096字符纯文本，开启0/1、非负排序。新发行每人限领1，不通过表单新增旧UI不存在的数量重置或财务原位更新。

本批九REST的写body最多16KiB，字段白名单严格。create的 `source_id=0/source_revision=null` 表示新建；复制使用正source_id与精确SHA版本，在同事务锁源、复核定义/范围/proof后新建独立发行。source_id不是要UPDATE的目标。旧 `/coupon/save/status/del` 兼容入口仍按现有权限和原位编辑合同工作，不把新REST的版本、UUID、期限与事务审计承诺扩大到所有既有Admin写入。

## 历史、领取和并发

普通领取弹窗按旧 `store_coupon_issue_user` 证据分页，保留重复、缺失用户及独立记录；会员category2按 `store_coupon_user`，不把两表以uid/issue连接而膨胀计数。普通表无稳定主键，row_key只是当前渲染标识，不承诺永久记录身份。头像预览限制为安全静态/HTTPS地址，不绕过私有R2访问。

六项读取在有界REPEATABLE READ READ ONLY事务内执行，count/list同快照。statement/lock/idle局部期限为5/2/5秒，并保留更严格的调用方期限。写入要求READ COMMITTED，actor+UUID事务锁、内容摘要、原子system_log回执与定义版本。版本包含影响定义的字段、完整关系指纹及proof，排除正常领取会变化的remain/领取历史/xmin，故领取不会无故破坏启停确认。

创建和启用在真实范围共享锁下复核，使用NOWAIT应对商品→发行与发行→商品反向等待；独立发行操作不持issue锁后等待template源锁。领取锁发行后计数、减量和发券，启停/删与领取按该行锁串行。

删除保留已领、预占、订单、来源证明、scope、赠券配置和计数，只设置 `is_del=1/status=-1`；未来消费方检查未删除/启用才继续发券。旧PHP删除两种商品关系会影响仍可用的已领券适用范围，这里保留当前Worker的历史保护修正，不宣称PHP逐字段删除同义。已领券金额、门槛和有效期来自owned快照，但折扣类型与范围仍读取发行及关系，因此不能声称整张券的所有字段都已永久冻结。

公开领取兼容普通category0/旧1，仍只允许receive_type1和app_type0；会员2、未知种类、隐藏赠送/新人/会员方式均不从公共手领取得授权。普通手领目录同时过滤库存、领取窗口和固定使用期结束时间，固定使用期已结束的历史券不能仅因领取窗口不限时就继续发券。PHP公开调用固定more=false，旧receive_limit0按一次解释，并检查存活领取证据与owned历史；已使用、过期、预占或丢失owned后的历史证据不能被视作新额度。既有显式正数限领扩展保持现行为。

未知写入保留原UUID、body和上下文，阻断后续新写，仅GET核对。人工确认只解除本地待核对状态，不证明原请求失败；后续新UUID可能重复创建，刷新/退出没有持久恢复队列。不能根据同名券判断服务器是否已成功，也不能自动重试非幂等新请求。

## 尚未关闭的合同

真实会员权益检查与发券、自动满赠/关注/新人配置、完整Linux、真实角色/配置/设备/provider及发布仍开放。现 `memberCoupons` 仅目录读取，不代表真实会员领取闭合。本批不新增schema/grants、不自动升级生产连接；实际最终dist166文件前后同字节，六种合成权限及六项读取重试只证明本地页面合同，真实JWT／受限LOGIN由原生HTTP单独核验，不能扩大为线上角色／渠道验收。
