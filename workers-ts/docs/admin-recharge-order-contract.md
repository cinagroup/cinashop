# 平台充值订单只读合同（首批）

旧后台 `/admin/finance/user_recharge/index` 使用 `user_recharge` 充值订单表；它包括未支付订单，不能由只记录入账的 `user_bill` 替代。旧列表经 `GET finance/recharge` 展示订单号、支付金额、用户、支付状态、充值类型、支付时间；按 `add_time` 时间段、`paid=0|1`、用户昵称/姓名/手机号/UID/订单号模糊查询，按 ID 倒序分页。旧统计 `GET finance/recharge/user_recharge` 不管列表支付筛选为何值，都强制 `paid=1`，返回充值本金总额、退款总额、小程序本金、公众号本金四项。旧页还提供充值退款、未支付记录删除和循环全页导出。

当前只读 Worker 路由同时注册在 `/adminapi` 与 `/api/admin`：

| 相对路径 | 结果 |
| --- | --- |
| `GET /finance/recharge-orders` | 充值订单分页列表 `{list,count,page,limit}`，包含未支付单 |
| `GET /finance/recharge-orders/stats` | `{sum_price,sum_refund_price,sum_routine_price,sum_weixin_price}`，金额为两位小数字符串 |
| `GET /finance/recharge-orders/:id` | 单条充值订单详情 |

三者均要求独立 `recharge_order.view`；财务流水 `bill.view`、充值档位 `recharge_quota.view`、普通订单或退款权限不能代替，菜单路径是 `/finance/recharges`。列表和统计可传 `page`（默认 1）、`limit`（默认 20，最多 100）、`paid=all|0|1`、`start_time`/`end_time`（成对的 `YYYY-MM-DD HH:mm`）和 `keyword`。时间按上海时区解释，过滤 `add_time`，终止分钟包含在内；起止时刻都须落在 int32 Unix 秒范围内，终止分钟的 exclusive 上界不超过 2147483648，展示区间最多 366 天；统计忽略 `paid` 并强制已支付。关键词至多 80 个 Unicode 字符，按用户 UID、充值订单号、关联用户昵称/姓名/手机号搜索，通配符按字面匹配。列表 `(page-1)*limit` 最多 10000，查询事务只读、快照一致并有 5 秒上限。无用户关联时仍展示充值单；搜索手机号/姓名需要有关联用户。

列表行仅返回 `id,uid,order_id,price,give_price,refund_price,paid,paid_type,recharge_type,recharge_type_label,add_time,pay_time,nickname,avatar,user_deleted,user_missing,issues`。金额是两位小数字符串，时间是 Unix 秒；正常 `paid` 为 0/1，历史坏值保留原数并标为“状态异常”，不伪装成待付款。用户文字字段缺失时为空串；头像只透传有效 http(s) URL 或站内单斜杠路径，反斜杠及其他格式变为空串。`issues` 标注孤儿用户、订单身份/状态/金额、支付或创建时间等可识别的历史异常。详情在相同行字段上追加 `trade_no,channel_type,store_id,staff_id,remarks,phone,real_name`，缺失文字为空串。接口设置 `private, no-store`，没有充值记录之外的余额、用户账本或支付提供方密钥投影。

本批没有退款、删除、导出接口。旧退款全额调用支付提供方，随后更新退款字段、扣除余额/赠送额并记账；Worker 的充值支付回调与对账已具备加锁、金额/交易号核验和原子入账，但没有相应的充值退款幂等协议。旧未付删除是物理删行，可能与已发起的支付意图及异步回调竞态。旧导出由浏览器循环全部页，缺少数据量、敏感字段及任务边界。上述能力需单独设计、验证和授权后才可迁移；因此旧页面迁移状态仍为 **partial**，上线/生产数据验收也未完成。
