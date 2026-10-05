# Admin 满送：旧屏、路由与订单权益合同

2026-09-30。管理两屏、确认展示及普通订单权益消费者已接通；后续[公开整单售后](full-gift-refund-entry.md)接通严格未发货原单的客户/Admin退款。两旧屏由missing→partial，部分/拆单/已发货及退货验收仍有实质适配缺口，不标成整屏candidate；Checklist全局项目保持开放。

## 来源与路由

旧列表 `/admin/marketing/discount/give` 对应 `cinashop-php/view/admin/src/pages/marketing/fullDelivery/index.vue`，编辑 `/admin/marketing/discount/add_give/:id?` 对应 `addDelivery/index.vue`。PHP 源码实际位于相邻只读目录 `C:/cinagroup/cinashop-php`，审计中的 `cinashop-php/` 是来源标识。

新页面为 `/marketing/full-gifts`、`/marketing/full-gifts/create/:id?`。双 Admin 前缀 `/adminapi` 和 `/api/admin` 各提供以下 11 项 REST 合同：

| 方法 | 相对路径 | 权限 |
| --- | --- | --- |
| GET | `/marketing/full-gifts` | `full_gift.view` |
| GET | `/marketing/full-gifts/products` | `full_gift.view` |
| GET | `/marketing/full-gifts/coupons` | `full_gift.view` |
| GET | `/marketing/full-gifts/brands` | `full_gift.view` |
| GET | `/marketing/full-gifts/labels` | `full_gift.view` |
| GET | `/marketing/full-gifts/user-labels` | `full_gift.view` |
| GET | `/marketing/full-gifts/:id` | `full_gift.view` |
| POST | `/marketing/full-gifts` | `full_gift.manage` |
| PUT | `/marketing/full-gifts/:id` | `full_gift.manage` |
| PATCH | `/marketing/full-gifts/:id/status` | `full_gift.manage` |
| DELETE | `/marketing/full-gifts/:id` | `full_gift.manage` |

旧菜单 1395 只有 `marketing-discount-give` 与 `/admin/marketing/discount/give` 同时匹配才授予查看；1399 只有 `marketing-discount-add_give` 与 `/admin/marketing/discount/add_give` 配对才授予管理。相邻折扣、活动与优惠券权限不授予满送。新 REST 不额外计入旧 PHP 路径精确覆盖。

## 规则语义

固定平台根 `type=1/store_id=0/pid=0/promotions_type=4`。`threshold_type=1` 是金额门槛，按分币计算；2 是正整数件数。`promotions_cate=1` 是严格递增阶梯，取最高满足层一次，层之间不叠加；2 只保存一层，达标次数为参与金额或件数除门槛向下取整。

每层保存 `threshold`、非负整数 `give_integral`、券数组 `give_coupon_id:[{give_coupon_id,give_coupon_num}]` 和赠品数组 `give_product_id:[{give_product_id,unique,give_product_num}]`，至少启用一种赠送。`give_coupon_num/give_product_num` 是该层活动发放池总上限；赠品单次一件，循环时乘达标次数。循环积分也乘达标次数，优惠券仍按每个活动一份，不乘循环次数。这来自 PHP `getPromotionsGive`，不能把池上限误当单次赠送量。

适用范围是全部商品、具体父商品及 SKU、品牌或商品标签。旧“排除商品”与优惠叠加控件被注释，满送新增表单不提供这些未开放能力，也不提供第 N 件/限时折扣的每人限购。活动日期采用上海自然日；用户标签是购买后的关联效果。

金额达标不是原售价判断：PHP `getPromotionsProductInfo(..., isGive=true)` 从参与行价格减掉该行优惠券分摊金额。确认和建单必须绑定同一次优惠券选择与分摊结果；积分抵扣不得被误当此处的优惠券金额。商品件数门槛只统计参与购买行，赠品不再次触发满送。

## 活动池、下单与付款

PHP auxiliary `type=2` 是券池、3 是赠品池；`limit_num/surplus_num` 区分总上限与剩余可用量。同赠送身份修改上限时必须保留原 auxiliary ID 和已用/已预留量，不能重建池后从零恢复额度。移除规则的历史池仍需供未付订单取消归还，不得误删其他促销类型或门店派生规则。

赠品必须保留具体父商品与 SKU 身份、活动池和普通商品/SKU 库存证据。新建单应在拥有订单事务的锁内重新核对规则、券与库存；不足时失败回滚，不沿用 PHP 的静默漏发。赠品是零款实体行，优惠券、积分抵扣、邮费、商品赠积分和佣金不能分摊到赠品。

订单 `total_num` 包含赠品实体数量，与 PHP `StoreOrderCreateServices` 汇总合并后的全部 `cartInfo` 及现有财务拆单聚合一致；购买配额、门槛和积分计算另按购买行识别。仅为了实现满送而排除全局实体总数会破坏取消、拆单及退款数量证据。

付款后赠积分源事件为 `order_promotions_give_integral`，赠券必须保存发到哪个券实例的订单归属，付款后置任务重放不得重复发放。未付取消需要在同一事务归还其实际预留池和库存。普通商品支付后赠券表有商品 ID 与每单模板唯一合同，不应拿它替代满送的活动/层/池来源。

## 已实现的消费者与受控退款边界

管理端保存的规则进入真实购物车、确认和建单；金额门槛按参与购买行的券后金额判断，件数门槛排除赠品。确认分别返回购买行与赠品、赠券、积分；PC/UniApp 已显示三种奖励，建单输入只提交购买 cart ID。库存或发放池不足、确认后规则改变均拒绝并回滚。赠品使用与真实购买 cart ID 不冲突的正整数字符串，保留具体 SKU、零额商品行及物理总数量；短 char(8) SKU 去除数据库尾部填充。

未付取消在原购买来源证据之外，验证 0177 的赠品扩展证据并归还真实赠品库存和发放池一次；不修改旧 0164 固定安装合同。付款赠券使用 0176 的独立订单/活动/层/池/券实例归属表，积分使用独立源事件，重放不重复。赠品自身的商品付款赠券与普通商品积分不额外触发。0176 精确校验字段、约束、索引、序列及赠积分重放索引，拒绝 PUBLIC/列级额外授权；运行权限升级进一步拒绝未审第三角色授权。旧阶段授权及安装合同冻结，明确前推将固定锁函数升级为受检赠品 v2，使应用仅能更新活动池 surplus_num，管理端按新阶段授权维护规则。

完整原子退款只接受未发货、未拆分、已付的原始整单，要求购买行及赠品的全部数量、SKU、赠券实例及原赠积分凭据完全相符，最多100行。后续公开客户与Admin入口已按此窄范围选择持久v2，报价返回前执行与创建相同准入；全付款后置事件必须COMPLETED，固定退款/发票8组件及所需权限均需精确就绪。退款收回实际可用赠积分，记录原赠与实际收回值；按旧PHP保留已付赠券与标签，不回补已付发放池。普通非满送仍v1；更广义实体拆单未公开。部分数量/少退金额、拆单、已发货、退货验收与仅剩赠品仍未完成，因此两屏保持partial。

原 PHP 未提供已付赠券退款撤销合同，不能根据同一用户和模板猜测所有券实例并撤销；未付预留取消与已付权益处理必须区分。真实受限角色、生产统计对账、Linux CI、Hyperdrive、UniApp 原生类型/构建及发布后验收均仍开放。

## 分布和验证口径

当前 Worker 2060 条：公共 API 1071、Admin 714、供应商 164、客服 70、对外 41、ERP 0。旧 PHP 1904 条中精确匹配 903、可执行 882、受控不可用 21、退役 17、可行动 URL 缺口 984；新增 REST 不提高旧动态 URL 的精确覆盖。新 Admin 99 条业务页、540 调用点/564 请求变体均可执行。营销 48 屏为 31 候选/14 部分/3 缺失/0 退役；全 Admin 274 屏为 83/113/71/7；Checklist 保持 246 勾选/158 开放/404 总项。

管理/确认展示前批的类型、构建和桌面/390px合成API浏览器证据见[管理验收](../audit/admin-full-gift-acceptance-20260930.json)；最新客户/Admin整单售后、独立LOGIN与原生故障回归见[售后验收](../audit/admin-full-gift-refund-entry-acceptance-20260930.json)。售后增量未改前端、未重跑浏览器或前端构建。原生实例仅监听本机、夹具清零并停止；本机角色/模拟渠道与合成浏览器不代替生产验收。代码未提交、推送或部署。
