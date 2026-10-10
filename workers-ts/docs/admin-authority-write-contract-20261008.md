# Admin 权限写入事务合同（2026-10-08，本地验证完成）

本批为既有 Admin 写入口补共同事务屏障、实时身份复核、角色引用保护和真实写入结果核对。它没有新增路由，不计旧路由缺口下降，也不关闭整个角色管理、管理员管理、旧客户端或发布工作流。本批实际完成 151 项唯一测试、两套完整 Worker 类型检查及两个原审计 CLI；原失败、源码绑定和停机记录见[独立验证清单](../audit/admin-authority-write-validation-20261008.json)。未公开推送、执行新提交 CI 或部署，不引用前批成功日志作为本批验收。

## 覆盖的既有入口

下表路径均已有 `/adminapi` 与 `/api/admin` 两个前缀；别名共用 handler，不能重复计算为新增业务缺口覆盖。

| 写入口 | 当前能力与事务边界 |
| --- | --- |
| `POST system_admin/save` | 现代平台管理员创建与编辑；`system.manage`；使用 `AdminAuthorityWriteService.saveAdmin`。 |
| `POST system_role/save` | 现代平台角色创建与编辑；`system.manage`；使用同服务的 `saveRole`。 |
| `DELETE system_role/del/:id` | 现代平台角色软删除；`system.manage`；使用同服务的 `deleteRole`。 |
| `POST setting/role/:id` | 已有旧角色表单保存；保留 `system.legacy_role_manage` 及既有单向兼容规则、下一层级和真实数字菜单合同，接入共同写事务。 |
| `POST agent/division/save` | 事业部角色与其平台管理员写入；保留 `division.manage`，接入共同写事务。 |
| `POST agent/division_agent/save`、`POST agent/division_staff/save` | 代理商、员工层级写入；保留 `division.manage` 和原层级规则，事务内复核当前事业部范围。 |
| `DELETE agent/division/del/:uid` | 事业部层级删除及其平台账号组的停用、软删除；保留原删除范围限制，接入共同写事务。 |

实际实现入口为 [共同服务](../src/services/admin/AdminAuthorityWriteService.ts)、[现代 handler](../src/controllers/api/v1/AdminCrudController.ts)、[旧 POST 服务](../src/services/admin/AdminLegacyRoleWorkflowService.ts)、[Division 服务](../src/services/division/DivisionManagementService.ts)及其 [Controller](../src/controllers/api/v1/AdminDivisionController.ts)。原路由注册位置仍在 `routes/adminapi.ts` 与 `routes/v1/index.ts`。

## 同一屏障先于决定读取

上述写事务统一由 `withAdminAuthorityWriteTx` 进入，首先设置 `READ COMMITTED` 与本地语句、锁、空闲事务上限 5s/2s/5s，再按固定顺序取得下面两个真实公共表的锁：

```sql
LOCK TABLE ONLY public.system_admin, ONLY public.system_role
IN SHARE ROW EXCLUSIVE MODE NOWAIT;
```

actor、当前角色、目标角色、请求角色、引用账号和 Division 范围等决定读取均位于取得屏障之后；读取、角色引用决策和全部相关 DML 使用同一事务。屏障由真实驱动持有至 COMMIT/ROLLBACK。原有 Division advisory/user 锁随后取得，不能反过来先读角色、等待共同屏障，再使用旧决定写入。

此模式同时与这两个表的 INSERT/UPDATE/DELETE 冲突，包含尚不存在的新引用；仅锁当前角色或当前引用行不能阻止另一会话新增引用。`NOWAIT` 冲突及 PostgreSQL 的 `55P03/40P01/40001` 由共同错误边界转换为受控 409；语句超时 `57014` 转为 503。客户端须把冲突视为失败并重新读取，不由服务自动重试。读目录、旧 GET 表单等既有只读合同不因本批写事务改成新写能力。

## 真实身份、当前授权及角色输入

Controller 使用鉴权上下文中的 `adminId`、`socketAuthVersion`、`socketTokenExp` 构造 actor。写服务在锁内重新读取真实账号，验证平台域 `admin_type=1/relation_id=0`、启用未删除、合法账号 level、当前密码版本与 token 到期；在返回前再次检查到期。调用方传来的 scope.level、缓存的角色及 DivisionId 不能替代当前数据库身份。

actor 的完整角色 CSV 在权限解析前校验不超过 128 个字符、正 int32 ID，保留既有 trim、忽略空分隔项及去重兼容协议。当前角色规则也先受完整字符数与 token 数上限约束，不能依赖旧解析器截断后放行。非超级管理员必须仍拥有该入口所需当前能力，其实际生效授权限制可以委派的目标和请求权限。平台角色限定 `type IN (0,1)/relation_id=0`，请求指派必须存在且启用；不能用供应商、门店或其它 relation 角色跨域获得权限。

现代管理员编辑对他人的当前生效角色权限复核授权子集，同时保留修复已停用或失效旧指派的能力；这不等于允许请求新增无效角色。Division 对实际选中平台管理员的既有和请求指派都严格复核有效性、启用状态和子集，JSON 数组保留原类型并拒绝非数字或超界 ID，不再先做有损 Number/filter 转换。一个事业部有多个平台账号时，保存按 ID 升序选首个既有账号，查询与写入均限定平台 relation 0。

普通管理员仍不能从现代指派入口委派旧数字菜单角色来绕过真实权限子集；旧角色 POST 保留其独立的真实菜单、mapped/eligible opaque、下一层级及无损选择规则。两条表单协议没有合并，也没有通过改变 `system.manage` 扩大 Division 代理商或员工的能力。

## 平台账号、本人及最后超级管理员

`system_admin.level=0` 才是平台超级管理员账号属性，仍须满足真实平台域、启用、未删除及有效会话。`system_role.level=0` 是角色层级字段；现代新角色默认 level 0 不会把其成员账号提升为超级管理员。

现代管理员编辑拒绝改变本人角色集合、状态或等级。本人改 pwd 的既有唯一入口仍为 `POST system_admin/save` 管理员编辑，要求当前真实 `system.manage`、有效密码版本和至少 12 位新密码；本批没有新增个人改密路由，也没有恢复旧个人中心的旧密码、手机验证码等完整自助合同。密码更新后，旧 JWT 的 auth claim 与新存储密码版本不再匹配，后续请求须重新鉴权。Division 保存不允许通过事业部桥接修改当前登录账号的密码、账号标识或身份，避免成为第二个本人改密入口。

非超级管理员不能修改或删除超级管理员账号。降级或停用现有启用 level 0 平台账号前，必须在同一屏障内证明还有其它启用、未删除、relation 0 的平台 level 0 账号。Division 删除读取完整平台账号组，拒绝包含本人账号的组；最后超级管理员检查排除整个删除组，不能让组中两个待删除账号互相充当 remaining。组查询使用 LIMIT 1001，超过 1000 明确返回 503，不能对截断子集执行批量停用。原事业部删除范围限制保持有效，代理商与员工仍按原层级处理。

Division 批量管理员 DML 的条件明确包含 `admin_type=1/relation_id=0`，不会因相同 division_id 停用供应商或其它 relation 的账号。平台管理员和角色更新核对完整 RETURNING，并通过真实存储回读确认；Division 账号组核对全部预期 ID 和各列，跳过一行、返回数量不符或触发器改写结果均抛错、整笔回滚。

## 本批对引用角色的行为限制

**当前已经被管理员引用的角色，其真实权限集合或 status 变更会返回 409，角色删除同样受此保护。** 这覆盖现代角色保存、现代删除和旧角色 POST。仅同一权限集合的顺序、重复 token 或既有 manage/view 规范化差异不作真实授权变化；旧表单比较真实 grant 集合，结构祖先和排序不能制造授权变更。actor 本人正在使用的角色另有直接修改/删除保护，不能通过名称提交绕过。

共同服务在屏障内扫描真实引用，包含停用与软删除账号，以避免以后恢复账号时静默获得变化权限。扫描上限为 1000，以 LIMIT 1001 检测，超限返回 503。内部 impact/revision 摘要仅用于约束当前决定，**没有公开的完整受影响账号 preview、revision 回传与显式确认写入协议**。现行默认策略对被引用角色的真实权限/status 变化明确拒绝，超级管理员也不能把普通保存当作确认。

这是本批新增的用户行为限制：过去能直接提交的已引用角色授权、启停或删除操作，现在会失败；相关回归验证当前暂时证明“不安全的引用变更被拒绝”。它不能记作原引用修改体验已迁移，更不能把原正常变更回归替换成拒绝断言后宣称完整等价。用户目前可以在各自授权范围内执行未引用角色的变更，以及符合其它限制的名称、层级等无授权变化编辑；完整引用修改流程仍需要后续设计和实施。

## 仍开放的父合同

- 完整受影响账号范围预览、operation/target/actor/realm 等完整 revision 绑定，以及用户明确确认后在同一屏障内重验并提交的协议。
- durable operation UUID receipt、写入结果查询、响应丢失或超时后的 unknown-outcome 恢复；保存成功返回或目录重读不能代替耐久回执，CREATE 响应丢失后不能据此声称可安全再次创建。
- 现代和旧客户端对上述 preview、确认、提交互斥、UUID 回执、取消及恢复状态的真实消费和浏览器验证。
- 旧角色独立 `PUT setting/role/set_status/:id/:status` 与 `DELETE setting/role/:id` 两个合同；旧 POST 能保存 status 不等于这两个消费者完成。
- 旧管理员 staff/account 写链，包括旧新增、编辑表单及其保存、`PUT setting/set_status/:id/:status`、`DELETE setting/admin/:id` 等消费者。现代保存和 Division 桥接不能替代旧表单及写协议；门店 staff 等其它业务合同也不在本批完成声明内。
- 真实历史账号与菜单、生产规模、Hyperdrive、受限真实角色和旧端端到端行为，以及 commit/CI/push/deploy/release 等父验收。

本批不新增 DDL、路由或旧客户端确认恢复协议，不以共同锁实现、局部 HTTP/SQL 测试或临时行为拒绝降低旧缺口统计。不修改 checklist、主分母或旧角色合同中的历史结果；后续应由 Root 根据本批完整实际证据另行更新日期台账。

## 本批实际验证证据

本批 Q 根：`C:\Users\cina\.codex\visualizations\2026\09\26\01a0db11-74a0-7cc2-b1f9-ee3b8653056a\checklist-route-contracts-20261008\admin-authority-write`。以下记录来自本批实际命令、stdout/stderr、退出码和时间；源码与完整证据哈希写入独立验证清单。

| 证据项目 | 当前状态与须记录内容 |
| --- | --- |
| 共同事务、现代写入及旧 POST 业务验证 | `business01` 实际退出 0：现代共同服务 15、Division 18、旧 POST 当前 25，共 58 项；真实 PGlite SQL、JWT/Hono 与触发器回滚。最初独立导入因沙盒 Temp rename EPERM 实际退出 1、运行 0 项；原始日志保留。 |
| Division 真实驱动业务验证 | 上述 18 项包含屏障先于读取、真实 JWT/type/scope、既有与请求角色、本人及整组保护、1000/1001 容量、实际触发器抑制和回读不一致回滚；不充作原生会话锁证明。 |
| 原生 PostgreSQL 16 验证 | `native01` 三文件 16 项全部通过：现代 7、旧角色 4、代理申请既有消费者 5。PG16.15、回环 port65160、独有 gmbNQ9 集群；真实 app/Admin LOGIN、真实权限计划及边界、public 双表锁和菜单行锁、新引用并发 409、提交后停用拒绝、鉴权后实际提交撤权、三实际阻塞 PID 均验证。fixtures=0，runner 自动停机，独立 `pg_ctl status` 实际退出 3/no server running；data/log 保留。原始 stdout 的 25P01 清理 ROLLBACK 警告未过滤。 |
| Worker unit/runtime 两套完整类型检查 | `unit-types03`、`runtime-types01` 均实际退出 0，stdout/stderr 均为空。unit 首两轮实际退出 2，仅新原生夹具返回值联合类型的三处属性错误和两处断言重叠错误；最终两处 `unknown/Array` 注解完全擦除。注解前源码与原生执行输入 SHA256 精确匹配，前后 esbuild JavaScript SHA256 均为 `ff2ac2c038d252e4bbcb1b8db9188a7f1ceb429592ec367ee20d7749846bcf48`；SQL、断言及生产代码未改，未重复原生测试计数。 |
| 既有相关回归及路由/接口审计 | `regression01` 六文件 77 项实际通过，加业务 58 和原生 16 为 151 唯一项。两原 CLI 实际退出 0：PHP1904/Worker2349、917匹配/896可执行/21受控不可用、987未匹配减17退役为970可行动缺口，Admin902/API11/Supplier49/ERP8，Kefu/Out0，有效覆盖47.5%。现代 Admin602调用/633变体全部可执行、0未注册/未解析/受控不可用。清单404/249/155，所有复选行保持。 |
| 最终源码及发布状态 | 基于本地 `8647984db5780235e0b50e0118814ca9f0a23e8d`；独立验证清单绑定本批最终源文件与各次原始执行。Primary HEAD `0cae32bda15d3bf4f68ca507fcb1174e6b58fa87` 与其干净状态保持。新公开 push、CI、merge、deploy 未执行；旧 d5c31e8 发布不计本批信用。 |

上述信用限于本机真实 middleware/controller、SQL、JWT、隔离 LOGIN 与会话锁；没有完整生产主应用挂载、旧 Vue 或现代页面的渲染浏览器验收，不抵扣真实数据、Hyperdrive、provider 或设备验收。后续影响确认和恢复链仍按上方父合同开放。
