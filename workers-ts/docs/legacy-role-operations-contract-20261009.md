# 旧角色独立启停、物理删除与完整引用历史

本批在本地提交 `d3737087d01f9ac9930eeea6170336be97c85a1d` 上独立实现，不修改该已冻结发布候选。旧角色的 `PUT setting/role/set_status/:id/:status` 和 `DELETE setting/role/:id` 分别由专用确认协议承接；同 handler 的 `/api/admin` 别名及三个预览、回执、封存端点不另算旧合同。原角色 POST 保存、现代 `role-delete` 软删除和旧管理员 DELETE 软删除的操作域保持独立。

## 原始合同和当前用户入口

真实 PHP `route/admin.php` 的两条角色声明分别在 1762、1764 行。角色 DELETE 通过旧 BaseServices/BaseDao/Model 的 `where(id)->delete` 物理删行，不清理管理员 `roles` CSV。原 Vue 页面把 `ids:''` 传给 `tableDelApi`；该函数实际上发送 `data.ids`，因此是空 body。当前 DELETE 接受 empty/absent body，并额外有限兼容精确 `{ids:''}`；目标只来自严格正 int32 路径。状态只接受路径数字 0/1，两个动作都拒绝查询参数和其它业务 body。

新的 Admin `/system/legacy-roles` 页面列出当前账号下一层平台角色。启停、删除分别要求 `system.legacy_role_status`、`system.legacy_role_delete`，两者只覆盖列表读取，互不授予，也不由旧表单保存能力隐式获得。329/330 数字菜单必须匹配真实 protected metadata tuple 和 PUT/DELETE 方法。预览 admission 不是可持久授予的能力，服务仍按具体操作复核权限。

页面先显示完整 before/after、全部启用及历史引用账号、当前有效权限是否变化，再要求明确勾选确认。提交前不修改显示状态；七字段待确认记录按 actor 隔离，Web Locks 与页面 generation 防止同屏/跨页重复提交和迟到响应覆盖。5xx、连接异常和刷新后查不到回执保持 unknown；只有匹配原操作的 committed 或永久 not_applied 结果可以清除待确认状态。旧 Vue 尚未增加这四个确认头及恢复交互，不能把旧裸请求的受控拒绝当作完整旧客户端验收。

## 历史引用与生效权限

正常被引用角色可以在核对完整影响后启停或真实物理删除。执行只改变目标 role：启停 UPDATE 仅写 status；删除 DELETE RETURNING 核对原七列及真实缺行。管理员全行和原 CSV 保留，不级联删除账号，不用 status=-1 替代物理删除。

物理删除的 committed 数据库回执严格包含 `{id,deleted:true,deleted_role:{id,type,relation_id,role_name,rules,level,status}}`。返回客户端的 result 只包含 `{id,deleted:true}`。原始七列快照用于说明历史引用，不导入有效权限，也不成为可委派身份。

完整引用 helper 先查询所有真实 ID，再分类真实停用行、现代软删行和具备专用不可变 v3 committed 回执的物理缺行。未解释的 missing、foreign、错层级、畸形 CSV 或空段都拒绝，不能靠权限解析器忽略它们。已有真实行不能冒充已删除；重新出现的外域行也不能借旧回执放行。快照必须与引用层级一致。

现代写入、旧角色表单和旧管理员工作流实时复核这一完整历史后，只使用仍启用的真实角色授予能力。旧管理员编辑表单可用删除快照显示原角色名称和禁用选项，操作者须明确移除该 ID、保留可委派的真实角色；不能重新分配已删除身份。共同 parser 不再过滤空 CSV 段。没有剩余 writer grant 的账号不能从历史快照恢复写权限。

## 事务、回执与显式维护增量

完整 actor、目标、引用账号、相关角色和菜单纳入 HMAC revision。双业务表 SHARE ROW EXCLUSIVE 屏障和菜单 SHARE 锁先于决定读取，保持到真实 COMMIT；新增引用、撤权和菜单变化不能漏过预览范围。行数上限外还对完整集合逐个做 SQL 4MiB 字节预算，超限503，不截断影响或签名范围。目标 DML 和不可变回执在同一事务；异常触发器、CSV 级联、回执冲突和结果改写都必须回滚。

新增 v3 在精确已 commissioning 的 v2 profiles 上，仅替换 `aao_operation_ck` 与 `aao_state_ck` 并为现有 Admin LOGIN 增加 `DELETE public.system_role`。App 不增加 DELETE 或 receipt SELECT。全部原六类回执形状、不可变触发器、函数、表、业务行和其它 ACL 保持；schema 漂移、提前 grant 或 v3 缺 grant 都拒绝，不自动修复。维护 runner 只允许显式 PG16 owner transaction，运行时、启动和 HTTP business handler 不调用安装器。

此前 staff/newcomer 发布授权不包含该新增 DELETE ACL。该升级尚未在生产执行，旧 d373 维护模板仍只承接其原 v1/v2 范围。本批公开推送、当前提交完整 CI、合并、生产适配工具、真实账号/规模/Hyperdrive 和发布验收仍须独立完成。

## 本地验证状态

当前后端 43 项 PGlite 业务测试、完整 PG16 1 case、前端20项实际 SFC测试及32项浏览器夹具检查已通过。PG16 case 内含完整 v3 commissioning、两个真实 LOGIN、两 base 正常启停/物理删除、三个 peer 锁、七 trigger 回滚及实际 COMMIT 后丢失响应恢复；这些 phase 只算一个 case。两个该批 PG 集群均 fixtures0、自停和独立 `pg_ctl` 退出3，data/log 保留。

首次 native 失败为本地夹具姓名22字符超过 varchar16，仅缩短夹具值后完整重跑通过；初次 unit CLI 使用了当前 Vitest 不支持的参数，未执行断言。首次完整 Worker 单元类型检查只报两个既有跨前端测试缺 Vue 依赖，已借用核对锁文件的 Kefu/UniApp junction，不安装或改版本。独立升级5case、跨旧消费者10case、完整相关回归、两套 Worker 类型和实际路由分布仍待本批最终执行结果更新，不能预填通过。

Checklist 保持404总项/249完成/155开放，所有复选行及复合父项不因两条注册或夹具验收自动勾选。完整旧角色创建/编辑未知结果恢复、旧可配置密码和生产端到端仍开放。详细后端合同见 [后端说明](legacy-role-operation-backend-contract-20261009.md)。
