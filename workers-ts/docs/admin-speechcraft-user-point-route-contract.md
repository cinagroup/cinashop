# 客服话术与积分日志导出合同（2026-09-28，本地候选）

本批针对旧 Admin `/admin/setting/store_service/speechcraft` 和 `/admin/marketing/user_point/index` 的剩余操作，不把新 URL 数量当作旧 URL 的精确迁移。代码尚未发布；真实受限角色、生产数据和规模仍待验收。

## 客服话术

旧页管理平台公共话术和分类。新 `/kefu/speechcraft` 保留分类侧栏、全部/未分类、每页 10 条、排序、话术列表及详情、话术和分类的新增/编辑/删除，并增加标题搜索与内容精确匹配。数据固定为 `store_service_speechcraft.kefu_id=0`；分类固定为 `category.owner_id=0,type=0,group=1`。个人客服话术和其它分类组不在 Admin 响应或写入范围。字段保留 `cate_id`、可空标题（100 字符）、必填内容（255 字符）和非负排序。

双 Admin 前缀保留既有话术 GET/POST/PUT/DELETE 与分类 GET，新注册分类 POST `/wechat/speechcraft/categories`、PUT/DELETE `/wechat/speechcraft/categories/:id`。这些新 REST 路径没有冒充旧 PHP 的 `/app/wechat/speechcraftcate`。读写分别要求 `speechcraft.view` 与 `speechcraft.manage`；`service.view/manage` 不代授。旧页面菜单只在 `uniqueAuth=admin-setting-store_service-speechcraft` 且路径完全相同时映射查看权限。页面切号或失权后丢弃迟到结果。

旧 PHP 删除分类时会留下话术原 `cate_id`。新平台分类删除保留这个历史关联，页面“全部”中标记“已删除分类 #ID”；编辑既有孤儿话术时可保持原分类，也可改到现有分类，新增话术不能选已删除分类。分类写入按平台 owner 串行化，重复名称、跨 owner/type/group 和越权话术操作被拒绝。

## 积分日志导出

新 `/marketing/user-point` 已有旧日志七列、筛选、统计与 15 条分页；本批新增 GET `/marketing/user-point/export`（双 Admin 前缀）。它使用与列表相同的积分分类、用户/标题关键词、类型和上海时间范围口径，返回旧导出七列 `header/filekey/export` 的逐页 JSON 清单。旧导出服务按每页 1000 条循环直到空页；新导出也按每页最多 1000 条取得全部筛选结果，并设总计 100000 条及 16 MiB 上限，超限明确要求缩小筛选。浏览器在全部页校验通过后生成带 BOM 的 CSV，Excel 可打开；**CSV 与旧 XLSX 文件格式不同**。

每页在 PostgreSQL `REPEATABLE READ, READ ONLY` 事务内计数、计算全筛选结果指纹和预计 CSV 字节数，再取得该页。后续页必须传 64 位快照；筛选、积分流水或用户昵称等显示数据变化时拒绝续页，浏览器不会下载部分结果。导出按钮同时要求 `integral_log.view` 和独立的 `integral_log.export`；接口本身要求导出权限。旧 type-2 `export-userPoint` 数字菜单按其 `GET export/userPoint` 精确解析为导出权限，不开放旧 Excel URL 作为兼容别名。文本单元格防表格公式执行，并保留引号与换行。

导出每页都重算全量指纹；生产历史数据量、查询计划和超时需再核验。CSV 格式与旧 XLSX 不等价，后续如需 XLSX 交付须另立有界生成合同。两屏成为本地迁移候选不表示生产验收；Checklist 的外部提供商、真实角色浏览器、发布后回归等开放项保持开放。
