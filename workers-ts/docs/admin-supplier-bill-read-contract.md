# 旧 Admin 供应商账单屏只读合同（2026-09-28）

旧 `/admin/supplier/bill/index` 与 `/admin/supplier/bill/index/:type?` 在新管理端由 `/supplier/bills` 与 `/supplier/bills?status=1`（或 `0/-1`）承接。核对来源为旧 `view/admin/src/pages/supplier/bill/index.vue`、`pages/supplier/components/commissionDetails.vue`、`app/controller/admin/v1/supplier/SupplierFlowingWater.php`、`app/dao/supplier/finance/SupplierFlowingWaterDao.php`、`app/model/supplier/finance/SupplierFlowingWater.php`、`app/services/supplier/finance/SupplierFlowingWaterServices.php`、`app/controller/admin/v1/other/export/ExportExcel.php` 和 `app/services/other/export/ExportServices.php`。通用 `/finance/bill` 与供应商账单是不同实体。

四个新 GET 在 `/adminapi`、`/api/admin` 均注册，统一要求独立 `supplier_bill.view`，设置 `private, no-store`。旧账单的三个精确 API 路径没有复刻：旧详情及导出依赖 `group_concat(id)` 形成的 `ids`，与以下按 `period` 重新计算的合同不兼容，不能仅靠注册同名路由宣称可执行迁移。

| 新 GET 相对路径 | 查询 | 响应 |
| --- | --- | --- |
| `/supplier/bill-screen/suppliers` | 无 | `[{id,supplier_name}]` |
| `/supplier/bill-screen/groups` | `timeType=day\|week\|month`、`data`、`supplier_id`、`status`、`page`、`limit` | `{list:[{id,period,day,title,add_time,income_num,exp_num,entry_num}],count,page,limit}` |
| `/supplier/bill-screen/details` | 分组所用 `timeType,period,data,supplier_id,status`，另可 `keyword,page,limit` | `{list:[{id,supplier_id,order_id,link_id,trade_time,number,pm,user_nickname,type_name,pay_type_name,remark,...}],count,page,limit}` |
| `/supplier/bill-screen/export` | 分组所用 `timeType,period,data,supplier_id,status` | `{filename,header,filekey,export,count}`，八列、完整分组、有界 JSON 清单，由前端生成 CSV |

`period` 是稳定分组键：日 `YYYY-MM-DD`，月 `YYYY-MM`，周 `YYYY-WW`（`WW` 可为 `00`）。周号严格对应 MySQL `%u` 的 Monday-first mode 1：首周须有当年四天，键的年份仍是 `%Y` 日历年；例如 2020-12-31 属 `2020-53`，2021-01-01 属 `2021-00`，详情用相同公式重算。`day` 与 `period` 相同，`add_time` 是由周期确定的稳定展示文案；旧查询从聚合组任取 `add_time`，特别在已结算模式会与实际 `finish_time` 周期错位。金额为两位小数字符串，`entry_num=income_num-exp_num`，支出可使净额为负。

默认 `status=''` 不筛状态，含 `0/1/-1`；显式状态仅接受这三个值。只有 `status=1` 以 `finish_time` 分组和倒序；其他状态及默认全状态均以 `add_time` 分组。无论状态，`data` 始终按流水 `add_time` 筛选。`data` 可空，或采用上海时间 `YYYY/MM/DD-YYYY/MM/DD` 的完整范围格式 `起点-终点`，每端也可带 `HH:mm:ss`；SQL `BETWEEN` 双端包含。终点恰在零点、或起止完全同秒时，旧 ModelTrait 将终点再加 86400 秒，此处保留。显式选择的起止点最多相距 366 天；未选日期允许查询全历史。列表每页默认 15、最多 100，详情默认 10、最多 100，页码和组数亦有限制；未知或重复查询参数拒绝。

账单的唯一排除条件是 `supplier_flowing_water.is_del=0`，不通过供应商表过滤。因此全部供应商视图仍计入后来软删的供应商及孤儿历史流水；选项只列 `system_supplier.is_del=0`，包含停用供应商。明确选中某供应商时校验供应商 ID 存在，允许软删供应商历史；`supplier_id=0` 等同全选。详情按周期、状态、原日期范围及供应商重新过滤，再按流水 ID 倒序，避免旧 `GROUP_CONCAT` 的长度截断和不稳定 ID 串。主列表全选时详情可再细分供应商；主列表已选择供应商时前端锁定相同 ID，后端对每次请求的供应商条件独立校验。`trade_time=0` 回退 `add_time`，用户昵称缺失或软删除显示“游客”；付款方式与交易类型文案沿旧映射。

旧导出没有传 page/limit，故并非只导当前页，而是导出传入 `ids` 的全量；其控制器却忽略 `supplier_id`，而 `GROUP_CONCAT` 可能截断 ID 串。新导出在服务端用完整分组条件重算，单组超过 5000 行或响应超过 2 MiB 明确失败。清单与旧 `SupplierFinanceRecord` 的八列相同，名称、订单号等字符串对 CSV/Excel 公式起始字符加前置单引号，避免导出时执行公式。新关键词将 `%`、`_` 视为普通文字并用不区分英文大小写的搜索；为了避免软删个人信息再暴露，不按已软删用户昵称或 UID 命中。旧 DAO 的原始 `user` 子查询未自动应用软删除过滤，因此这是有意收紧，而显示层原本就会将软删用户显示成“游客”。

旧页面型规则 `admin-supplier-bill-index` 仅在菜单路径为 `/admin/supplier/bill/index` 时映射到 `supplier_bill.view`；其他供应商管理、供应商提现和通用财务账单权限不会隐式授予此能力。服务端以可重复读只读事务取得同一次请求的分组总数、明细或导出，并限定语句、锁及空闲事务超时。本地数据库与 HTTP 夹具验证以上口径；真实历史规模、菜单角色与生产发布仍待独立验收。
