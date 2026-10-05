# 平台佣金记录只读合同（首批）

旧 `/admin/finance/finance/commission` 的七列表格来自 `UserUserBrokerageDao`：该 DAO 以 `user u` 为主表，`LEFT JOIN user_brokerage b ON u.uid=b.uid`，再按 `u.uid` 分组；它不是独立的 `user_user_brokerage` 物理表。无日期筛选时，**没有佣金流水的用户也在表格中**。旧“昵称/ID”搜索覆盖 `u.account/u.nickname/u.uid/u.phone`，佣金区间筛的是用户**当前** `u.brokerage_price`，日期筛的是 `b.add_time` 是否落在区间，并不会将余额、提现额或“总佣金金额”重算成该时段。旧表格的六个数据列是昵称/手机号/UID、总佣金金额、账户余额、账户佣金、提现到账佣金、时间，第七列是详情操作。

旧 `extract_price` 是 `user_extract` 中 `status IN (0,1)` 的 `SUM(extract_price)+SUM(extract_fee)`，包含待审核申请及手续费，旧“提现到账佣金”列名并不准确。旧 `sum_number` 是这个全时段 `extract_price` 加上当前 `user.brokerage_price`；旧文件中按 `income-pay` 计算的代码已被注释。旧 MySQL `GROUP BY u.uid` 同时直接取 `b.add_time`，该时间值不确定；新接口以**匹配该筛选的最后一条佣金流水时间**（`MAX(b.add_time)`）给出确定值，无流水为 0。列表按匹配佣金流水最大 ID 倒序、同值按 UID 倒序。

旧详情头按 UID 读取用户（包括软删用户）、上级推广人昵称、当前余额，并计算 `number=max(四类 self_brokerage/one_brokerage/two_brokerage/brokerage_user 流水金额总和 - refund 流水金额总和, 0)`；这里的求和**不筛 pm 或 status**，因此不同于列表 `sum_number`。旧弹窗 `extract_list/:uid` 虽名为 extract，实际读取该用户**全部 `user_brokerage` 流水**，按 ID 倒序、默认 20 条；`pm=0` 的 number 仍按原正数显示，日期按流水 `add_time` 过滤。

Worker 将以下 GET 注册到 `/adminapi` 和 `/api/admin` 双前缀，均要求独立 `commission.view`；`distribution.view` 的 `/brokerage/list` 是单条流水目录，不能代替本页。菜单路径为 `/finance/commissions`。

| 相对路径 | 响应 |
| --- | --- |
| `/finance/commissions` | `{list,count,page,limit}`；行 `{uid,nickname,phone,display_name,now_money,brokerage_price,extract_price,sum_number,time,user_deleted,issues}` |
| `/finance/commissions/:uid` | `{uid,nickname,spread_name,number,now_money,brokerage_price,add_time,user_deleted,issues}` |
| `/finance/commissions/:uid/records` | `{list,count,page,limit}`；行 `{id,number,add_time,mark,pm,type,status,issues}` |

金额均为两位小数字符串，时间为 Unix 秒；`display_name` 拼接旧页的 `nickname|phone|uid`，缺失文字为空串。列表参数 `page`（默认 1，最多 1000）、`limit`（默认 20，最多 100）、`keyword`（最多 80 个 Unicode 字符）、`price_min`/`price_max`（可单独填写、非负、最多 10 位整数和 2 位小数）、成对的 `start_time`/`end_time`（上海时间 `YYYY-MM-DD HH:mm`）。明细参数只有同样分页和成对的时间，可用 `YYYY-MM-DD` 日或分钟精度，起止须同精度。所有查询 `(page-1)*limit<=10000`、日期展示区间至多 366 天，Unix 秒须可由 int32 表示，终止单位的 exclusive 上界不得超过 2147483648；未知或重复参数报错。数据库事务为 repeatable-read/read-only，并有 5 秒语句上限；响应 `private, no-store`。

日期端点是有意规范化的旧合同差异。旧列表 `UserUserBrokerageDao` 采用闭区间 `whereBetween`：同一分钟起止会把结束点加 86400 秒，纳入随后 24 小时；不同分钟只纳入结束分钟的首秒（如 `10:00–10:05` 到 `10:05:00`），不含 `10:05:01–10:05:59`。新列表统一包含完整结束分钟，以下一分钟零点为排他上界。旧明细经 `ModelTrait::searchTimeAttr` 对结束日加 86400 秒后仍用闭区间，因此额外纳入次日 `00:00:00`；新明细到次日零点排他。对账时终点附近的 UID、行数可能不同，金额汇总本身仍为旧全时段/当前口径。

旧导出与列表不同：PHP 导出接口每次取 1000 条，旧 Vue 从第一页循环至空页，六列依次是 `nickname/sum_number/now_money/brokerage_price/extract_price/time`。本批**没有导出接口，也没有任何写入接口**；后续导出需要独立权限、固定总量/异步边界、快照与 CSV 公式防护。大体量空日期查询保留旧全用户口径，`LEFT JOIN` 分组和全量计数可能触发 5 秒截止；上线前须在真实体量下做 `EXPLAIN` 与容量验证。本页当前为 **partial**，不宣称生产数据验收或旧导出等价。
