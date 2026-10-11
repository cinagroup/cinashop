# 旧角色独立启停与物理删除后端合同

本批以私有候选 `d3737087d01f9ac9930eeea6170336be97c85a1d` 为基线。旧 `PUT setting/role/set_status/:id/:status` 和 `DELETE setting/role/:id` 是两个独立动作；角色表单 POST 与原现代 `role-save/role-delete` 均不代替它们。新服务与普通旧表单保存、现代三个操作的 parser/权限/结果恢复域分别限定。此文描述本地实现与验证范围，不代表公开推送或生产验收。

## 请求和确认

专用类型仅 `legacy-role-status`、`legacy-role-delete`。preview envelope 严格为 `{operation_id,operation,payload}`，status payload 严格 `{id,status}`，delete payload 严格 `{id}`。ID 必须为正 int32，status 只能为数字 0/1；小写 UUIDv4 不因路径或客户端 scope 字段变成任意目标。

canonical URL 的真实业务输入仍由路径给出。提交必须先获得预览，携带四个确认 headers：`X-Admin-Operation-Id`、`X-Admin-Revision`、`X-Admin-Expires-At`、`X-Admin-Confirmed: true`。缺少 metadata 是受控冲突。真实旧 Vue 的 `tableDelApi` 使用 `data: data.ids`，角色页面给 `ids:''`，因此实际发送空 body，并非 JSON `{ids:''}`。两个动作都接受 empty/absent body；删除额外有限接受精确 `{ids:''}`，这个空字段不决定删除目标。controller 拒绝查询参数、其他 JSON 字段和非空批量 IDs；新 UI 无业务请求体。

预览有效期最多 300 秒且不超当前 session。服务 HMAC 分别签名 request 和 revision，绑定完整操作、payload、原 actor/session、expires_at、全部影响账号全行、全部相关角色全行/已删除角色证明、完整平台菜单目录与权限政策。预览后任何相关身份、CSV、规则、菜单元数据或新增引用变化都使确认失效，不能用旧确认隐式接受新的影响范围。

## 正常授权与影响

actor 必须是实时启用、未删除的平台账号 (`admin_type=1/relation_id=0`)，session password version 和 expiry 实时有效，level 在 0–9。目标必须是下一层级的真实平台 role (`type=0/1,relation_id=0,level=actor.level+1,status=0/1`)；actor 正在使用的任何 CSV role ID 均不能作为目标。现代软删的 status=-1 与物理已删行不经状态操作复活。

两个细能力分别是 `system.legacy_role_status` 和 `system.legacy_role_delete`。旧 `system.legacy_role_manage` 只保存表单；329/330 的 protected metadata tuple 与精确 method 身份由权限模块维护。preview 的路由 admission 仅表示可尝试一种独立动作，服务按解析后的 operation 精确再验。现代 `system.manage` 可按现有单向覆盖政策覆盖细能力；细能力不获得现代全层级写权限。

影响集合包含全部管理员 CSV 引用，包含启用、停用、历史已删除账号；最多 1000 条，超限拒绝，不截断。每条引用必须仍是目标下一层级的平台账号，完整 CSV、全部真实相关角色和菜单都要验证；无法说明的 missing/foreign/malformed 角色或未知、损坏、外域菜单不能在 resolution 时消失。涉及最多 10000 个相关 role ID，已删除证明按每批 128 个 ID 顺序读取，不因聚合影响集合大于单个 CSV 限制而丢弃。

行数并非容量承诺。完整 current/relevant role、菜单、引用账号、删除证明集合分别在 SQL 内聚合 `octet_length(to_jsonb(row)::text)`，每集合上限 4MiB；在全行传输及 HMAC 构建前超限受控503。操作后的保护回读也先检查预算；不把大目录切成可签名的有损子集。unit 使用仍在行数/token限制内的大角色与菜单集合验证这一独立容量边界；不代表最大行数与字节数同时达到边界时的负载验收。

preview 返回七列 before/after role 快照、全部引用的安全账号字段和当前有效权限是否改变。`active_reference_count` 为账号 `status=1 && is_del=0` 的引用数量。`effective_permission_change` 比较该账号当前有效 canonical 权限闭包与 opaque numeric grant；重复授予同权限可以使它为 false。停用/历史删除账号当前不生效，标 false，仍完整列出供操作者确认未来恢复风险。role rules 是完整存储值，仅显示，不接受显示名称回写。

## 物理删除、历史 CSV 与耐久回执

status 执行 UPDATE 仅写 status，核对完整 RETURNING 及真实回读。delete 执行真实 DELETE RETURNING，返回原完整行须一致，真实回读必须不存在。两动作均核对引用 CSV/账号全行、actor、相关角色和菜单不发生非预期级联变化。正常被引用角色经明确影响确认可以成功；不会以永远409、删除引用账号或 status=-1 tombstone 代替旧合同。

staff/role 共同 `SHARE ROW EXCLUSIVE` 表屏障先于所有决定读取，再取得完整菜单 `SHARE` 锁；锁一直保持到真实 COMMIT。新引用插入、角色/账号撤权和菜单更新须在同一屏障后等待或 NOWAIT 受控拒绝。目标变更和精确回执插入/RETURNING/回读属于同一事务；跳过、改写、重新插入、CSV 级联或回执冲突均回滚整笔操作。

数据库的 legacy-role-delete committed result 精确为 `{id,deleted:true,deleted_role:{id,type,relation_id,role_name,rules,level,status}}`。不可变七列原始身份证明保留角色真实 realm、level 和完整 rules；它不成为可委派或生效的 runtime role。wire receipt 只投影 `{id,deleted:true}`；status result 为 `{id,created:false}`。共享 proof helper 必须先证明该 ID 真实缺行、专用 committed kind/realm、完整 receipt 格式和具体历史身份，再由调用方核对 level、rules、菜单。任意缺行、仍存在的 foreign/retired 行或错误层级证明不能冒充合法历史删除。

回执永久不可 UPDATE/DELETE/TRUNCATE，无过期/自动清理或 FK 级联。原 UUID 只返回原已提交结果；不同 payload、kind、owner 的复用拒绝。GET 查无行返回 unknown，不能当作未执行；resolve 在共同屏障内插入永久 not_applied seal，后续 commit 永不能使用该 UUID。恢复仅要求原 owner 的实时平台身份和有效当前 session，可在 writer grant 被撤回后进行；旧 password token 仍拒绝，新有效 session 可恢复原已提交操作。

## 明确新增权限和验证边界

原 commissioned Admin profile 没有 `DELETE public.system_role`，原现代 role-delete 仅 UPDATE tombstone。真实物理删除需要本批独立 v3 addon：完整 wrapper 在精确原 v2 profiles 验证后，原子变更两个 CHECK 并仅新增 Admin 对 `public.system_role` 的 DELETE；App 保持无 DELETE，也无 receipt SELECT。历史全店计划固定，v3 的有限审计 extension 与新版本精确目录关联；v3 重复不会补 ACL 或修 catalog drift。这项新 ACL 必须纳入之后具体发布授权，不能声称被此前 staff/newcomer 授权自动覆盖。

业务 unit 使用隔离 PGlite，测试之间重建本地临时 receipt schema 来避免复用 synthetic ID 导致伪造历史；不抵扣 PG16 锁、真实 LOGIN 或 commissioning。native file 是一个完整 PG16 case，使用全店 180 阶段 fixture、精确 commissioning wrapper 与真实 App/Admin LOGIN，而不是 owner 代执行业务。它验证原 DELETE 确实拒绝、新 Admin-only DELETE、canonical 两 base 的正常引用启停/物理删除、真实旧空 body 与有限额外 JSON 兼容、三独立 peer 锁至 COMMIT、完整 stale 范围、七种真实 trigger 原子回滚、真实 COMMIT 后响应丢失、原 owner 撤权后恢复、新 JWT 实际 auth middleware 与 commit/resolve 竞争。此 native case 的多个阶段仍只计一个测试；具体运行/退出码和源 pin 必须以外部验证日志为准。

新 JWT middleware 接受是当前 session 恢复证据，不等于执行了实际登录表单/密码登录 handler。测试不访问 provider，不安装生产 schema，不迁移真实用户 CSV，不关闭仍开放的角色创建/编辑未知结果、完整生产 auth 或 checklist 验收项。
