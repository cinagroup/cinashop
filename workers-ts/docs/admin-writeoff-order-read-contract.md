# 已核销订单只读合同（首批）

旧页 `/admin/setting/merchant/system_verify_order/index` 调用 PHP `SystemVerifyOrder::list()`，将 `data` 别名为 `time` 交给 `StoreOrderDao::search()`；日期实际筛 **`store_order.add_time` 下单时间**，旧 UI 的“核销日期”不是数据库筛选语义。固定 `status=6` 展开为 `paid=1 AND status=2 AND shipping_type=2 AND refund_status IN (0,3) AND is_del=0`。旧查询**不排** `is_system_del=1` 或拆单 `pid`；列表排序是 `add_time DESC,pay_time DESC,id DESC`，默认 15 条，`badge=[]`。旧状态文案仍可能把这些行显示为“已删除”或“部分退款”。

旧 `field_key=order_id/uid/real_name/user_phone` 走对应订单字段等值，`title` 通过 `store_order_cart_info.product_id` 搜索**当前** `store_product.store_name/keyword`，不搜索购买时的商品快照。`all` 是订单号/收件名/电话、当前用户昵称/UID/电话、用户地址收件名/UID/电话、当前商品名/关键字和秒杀/砍价/拼团活动名/说明的 OR 模糊搜索。目标 PG schema 的秒杀和拼团活动名称物理列是 `store_name`，旧 DAO 写作 `title`；Worker 以 `store_name` 映射该业务名称，砍价仍以 `title` 搜索。无日期时保留全量符合状态的订单，可能涉及较重的跨表 `EXISTS` 与 `COUNT`。

Worker 以独立 `writeoff_order.view` 保护下列 GET，双前缀 `/adminapi`、`/api/admin` 均注册。菜单路径 `/operations/writeoff-orders`。`store.view`、`order.view/manage` 或泛化 `user.view` 不授权本页。`/merchant/verify_badge` 是旧 PHP 恒返回 `[]` 的兼容路由；页面无需单独调用。

| 相对路径 | 响应数据 |
| --- | --- |
| `/merchant/verify_order` | `{list,count,page,limit,badge:[]}`；每行 `{id,order_id,uid,nickname,spread_nickname,pay_price,clerk_name,store_name,pay_type_name,status_name,add_time,pay_time,goods,issues}` |
| `/merchant/verify_order/stores` | `{list:[{id,name}]}`，只含 `is_del=0,is_show=1`，按 `add_time DESC,id DESC`；超过 500 个选项报错，不静默截断 |
| `/merchant/verify/spread_info/:uid` | `{spread:null\|{uid,nickname,avatar,now_money,brokerage_price,real_name,phone,integral,mark,birthday,last_time}}` |
| `/merchant/verify_badge` | `[]` |

`goods` 是购买时快照的 `{name,spec,image,true_price,cart_num}[]`，SKU 图优先于商品主图；原始 `cart_info` 不返回。无效 JSON、商品 ID/UID 不一致、超大快照和缺失商品只在该订单 `issues:string[]` 标记并省略损坏商品，不把原始数据透传。单页最多读 1000 条商品，单快照最多 64 KiB；超过总量报错。用户、门店或核销员孤儿引用保留订单并报告 `issues`。订单金额和商品单价为两位小数字符串；时间为 Unix 秒；状态文案为纯文本，前端应按文本渲染。

列表参数：`page` 默认 1，`limit` 默认 15、上限 50，`(page-1)*limit<=10000`；`real_name` 最多 80 Unicode 字符；`field_key` 仅 `all/order_id/uid/real_name/user_phone/title`，默认 `all`；`store_id` 是正整数（空或 0 表示全部）；`type` 可为 `0–8/105/106/107`，其中固定核销条件使 106、107 无结果。`data` 可为空、`today/yesterday/lately7/lately30/month/year` 或 `YYYY/MM/DD-YYYY/MM/DD`。未知/重复参数、无效日期或超过 366 个完整自然日的自定义区间报错。日期以亚洲上海解释；今天、昨天和自定义日使用起点包含、终点排除的完整自然日；本月/本年覆盖**整个**当前月/年；`lately7/30` 从当前秒滚动回推 7/30 天至当前秒。旧 PHP 自定义日的闭区间还会多纳入结束日次日 `00:00:00`，新合同有意规范化并排除该一秒。上述日期一律筛 `add_time`，与商品核销时间无关。

推荐人详情先在 repeatable-read、read-only 事务内验证请求 UID 至少有一条符合本页固定核销条件的订单，再以该买家的**当前** `spread_uid` 查推荐人；不存在或无推荐人返回 `spread:null`。接口仅返回旧弹窗所需的列，不返回旧 PHP 曾泄露的 `card_id`、密码、地址、银行或其他用户整行；头像仅允许 HTTP(S) 或安全的站内路径。所有接口使用 5 秒语句上限和 `private, no-store`。当前仍为 **partial**：旧 `card_id` 字段被有意移除，原始全字段订单/HTML 状态没有开放，生产规模下的 `EXPLAIN` 和真实数据验收尚未完成。没有新增核销写入、导出或退款操作。
