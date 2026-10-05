# 活动边框旧屏与前台消费合同（2026-09-30，本地候选）

旧 PHP 两个业务屏 `/admin/marketing/activity_frame`、`/admin/marketing/activity_frame/create/:id?` 原先均为 `missing`。新 Admin 用独立的 `/marketing/activity-frame` 列表及 `/marketing/activity-frame/create/:id?` 编辑页承接。此处的 `candidate` 仅表示本地代码和合同具备审阅条件，不代表旧动态 URL 精确兼容或发布验收。

旧列表读取 `store_promotions` 中 `promotions_type=5,type=1,store_id=0,pid=0,is_del=0` 的平台根活动，默认15条；`status` 是未开始/进行中/已结束的阶段筛选，开关状态是另一字段。新列表保留名称或 ID、阶段、活动时间重叠、创建时间、商品数、启停、删除和排序。新增与编辑恢复名称、图、上海时间、排序、开关及全商品/指定商品/品牌/标签范围。新表单还提供排除商品范围（type3）；旧 UI 未提供该选项，旧边框服务写辅助关系时未置 `is_all=1`，旧公共匹配因此可能不真正排除。新服务显式写入排除语义并按可展示且审核通过的商品扣除排除集合计数；旧服务对 type3 商品数固定显示0，故此处不追求错误行为等价。

商品选项、选中校验和参与数统一只计 `pid=0` 的上架、未删、审核通过父商品。旧 PHP 商品选择器同样限定父商品；公共边框消费把子商品归到父商品 ID，因此后台不能把子商品 ID 保存为指定或排除范围，避免保存成功却无法在前台命中。

双 Admin 前缀分别注册如下独立接口；`/api/admin` 与 `/adminapi` 行为及权限一致：

| 方法 | 相对路径 | 合同 |
| --- | --- | --- |
| GET | `/marketing/activity-frame` | 15条默认分页与同快照总数 |
| GET | `/marketing/activity-frame/:id` | 完整详情、范围身份和材料 `revision` |
| GET | `/marketing/activity-frame/products`、`/brands`、`/labels` | 搜索及分页选项 |
| POST | `/marketing/activity-frame` | 创建 type5 平台活动 |
| PUT | `/marketing/activity-frame/:id` | 原位编辑，不重建活动 ID |
| PATCH | `/marketing/activity-frame/:id/status` | 启停 |
| DELETE | `/marketing/activity-frame/:id` | 软删除 |

`activity_frame.view/manage` 与宽泛 `activity` 权限隔离。旧数字菜单 1541 仅精确映射 `admin-marketing-activity_frame` 和对应列表路径的查看权；1543 精确映射 `marketing-activity_frame-create` 和创建页路径的管理权，错误 `uniqueAuth` 或路径不被转换。旧 PHP `GET set_status` 是写操作，权限推断仍要求 `activity_frame.manage`。新写操作使用独立 HTTP 动词、UUID `request_id` 和详情 `revision`；重复请求仅在同管理员、同操作、同目标及同载荷时复用结果，陈旧版本拒绝。根类型约束同时应用于详情与写入，避免活动边框接口改到背景或其它促销。前端未知写入结果只重新读取核对，不自动重放写请求；会话切换取消并丢弃迟到响应。

前台消费与 Admin 写入是同一 `store_promotions` 数据。旧 PHP 在普通商品列表及推荐中把生效的 type5 映射到 `activity_frame: {id,name,image}`；新普通列表和推荐同样附 `promotions`、`activity_frame`、`activity_background` 三槽，支持促销、边框、背景同时命中。`GET /api/product/detail/activity/:id` 默认类型由商品详情 DIY `showService` 决定：含0时 `[1,2,3,4,6]`，否则 `[6]`；显式 `promotions_type=5` 在两种配置下都查边框，并按旧接口形状放入 `promotions` 数组，不新增 `activity_frame` 顶层字段。

旧 PHP 列表、保存和消费实现分别见 `cinashop-php/app/controller/admin/v1/marketing/activityFrame/ActivityFrame.php`、`cinashop-php/app/services/activity/promotions/StorePromotionsServices.php`、`cinashop-php/app/services/product/product/StoreProductServices.php` 和 `cinashop-php/app/controller/api/v1/product/StoreProduct.php`；旧路由快照已固定在仓库台账。实现证据见 `AdminActivityFrameService`、双路由、`ActivityFrameList.vue`、`ActivityFrameForm.vue`、`StoreProductService` 与 `PublicCatalogService`。日期版营销逐屏台账单独记录两屏由 missing 升为本地 candidate；原始基线台账保持历史字节。

仍需真实受限角色、历史活动/商品规模、生产媒体引用、商品卡片实际渲染与发布后流程验收。旧 PHP 动态表单 URL 没有注册兼容别名，不能将两个新屏算作旧 URL 精确匹配。完整 Checklist 和 FE-001D 仍开放。
