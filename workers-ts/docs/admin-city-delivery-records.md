# 同城配送记录合同（2026-10-01，本地部分承接）

旧 `/admin/setting/city/delivery/record` 对应新 `/setting/city-delivery-records`。本批完成记录查询基础，整屏仅 **missing → partial**。原页的取消发单、费用确认、未知外部提交恢复及原订单回退继续开放。不会将已有配送回调/查单服务或本批 GET 当成完整履约迁移。

## 范围与来源

来源为旧 `view/admin/src/pages/setting/cityDelivery/record.vue`、`app/services/order/StoreDeliveryOrderServices.php` 及 `system_menus` 的 1491 行，auth 为 `setting-city-delivery-record`，父项 1489。相邻配置菜单 1490 使用不同 auth；十个旧配置键与 Workers Secret 的单一凭据来源仍需独立处理，配置屏保持 missing。本批不开放凭据编辑、发单、provider 强制刷新或取消按钮。

旧查询的未筛选 count、空关键词 searcher 和 add_time 格式遗漏不能照搬；旧取消把本地 status 写成 1，而 UI 期待 -1，不能据此把所有历史 1 解释为成功取消。0 是初始化记录，1 明确标记含义待核实；2/3/4/-1/9/10/100 保留待取货/配送中/已完成/已取消/物品返回中/返回完成/骑士到店。未知值显示代码并可筛选，查询不会修改历史数据。

## 接口及权限

同一三个 GET 注册于 `/adminapi` 和 `/api/admin` 两个 JWT 后台前缀：

| 后缀 | 返回 |
| --- | --- |
| `/city_delivery/records` | `items,total,page,limit`，每条发单尝试独立保留 |
| `/city_delivery/records/:id` | `record,metadata`，本地快照 |
| `/city_delivery/stores` | 有界门店选项分页，保留隐藏及删除标签 |

独立权限为 `city_delivery_record.view`，当前域无 manage。旧菜单仅在准确 path/auth、type=1、access=1、is_del=0 时映射查看；order、config、store 或 shipping_settings 均不代授。没有写路由；后续取消需显式的独立管理权限与持久协议。响应 `Cache-Control: private, no-store`。

记录筛选 `page` 默认 1，`limit` 默认 20、上限 100，offset 不超过 100000；`station_type` 仅 1/2，`status` 支持规范 signed int32，`store_id` 为正 int32 并只命中 type=1 门店。`date_from/date_to` 同时提供，Unix 秒 0..2147483647、包含起止秒。关键词去首尾空格、上限 100 Unicode 字符、拒绝控制字符；大小写不敏感 literal contains 匹配配送订单号、配送编号及可信原订单号，`%`、`_`、反斜线作为普通字符。重复及未知 query key 拒绝；详情不接收额外 query。门店选项采用独立关键词/page/limit，上限 50。

count 与 list 使用同一 REPEATABLE READ、READ ONLY 事务，排序 `add_time DESC,id DESC`。每个 GET 独立快照；statement/lock/idle transaction timeout 上限分别 5/2/5 秒，并保留更严格的已有配置。没有 provider I/O、补种、迁移或业务写入。

## 历史记录与投影

`store_delivery_order.type` 为平台 0、门店 1、供应商 2，`relation_id` 是多态关联。门店和供应商即使 ID 相同也不能混接；隐藏、已删除、空名、孤儿及未知 owner 均保留记录并诊断。多个 attempt 不聚合成一个订单。

可信原单要求 oid、正 uid 及 owner 一致。旧创建优先 store_id，再 supplier_id，再平台；`store_order.type` 是促销类型，不参与 owner 判断。不能可靠证明的原订单号保持 null，也不能从关键词搜索泄漏。当前 platform pickup 的 store_id 与历史发单履约门店并非同一证据，相关线索标记 `origin_owner_unverified`，保持遮罩。删除原单仍可在可信匹配时显示并注明删除。

距离保存单位为米，返回有限非负 meters 和十进制位移后的 km 文本。fee、deduct_fee、cargo_price 保持数据库十进制字符串，不经浮点四舍五入。NaN/Infinity/负值等无效历史值保持 null 与 `invalid_values` 原值，不能伪装为 0。add_time=0 表示未记录；负时间显示无效。界面显示时间及手动秒级范围采用 Asia/Shanghai，不随浏览器时区改变。

列表显式投影旧主要列、owner、可信原单、距离/费用及诊断。详情额外返回收件人姓名/电话、地址、城市代码、mer_id、备注及原因；仅供独立查看权限。核销/取货码 finish_code、坐标、私有银行/凭据字段、provider 原始 payload 及无界配送 timeline 不投影。mer_id 只是历史值，不构成可信发单账户绑定。

## 页面行为及验证边界

筛选草稿点击查询才生效，翻页与修改页大小沿已应用条件。读取失败保留上次数据及原查询说明，并明确过时；门店搜索单独分页、已选隐藏/删除门店跨页保留。本地详情与平台实时状态有明确区别。列表、详情和门店各自使用 AbortController、账号身份及 generation；撤权/换号清空数据，迟到响应不进入新账号。所有 select 显式禁用条件，避免覆盖 ElForm 的 disabled。

本批证据集中在 [验收记录](../audit/admin-city-delivery-records-acceptance-20261001.json)。本机 SQL/JWT/受限角色与合成 API 浏览器证据分别验证；不宣称生产 Hyperdrive、真实 provider、真机或发布通过。运行权限计划及 commissioning 保持原合同，仅证明既有 SELECT 交集可以运行查询。

最终审计 6 文件 40/40、独立权限目录定向 2/2（其余 22 项未选中）、前端 14/14 通过。Worker 单元与 runtime 两套类型检查、Admin 类型检查通过，最终 Vite 构建 22.00 秒。最终实际构建在 Chrome 合成 API 下通过 21/21 业务检查及 6/6 基础检查；桌面 1440×1000、手机 390×844。两个手机日期弹层稳定为 322×424、opacity=1，起止按钮均完整可见；部分日期不发 GET，完整 0/0 范围仍按实际 epoch 查询。账号切换、撤权、迟到响应、失败旧快照及隐藏/删除门店选择均有交互证明。最终加载 JS 摘要与 dist 一致，root 实际查看桌面、两个日期弹层及手机详情截图，Chrome 和 5277 预览均已关闭。前三轮浏览器尝试及两次失败类型检查日志保留，重复通过不累计；类型适配仅改变测试 Env 边界，运行值及断言保持相同。

本批另修复当前回调 UNKNOWN 覆盖已确认 watermark 的错误。修复前，9 项真实 SQL 回归全部失败：已取货 → UNKNOWN → 普通取消会把原单错误回退到 0，配送变为 -1 并追加取消日志；未知报文也会抹除终态或制造首次时间门槛。修复后 UNKNOWN 仅成为 durable IGNORED 事件/outbox，不创建或更新已确认 cursor；9 项 SQL 与原 14 项纯 provider/transition 合同全部通过。记录 3 文件 17 项全部通过，两组 5 文件共 40 项唯一用例（真实 SQL 20、纯输入/旧 provider 20），失败或重复尝试不累计。

记录使用 7 表现有 SELECT-only ACL 交集；回调验证 fixture 共 12 表，按既有计划仅给 7 个回调相关表所需 DML/列 UPDATE/序列 USAGE，其余仅 SELECT。实际独立 app/Admin LOGIN 无 schema CREATE。没有更改权限计划或数据库 DDL；本机建夹具属于隔离测试。此修复不重建已被旧代码降级的历史 watermark，旧部署审计只修正为 7 个已确认 subject、首次 UNKNOWN 无 cursor，仍保留 19 条断言/18 事件但本批未重跑该部署审计。

取消合同的已核实规范、复用方向及缺口见 [独立审查](admin-city-delivery-cancellation-contract-review-20261001.md)。需要冻结原 provider/账户/发单身份与原因/费用确认意图，提交前持久记录，未知结果先查询证据并禁止盲目重发，区分接受取消与最终取消/扣费，处理完成回调竞争，并原子恢复订单和记回执。上述动作尚未实现，不能降低整屏 partial 或勾选全局 Checklist。
