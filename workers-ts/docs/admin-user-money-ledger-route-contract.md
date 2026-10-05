# Admin 资金记录旧屏合同（2026-09-28，本地候选）

旧 `/admin/finance/finance/bill` 的资金记录来自 PHP `UserMoneyServices::getMoneyList` → `UserMoneyDao` → `user_money`。此前新 `/finance/bill` 读取 `user_bill`，这是另一套积分等流水，不能仅因页面名称相近就认定已承接旧屏。本批保持原 `/bill/list` 的现有 API 语义，改造这一个 Admin 页面使用专属 `GET /finance/user-money-ledger`、`/types`、`/export`；三条接口均注册于 `/adminapi` 与 `/api/admin`。旧 PHP URL 不创建同名别名，因此旧路径精确覆盖分子不因本批增加。

列表按 `user_money.id` 倒序、每页 20 条，显示用户 ID、昵称、按 `pm` 标示的金额、类型标题、备注及上海创建时间。筛选包含昵称/ID 关键词、业务类型和创建时间范围。旧 `searchLikeAttr` 同时查账目 UID/标题与用户 UID/账号/昵称/电话；新服务使用相同字段集合，并把 SQL LIKE 的 `%`、`_`、反斜杠按字面匹配，以免搜索词改变匹配范围。旧 `getMoneyList` 传入 `not_category=['integral','exp','share']`，但该模型和数据库表都没有 `category` 字段或对应搜索器，实际不产生过滤；真正生效的是排除 `gain`、`system_sub`、`deduction`、`sign` 四个 `type`。新服务不向不存在的列加过滤。类型目录沿旧 `getMoneyType([])` 读取整个账本，包括列表排除的类型；旧 `GROUP BY type` 投 `title` 无确定行，新服务明确取该类型最新 ID 的标题。

旧页面与列表、类型两项 API 的数字规则分别为页面菜单 41、接口 312 和 311，均只映射 `bill.view`；旧导出接口 617 `export/userFinance` 仅映射独立 `bill.export`。页面查看和按钮还要求 `bill.view`，不能由平台 `capital_flow`、积分 `integral_log` 或旧 `/bill/list` 的命名替代授权。映射只读取精确的旧菜单路径、`uniqueAuth`、类型、启用状态及未删除状态，API 数字规则从旧方法/路径解析。导出接口本身只要求 `bill.export`，便于旧导出角色独立行权；页面上需要同时有查看权才能看到导出按钮。

旧 `ExportServices::userFinance` 六列为“会员ID、昵称、金额、类型、备注、创建时间”，导出键 `uid,nickname,pm,title,mark,add_time`；`pm=0` 时金额加负号。旧页面每次请求最多 1000 条，循环全量后在浏览器生成 XLSX。新接口返回同六列的逐页清单，以数据库 `REPEATABLE READ, READ ONLY` 快照对每页重算全筛选结果指纹、总行数及 CSV 字节数；后续页必须携带同一快照。浏览器全部取得并核对后生成带 BOM、公式单元格保护的 CSV，取消、数据变化、缺页或字节数不符时不下载部分文件。上限为 100000 行、16 MiB，单页最多 1000 行。CSV 可由 Excel 打开，但**文件格式与旧 XLSX 不同**。

旧 PHP `whereTime(..., 'between')` 在结束值恰为午夜时会自动延长一天；新页面分钟选择器转为上海秒区间并包含结束分钟 59 秒，不采用午夜隐式延长。旧导出类型和搜索词直接拼 `%...%`，新查询按字面匹配，因此包含通配符的历史搜索结果可能不同。对负源金额、NaN 和异常 `pm`，旧导出可能产生 `--10.00` 等歧义单元格；新服务拒绝整份导出，列表仍保留可审阅的历史值。空 `type` 记录可在“全部”列表中查看，但不作为具体类型选项。这些纠偏、类型标题选择、CSV 格式都需在实际运营数据上核对。该屏的本地候选状态不表示已完成受限角色浏览器、生产规模、查询计划、真实金额或发布后验收；Checklist 的开放项继续保持开放。
