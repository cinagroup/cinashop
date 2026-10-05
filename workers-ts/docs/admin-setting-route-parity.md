# Admin setting 旧路由逐屏代码审计

## 2026-09-28 客服话术续批

旧 `/admin/setting/store_service/speechcraft` 由独立 `/kefu/speechcraft` 承接，从 **partial → candidate**；设置76屏最新为 **19 candidate／23 partial／29 missing／5 retired**。平台 `kefu_id=0` 话术及 `owner_id=0,type=0,group=1` 分类的筛选、10条分页、详情、话术和分类增改删均有本地操作合同。独立 `speechcraft.view/manage` 不借客服会话权限，旧菜单路径与 `uniqueAuth` 成对映射查看权。删除分类保留历史话术 `cate_id`，页面标注已删除分类。双前缀服务/HTTP 的隔离 PostgreSQL16 **7/7**、前端 **6/6** 通过；生产数据和受限角色仍待验。

[设置日期版台账](../audit/admin-legacy-setting-route-parity-speechcraft-followup-20260928.json)叠加反馈续批，结合[本批合同](admin-speechcraft-user-point-route-contract.md)与[最新分布](checklist-route-contract-distribution-20260928.md)核对。全 Admin 最新为 **72候选／112部分／83缺失／7退役**，Checklist 仍 **246勾选／158开放／404总项**。下方保留前批当时口径。

## 2026-09-28 客服反馈续批

旧 `/admin/setting/store_service/feedback` 由独立 `/kefu/feedback` 本地承接，从 **partial → candidate**；设置76屏最新为 **18 candidate／24 partial／29 missing／5 retired**。页面恢复姓名/电话/内容搜索、状态与上海时间、15条分页、详情、处理备注和确认删除；匿名或原用户删除的记录仍可见。自定义日期沿用旧含结束日次日零点边界，已处理状态不能回退。`feedback.view/manage` 与客服会话 `service.view/manage` 分离，双 Admin 前缀的真实 HTTP 权限测试同时证实只读、管理及服务角色的正反边界。生产历史数据、受限账号实际页面、完整 CI 和发布验收仍开放。

本次[设置日期版逐屏台账](../audit/admin-legacy-setting-route-parity-feedback-followup-20260928.json)叠加前批核销订单结论，并与[本批合同](admin-lottery-feedback-route-contract.md)和[路由分布](../audit/route-distribution-lottery-feedback-followup-20260928.json)对应；默认设置台账及下方核销订单数字保持历史口径。全 Admin 最新为 **70候选／114部分／83缺失／7退役**，Checklist 仍 **246勾选／158开放／404总项**。

## 2026-09-28 核销订单只读续批

本批只更新旧 `/admin/setting/merchant/system_verify_order/index` 一屏：由 **missing → partial**，目标为新 `/operations/writeoff-orders`。setting 76 屏现在是 **17 candidate／25 partial／29 missing／5 retired**；按当前 11 份日期台账合并，旧 Admin 274 屏是 **59／117／91／7**。日期版 [逐屏台账](../audit/admin-legacy-setting-route-parity-writeoff-followup-20260928.json) 来自 [导航快照](../audit/admin-frontend-inventory-writeoff-followup-20260928.json)，并与[新路由分布](../audit/route-distribution-writeoff-followup-20260928.json)一同留痕；默认 [setting 历史快照](../audit/admin-legacy-setting-route-parity.json) 保持原字节。

旧路由的 `meta.auth` 是 `setting-merchant-system-verify-order`；旧 PHP 注册只读 `GET merchant/verify_order`、`GET merchant/verify/spread_info/:uid`，以及页面未调用、恒为空数组的 `GET merchant/verify_badge`。新 Worker 在 `/adminapi` 和 `/api/admin` 两个前缀下提供列表、专用门店选项、推荐人详情和静态 badge，统一要求独立 `writeoff_order.view`。新页面按当前 token、会话和权限门禁读取，切号、卸载及迟到响应不保留上个账号数据。

旧列表以 `StoreOrderDao` 的 `status=6` 搜索器筛 `paid=1、status=2、shipping_type=2、refund_status∈{0,3}、is_del=0`，不排 `is_system_del` 或 `pid`；按 `add_time DESC、pay_time DESC、id DESC`，旧页面默认 15 条一页。筛选有 `field_key=all/order_id/uid/real_name/user_phone/title`、查询词、门店与日期。`title` 查当前 `store_product.store_name|keyword`；`all` 还查订单、用户、地址、商品和秒杀／砍价／拼团活动字段。旧门店下拉只取营业且未删除门店。旧表格含订单号、昵称／UID、推荐人、商品快照、实付、核销员、门店、支付与订单状态和下单时间；订单号与下单时间可在当前页排序。新列表和页面承接这些主要只读操作，并对分页、搜索词、商品快照与响应字段加界限。

**日期口径必须按源码读**：旧页面标签叫“核销日期”，但 controller 把 `data` 别名为 `time`，模型时间搜索器默认作用于 `store_order.add_time`；旧 PHP 时区是 `Asia/Shanghai`。新页面明确写“订单创建时间”。旧自定义日期在 `yyyy/MM/dd-yyyy/MM/dd` 的结束日加一天后使用闭区间，会额外包含次日 `00:00:00`；新接口采用排他上界，故该秒被有意排除。

保持 **partial** 的另一项实质差异是：旧推荐人弹窗直接展示身份证 `card_id`，新受限详情有意不返回该敏感字段。新门店选项最多 500 条、列表偏移最多 10,000，旧接口无相同显式上限；需用生产规模确认是否触及边界。真实历史订单、受限角色浏览器、数据差异、生产性能和发布验收仍开放。本地代码分类不等于切流验收，`MIGRATION_CHECKLIST.md` 的总项分母没有随本屏改变。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-setting-frontend-parity-audit.ts --writeoff-followup` 可只读重生成日期版台账内容；加 `--write` 才写入日期版 JSON。`node node_modules/vitest/vitest.mjs run test/admin-setting-frontend-parity.test.ts test/admin-all-frontend-parity.test.ts` 本机 **2 文件 11/11** 通过，核验两份 setting 台账的字节重生成一致、唯一一屏状态变化和 11 份台账对 274 条旧业务路由的覆盖。核销合同另有原生 PG16 服务／HTTP **2 文件 10/10**、前端运行时 **5/5**、Admin `npm run build`（含 Vue 类型检查）通过；原生夹具清空，隔离集群已停止。接口细节见[核销订单只读合同](admin-writeoff-order-read-contract.md)。
