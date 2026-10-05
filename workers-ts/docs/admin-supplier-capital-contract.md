# Admin 供应商资金流水合同

旧页 `/admin/supplier/capital/index` 使用 PHP `supplier/flowing_water/list`、`supplier/flowing_water/mark/:id` 与 `supplierWaterExport`。这是 `supplier_flowing_water` 的平台管理视角，不是平台 `capital_flow`、用户 `user_bill`，也不是供应商自用资金流水。旧菜单规则 1576 映射独立的 `supplier_capital.view`，备注写入要求 `supplier_capital.manage`；旧页资金流水、供应商账单、供应商提现各有独立权限。

两种 Admin 前缀均注册相同路径：`/adminapi/supplier/capital-screen/*` 和 `/api/admin/supplier/capital-screen/*`。响应遵循 `{status:200,data:...}`，成功读写均设置 `Cache-Control: private, no-store`。

| 方法与后缀 | 参数 | `data` |
| --- | --- | --- |
| GET `suppliers` | 无 | `[{id,supplier_name}]`；`is_del=0`，包含停用供应商 |
| GET `list` | `supplier_id?`, `data?`, `keyword?`, `page?=1`, `limit?=20` | `{list,count,page,limit}` |
| GET `export` | 同筛选条件，无分页 | `{filename,header,filekey,export,count}`；八列依次为交易单号、关联订单、交易时间、交易金额、收支、交易人、交易类型、支付方式 |
| PUT `remark/:id` | JSON `{remark,expected_remark}` | `{id,remark}` |

`list` 的行含 `id,supplier_id,supplier_name,order_id,link_id,trade_time,number,pm,uid,user_nickname,type_name,pay_type_name,remark,remark_editable`。仅排除流水 `is_del=1`，按流水 ID 倒序；全选包含孤儿及后来软删供应商的历史流水，供应商名称缺失显示空字符串。只有 `supplier_id` 缺失或空串代表全选，字面值 `0` 精确筛选 `supplier_id=0`；其它明确 ID 也直接过滤流水，不借选项表裁掉历史。已软删用户仍保留流水，昵称显示“游客”。关键词只匹配流水 `order_id` 或未软删用户的昵称／UID，`%`、`_` 当普通字符。交易时间为 `trade_time`，零值回退 `add_time`；上海时区显示。

`data` 是两个 `YYYY/MM/DD` 端点以连字符连接，也接受 `HH:mm:ss`；日期范围按 PHP ModelTrait 在上海时区解释、`add_time` 闭区间，结束端为午夜或与开始端相同时扩一天。最长 366 天。未知／重复参数、越界分页、非法日期均失败。`export` 和 `list` 使用同一筛选谓词与 ID 倒序，最多 5000 行且响应不超过 2 MiB，超限提示缩小条件。旧导出未分页，但旧前端误传 `date`、PHP 接 `data`，导致导出漏掉日期筛选；新导出修正此问题。可执行表格公式的文本单元格加单引号保护。

备注写入原列 `supplier_flowing_water.remark`，与供应商自用的 `mark` 严格区分。前端提交列表行原值 `expected_remark`；服务在事务中锁定未删除流水，值变化返回 HTTP 409，避免并发覆盖。新备注限 200 个 Unicode 字符且不可全空，最多 2 KiB JSON 请求；原备注不匹配、未知字段及超长内容拒绝。Worker 拆单会在同一 `remark` 列写入 `version=supplier-split-income-v1` 或 `supplier-refund-split-v1` 的机器血缘 JSON，只有这两种精确版本不可人工覆写，`remark_editable=false`。普通历史 JSON 文本可编辑。变更流水和仅记录操作者、目标 ID、长度的 `system_log` 同事务提交；日志不复制备注正文。
