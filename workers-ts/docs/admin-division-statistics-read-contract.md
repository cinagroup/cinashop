# 旧事业部统计屏只读合同（2026-09-28）

旧屏 `/admin/agent/statistics` 独立承接为 `/division/statistics`，不复用 `/division` 管理页的统计口径。旧来源为 `cinashop-php/view/admin/src/pages/division/agent/statistics.vue`、`app/controller/admin/v1/agent/Division.php:322-363`、`app/services/agent/DivisionServices.php:712-894`、`app/dao/order/StoreOrderDao.php:1177` 和 `app/model/order/StoreOrder.php:786`。本合同及接口均为本地只读候选，尚未声明生产数据、真实角色或上线验收。

| 新 GET（两个前缀 `/adminapi`、`/api/admin`） | 查询 | 响应 | 权限 |
| --- | --- | --- | --- |
| `/agent/division/statistics-screen/summary` | 无 | `{divisionNum,agentNum,staffNum,orderNum,orderPrice,brokeragePrice}` | `division_statistics.view` |
| `/agent/division/statistics-screen/trend` | `time=YYYY/MM/DD-YYYY/MM/DD` | `{xAxis,series:[{name,type:'line',data}]}` | 同上 |
| `/agent/division/statistics-screen/ranking` | 无 | `{list:[{uid,nickname,spreadAgent,spreadStaff,orderNum,orderPrice,brokeragePrice}]}` | 同上 |

金额为两位小数字符串；趋势数值与订单数为数字。响应仅含列出的字段。六卡、排行与日期筛选无关。前端初始最近 30 天，快捷日期先转成明确起止日，仅趋势请求使用 `time`。查询参数白名单拒绝未知及重复键；汇总和排行不接受参数。三个接口均设 `private, no-store`，以只读、可重复读事务执行并限定语句/锁/空闲超时。旧的 `/agent/division/statistics`、`trend`、`ranking` 与 `/division` 管理页仍用原服务和权限，不被本批重定义。

## 旧数据口径

- 六卡的事业部人数是全局 `user.division_type=1`；代理商、员工分别是 `division_type=2/3`，受限管理员后两项按 `division_id` 限制。这三个计数均**不筛** `status` 或 `is_del`，但 `User` 模型的 SoftDelete 默认隐式排除 `delete_time` 非空用户。订单三卡是 `paid=1,pid>=0`（PHP 的 `searchPidAttr` 将严格整数 `pid=>0` 改写为 `pid>=0`，所以包含拆分子单），且 PHP `division_type=1` 搜索器实际为 `division_id>0 OR division_agent_id>0 OR division_staff_id>0`，不是 `store_order.division_type` 字段；受限时另筛当前 `division_id`。金额是支付毛额以及三类角色佣金之和，不扣后续退款。
- 趋势使用订单 `add_time` 的上海日期、`paid=1,pid>=0`，包括已付子单；全局须 `division_id>0`，受限按自身 `division_id`。一天显示 24 小时；2–31 天逐日；32–92 天图轴每隔 3 天展示**该日单点**，不累积三天；超过 92 天按月份分组，轴从起始日期按旧 `+1 month` 前进，月底溢出可能跳过一个月。序列顺序固定为“订单金额”“订单量”。
- 排行只列 `status=1,is_del=0,delete_time IS NULL` 的角色：平台是事业部，受限管理员是本事业部代理商。旧 `getUserList` 在页面未传 `page/limit` 时不分页，也未指定排序；新接口按 UID 稳定排序。`spread_agent` 和 `spread_staff` 均按 `user.division_id=行 uid` 计，分别要求 `division_type=2/3,status=1,is_del=0,delete_time IS NULL`，不改为 `agent_id`。订单三列始终用 `store_order.division_id=行 uid,pid>=0`（同一搜索器会包含拆分子单）；`orderNum` **包含未付单**，金额与佣金仅计已付单，且不额外筛 `division_type`。
- 这些订单统计链路没有通用的订单 `status`、`is_del`、`is_system_del` 或 `refund_status` 过滤；已删除或已退款订单只要满足上述 paid/pid/角色/日期条件，仍计在支付毛额和趋势中。

## 有意差异与待验收

- 旧趋势跨日 `BETWEEN` 将终止日的**次日 00:00:00** 包入；新接口用上海自然日半开区间排除该秒。单日/逐日图轴通常不显示该额外桶，但超过 92 天且结束日非月末时，旧月桶会多算该秒。原生 SQL 夹具验证新行为，旧行为留作差异。
- 旧代码只凭 `adminInfo.division_id==0` 判断全局。新接口仅 `level=0` 可全局读取；普通管理员未绑定事业部时拒绝。旧受限排行先列本事业部代理商，却再用代理商 UID 查 `division_id`，可能暴露另一事业部记录。新接口在下级与订单查询额外交集当前管理员的 `division_id`，既不偷偷改用 `division_agent_id`，也不允许跨范围读；因此一般受限代理商行的这些数字为零。这是有意收紧，旧屏保持 `partial`。
- 旧 PHP 可无界排行、无界日期；新接口排行超过 500 行显式拒绝，日期最多 366 个包含日。金额维持两位小数。真实历史数据规模与受限角色、生产计划及发布验收仍开放。
- 旧菜单 `agent-division-statistics` 的独立页面规则 1615 映射到 `division_statistics.view`；其他事业部管理菜单/权限不会隐式授予此能力。仅两个经核对的页面型旧规则（该屏和资金统计）被接受为只读能力。

验证源：`test/admin-division-statistics-read-postgres.test.ts` 覆盖六卡、父子单、未付排行、跨日及月桶取点、500 上限、受限范围；`test/admin-division-statistics-read-http.test.ts` 覆盖两前缀、独立权限、旧菜单映射、私有缓存与输入边界。原生 PostgreSQL 16 和前端可视验收需结合本批验收快照记录。
