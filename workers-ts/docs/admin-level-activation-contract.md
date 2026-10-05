# 普通等级卡激活九键配置合同（2026-09-28）

旧 `/admin/user/setup_user` 的普通等级激活区现在由 Admin `/config/level-activation` 承接。旧页还包含基础资料定义、经验、价格展示与付费会员设置，所以整页仍是 **partial**；本页不写 `user_extend_info`、等级定义、SVIP 或既有用户账户。旧菜单 ID 1436 只映射 `user.view`，不会取得本域权限。

| 路由 | 权限 | 合同 |
| --- | --- | --- |
| `GET /adminapi/config/level-activation` | `config.view` | 同一只读 RR 快照返回九键原值、当前消费解释、缺键/损坏诊断、基础/已选资料、已选券和 revision；不补默认行、不读 KV。 |
| `GET /adminapi/config/level-activation/coupons` | `config.view` | 分页搜索可用于激活赠送的发行实例，含当前资格、使用期与面额元数据。已选失效券由主 GET 独立回显，不依赖选项页。 |
| `POST /adminapi/config/level-activation` | `config.manage` | 带完整九键、revision、UUID、资料引用及所选券 revision 一次保存；成功返回 committed/revision/request_id/cache_status。 |

三个端点也以相同操作、控制器与权限注册在 `/api/admin` 前缀。所有成功响应为 private/no-store。不能通过旧 `user.view`、`level.manage` 或 `coupon.view` 读写本域；读权限也不能保存。

九键是 `member_func_status`、`level_activate_status`、`level_extend_info`、`level_integral_status`、`level_give_integral`、`level_money_status`、`level_give_money`、`level_coupon_status`、`level_give_coupon`。全局配置按 `sort DESC,id DESC` 选择生效行，仅更新九键胜出行的 `value`；缺键受控插入。低优先重复行、门店行、元数据、基础资料定义和域外配置保持原样。严格 JSON 输入上限 64 KiB，拒绝重复解码键、未知键、非整数积分、非整元余额、失真资料映射和不完整的券版本证明。`level_extend_info` 生成后的完整 JSON 还须适应 `system_config.value` 5000 字符列宽；历史不能无损解析的字段以 `null` 和原值、诊断展示，须在界面明确修复，不能静默清空。

保存的首个业务锁是 `system_config SHARE ROW EXCLUSIVE`，随后校验含九键、生效行身份、基础资料源与本域审计 token 的 revision。所选券按 ID 升序锁定并复核：新增券必须当前可赠；三个总开关从非有效组合转为有效时全量复核。原有失效券可保持或移除，不阻止关闭赠券。资格与激活消费者一致：赠送发行、启用、未删除、有库存或不限量、完整领取窗口，以及正领后天数或 `day=0` 且固定使用结束不早于当前整秒；未来使用开始可预发，负 `day` 不可赠。保存本身不扣库存、不发券；实际激活在发行行锁后再次判断。

九键写入和简短 `system_log` 审计同事务提交。相同管理员、UUID、请求内容重放不再写库，可重试九键缓存失效；同 UUID 不同内容拒绝，其他 UUID 的旧 revision 拒绝。提交后九个 KV 删除均尝试；任一失败回 `cache_status=pending`，不把已提交写入谎称回滚。审计 token 使本域同值写与本域 ABA 也改变 revision；其他任意通用写入若把所有可观察原值及胜出行身份完全恢复，则无法由本域证明这次外部 ABA。

消费者保留旧六个标准资料列映射；自定义 radio 必须是服务端选项索引或原文，自定义 date 必须是真实日历日期，资料值只接受文本或有限数字。空 `param` 的自定义字段只能按自身 `info` 匹配，不能借用另一字段值通过必填。性别仍接受旧 0/1/2 索引并映射到用户列 1/2/0。激活赠券额外拒绝负 `day`，防止无效发行生成 owned/claim 记录。赠积分、整元余额、资料与券仍在同一激活事务内，晚失败整体回滚。

本批原生 PostgreSQL 16 已通过 **11 个业务集成 + 4 个双前缀 HTTP = 15 个新增场景**，另有 3 个完整相关回归文件 **111 项**。原生测试使用完整 176 步/281 表和独立受限 Admin/App LOGIN，覆盖实际激活、并发、UUID、审计晚失败、库存/时窗锁后重判及负天数；最终测试集群均确认清空夹具并停机。纯函数/前端运行时 3 文件 75 项、Worker unit/runtime 类型、Admin 生产构建和用户/订单路由台账 5 项通过。本机浏览器已用隔离的合成角色/API驱动生产构建，核对侧栏入口、资料与折扣券选择、保存确认、一次POST后GET读回和只读权限；此验证没有接触生产配置。首轮 HTTP 的角色名超过 `varchar(32)` 导致 4 个夹具失败，已修正并以完整 4 项绿文件替代；初次沙箱中本地 PG 启动受限，未进入测试。见[本批验收](../audit/level-activation-acceptance-20260928.json)、[路由分布](../audit/route-distribution-20260928.json)、[用户/订单逐屏](../audit/admin-legacy-user-order-route-parity-20260928.json)。生产配置和真实角色、Linux/设备、外部渠道与发布仍待验证。
