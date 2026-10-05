# 供应商订单统计独立屏幕合同（2026-09-28）

## 来源与边界

旧 Admin 页面为 `/admin/supplier/orderStatistics/index`，对应菜单 ID 1455、`uniqueAuth=admin-supplier-supplier_list`。ID 1439 的供应商列表复用同一个 uniqueAuth；权限迁移只按 1455 的精确 `menu_path` 映射到独立的 `supplier_order_statistics.view`。新页面 `/supplier/order-statistics` 不能借用供应商自用接口或通用统计权限。

来源：`cinashop-php/route/admin.php` 的 `/supplier/list` 和 `/supplier/home/{header,order,order_channel,order_type,supplier}` 共六个 GET、`app/controller/admin/v1/supplier/Common.php`、`app/services/order/supplier/SupplierOrderServices.php`、`app/services/supplier/SystemSupplierServices.php`、`app/dao/order/StoreOrderDao.php::getOrderStatistics`、`app/model/order/StoreOrder.php::searchPidAttr`、`crmeb/traits/ModelTrait.php::searchTimeAttr`、旧页面 `view/admin/src/pages/supplier/orderStatistics/index.vue`。仅页面请求合同迁移，旧图表图片保存由浏览器图表完成；没有 CSV 导出。

## Worker 路由与输入

以下六条 GET 同时挂在 `/adminapi` 与 `/api/admin`，均需 `supplier_order_statistics.view`。未注册旧 `supplier/home/*` PHP 别名，因为新屏使用独立、收紧的查询合同。

| 路由后缀 | `data` 字段 |
| --- | --- |
| `supplier/order-statistics-screen/suppliers` | `{list:[{id,supplierName}]}` |
| `supplier/order-statistics-screen/summary` | `{payPrice,payCount,refundPrice,refundCount}` |
| `supplier/order-statistics-screen/trend` | `{xAxis,series:[{name,type:'line',data}]}`，四条线 |
| `supplier/order-statistics-screen/channel` | `{items:[{key,name,value,percent}],totalCount}`，五渠道 |
| `supplier/order-statistics-screen/type` | `{items:[{key,name,value,percent}],totalPrice}`，九类型 |
| `supplier/order-statistics-screen/supplier-table` | `{list:[{id,supplierName,orderPrice,orderCount,refundOrderPrice,refundOrderCount}],count,page,limit}` |

`summary/trend/channel/type/supplier-table` 均要求 `time=YYYY/MM/DD-YYYY/MM/DD`，按上海自然日包含首尾，使用排他上界；1–366 天。可选 `supplier_id` 为空或 `0` 表示所有正数供应商 ID，正整数表示单家。`supplier-table` 另接受 `page`、`limit`，默认 1/20、最多 100 条/页、偏移最多 10000；供应商 ID 降序。`suppliers` 不接受参数，返回所有 `is_del=0` 的供应商，包含停用 `is_show=0`，按 ID 降序，最多 10000 条。未知或重复参数拒绝。

每条 GET 在自己的 PostgreSQL `REPEATABLE READ, READ ONLY` 事务内完成相关计数与列表查询，并限制数据库语句/锁/闲置事务时长。六个 HTTP 响应**不是**同一个跨请求快照。所有响应私有且 `no-store`。

## 各卡片独立口径

| 区块 | 订单 | 退款 |
| --- | --- | --- |
| 汇总 | `store_order`：`paid=1,is_system_del=0,refund_status=0`；旧逻辑未加 `pid`/`is_del` | `store_order_refund`：`refund_type=6`，合计 **`refund_price`**；旧逻辑未加 `is_del/is_cancel` |
| 趋势 | `store_order`：`paid=1,pid>=0,is_del=0,is_system_del=0,refund_status IN(0,3)` | **`store_order`**：`paid=1,pid>=0,is_del=0,is_system_del=0,refund_type=6`，合计订单的 **`refund_price`** |
| 来源 | `store_order`：`paid=1,pid>=0,is_channel=0..4`，按**订单数**；旧逻辑未加删除状态 | 无 |
| 类型 | `store_order`：`paid=1,pid>=0,type=0..8`，合计 **`pay_price`**；旧逻辑未加删除状态 | 无 |
| 供应商表 | 供应商 `is_del=0,is_show=1`；订单 `paid=1,pid>=0,is_del=0,is_system_del=0,refund_status IN(0,3)` | `store_order_refund`：`refund_type=6`，合计 **`refunded_price`**；旧逻辑未加退款行删除条件 |

所有聚合的日期字段是各自记录的 `add_time`。PHP 的 `pid=>0` 经 `StoreOrder::searchPidAttr(0)` 实际是 `pid>=0`，所以子订单计入、`pid=-1` 的拆分父单排除；汇总未应用该搜索器，可能仍包含父单。所有供应商范围含供应商 ID 正数的历史订单，即使其供应商行后来删除；但供应商表只展示当前可见供应商。

百分比按旧 `bcdiv(value,total,4)` 再乘 100 的截断规则（两位小数），来源与类型列表按值降序、同值按 key 升序。类型金额以精确十进制字符串返回；历史负值保留符号，因此混合正负金额的占比可能为负或超过 100，页面用支持负值的柱图表示，不将其当作饼图份额。旧类型图的 `bing_data` 有 9 类但 `bing_xdata` 删除了类型 4；新响应将 9 类标签对齐。

## 明确纠偏

- 旧页面初始化在设置近 30 天日期前已发请求；新页面先设置日期再请求。
- 旧供应商表忽略 `supplier_id`，分页控件未将页码交给请求；新接口对供应商筛选和服务端分页均生效。
- 旧 32–92 天趋势 x 轴每三天取一个**单日值**，遗漏其余天；新接口逐日展示完整自然日。一天按小时、2–92 天按日、超过 92 天按自然月。
- 旧 DAO 自定义范围的闭区间处理可能包含终点次日零点；新范围严格到终点日 23:59:59，以次日零点为排他上界。跨年日标签含年份，避免旧 `%m-%d` 重名合并。
