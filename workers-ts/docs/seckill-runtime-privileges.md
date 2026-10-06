# 秒杀排期与父活动的运行身份维护协议

本协议是隔离验证中的候选维护代码，尚未在生产数据库安装或授权。实际连接的权限审计和业务验收必须完成后，才能切换运行身份。应用启动、请求处理和缺权限错误均不调用这些维护入口。

## app 排期锁

秒杀购买按父活动 `FOR SHARE`、子商品 `FOR UPDATE`、时段按 ID 排序 `FOR SHARE` 的顺序读取并锁定排期。PostgreSQL 对行锁要求至少一列的 UPDATE 权限；只有 SELECT 的旧 app profile 会在关联父活动处抛出 `42501`。子商品的库存 UPDATE 是既有权限，本协议不扩大其范围。

新独立协议 `cinashop_runtime_seckill_schedule_lock_only_v1` 在 `public.store_activity` 和 `public.store_seckill_time` 安装两个固定 `BEFORE UPDATE FOR EACH ROW` 触发器。其函数为无参数、`SECURITY INVOKER`，固定 `search_path=pg_catalog,pg_temp`，由显式维护身份所有，撤销 PUBLIC EXECUTE。触发器对显式 app LOGIN 比较完整 NEW/OLD 内容，任何语义变化都抛出 `42501`。Admin 和维护身份不匹配该条件，管理操作按各自既有 ACL 执行。

app 只增加这两表的 `UPDATE(id)`，没有表级 UPDATE、INSERT、DELETE 或 grant option。`UPDATE SET id=id` 可以执行并产生 PostgreSQL 的正常物理行版本变化，但不能改变业务内容；修改 id 的值也会被触发器拒绝。行锁本身不会触发 UPDATE trigger，也不要求 app 拥有该函数的 EXECUTE 权限。

旧 `cinashop_runtime_lock_only_v1` 的定义和已有触发器保持不变。新表不追加进旧函数正文，避免已经安装的库被识别为旧协议漂移。

目录检查拒绝固定两表上未审阅的用户 UPDATE 触发器，保留 PostgreSQL 内部 FK 触发器。app 的触发器正文也检查其它 UPDATE trigger 的名称和函数 OID；即使安装后增加了排序在守卫之后、会改写 NEW 的触发器，app 的 `id=id` 也会拒绝并回滚。

## 显式升级已有身份

已有非空角色不能再次执行 fresh `runRuntimeBusinessCommissioning`。`runSeckillScheduleRuntimeUpgrade(db,{database,maintenance,app,admin})` 接受显式已有身份和数据库，只在 PG16、维护 LOGIN 本人认证、READ COMMITTED 可写事务、无活动 event trigger、两运行角色无特权或成员继承时执行。

它使用独立事务 advisory 锁以及固定 parent→slot 的 ACCESS EXCLUSIVE NOWAIT 表锁。单语句、锁等待、空闲事务截止分别最多为 5/1/5 秒，并保留调用方更严格的期限。表锁不能立即取得时整笔升级失败，没有等待重试或运行身份 fallback。

维护侧只读检查器比较完整固定 profile 的有效表、列、序列、函数权限和协议目录。只有精确旧 profile 或精确已升级状态可以通过。部分新列授权、缺失旧权限、额外权限、grant option、函数/触发器/所有者/ACL 漂移均拒绝；不会修补或撤销未知权限。安装和两条列授权在同一事务内，后续失败一并回滚。重复执行不替换函数或触发器 OID，不重放全库 GRANT，不改业务行或重置序列。

维护侧具名 profile 检查不冒充实际 runtime LOGIN。对外 `auditRuntimeBusinessPrivileges` 仍通过真实独立 LOGIN 验证 current_user、session_user、后台认证身份和最终固定 profile。

## 父活动管理

父活动的 Admin 管理授权与 app 排期锁升级分开执行。其固定窄升级只增加 Admin 对 `store_activity` 的 INSERT/UPDATE 和 `store_activity_id_seq` 的 USAGE；删除是软删除，不授予 DELETE。app 对父活动仍只有 SELECT 和受触发器限制的 UPDATE(id)。父管理的服务合同、HTTP 权限和固定锁能力仍需各自业务验证。

最终 fresh commissioning 安装两个独立边界并授予最终固定 profile。已有身份按 old→schedule→parent 三阶段显式 forward；两个窄入口不接受任意角色列表、任意对象、任意 SQL 或 caller-selected privilege plan。

## 验证边界

本体 native suite 验证真实受限 LOGIN 的行锁、拒绝语义写入、Admin 写入、精确 catalog/ACL、重复、漂移、期限和事务回滚；完整购买 suite 另验证实际秒杀确认/创建与购买并发。原时段删除能力验收中的 normal/presale runtime 30 项，以及维护身份的秒杀购买测试，不能替代本批实际 app 秒杀 profile 的验收。生产安装、Hyperdrive 身份与真实 HTTP 授权仍须显式执行维护和验收步骤。

2026-09-27 的独立 PG16 fixture 已通过两套本体验收：schedule 17 项、parent 7 项，共 24/24；最终实际独立 LOGIN 秒杀验收为 11/11，覆盖关联父/独立子、公开确认与创建、取消或删除恢复、Admin 额度编辑与规格退役、父活动或时段关闭的真实阻塞顺序。

首次业务验收中的两项 `42501` 来自管理展示快照尝试了既有 profile 未授权的 attr_result UPDATE。实现改用既有 INSERT/DELETE 同事务替换活动展示快照，SKU id/unique 保持，权限 profile 没有增加额外授权。之后两项并发测试曾误用 finance fixture 的 peer registry 去连接 sequence-runner fixture，所有权 gate 正确拒绝；改用该数据库自己的 `withPeer` 后通过，保留两个 registry 的隔离验证，没有放宽角色或 endpoint 校验。

本批父管理的 69 个唯一原生验收项由权限 24、业务 26、并发 8、实际 LOGIN 11 组成，完整范围见 [父管理原生证据](../audit/seckill-parent-native-20260927.json)。前后失败、日志、权限源码冻结、双 TypeScript 检查和独立清理记录见 [权限证据](../audit/seckill-runtime-privileges-20260927.json)。重复的旧批运行与普通单元中的 native skip 不累加为新通过数；本批没有新增 numbered migration，也没有在生产安装或授予权限。
