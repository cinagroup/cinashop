# 秒杀时段删除的固定数据库能力

秒杀时段 CRUD 是候选实现，生产数据库尚未安装本能力或应用本批权限变更。上线前需要维护账号完成本文的角色安装、迁移和运行权限审计；管理页面可访问不代表数据库准备完成。

删除时段需要重新检查 `store_activity` 和 `store_seckill` 的引用。购买事务依次取得父活动 SHARE、子商品 UPDATE、时段 SHARE 行锁，因此删除依次锁父活动、子商品，再取得时段 UPDATE 行锁。父、子表的 EXCLUSIVE 锁既阻止新的引用和购买决策，又允许普通商城 SELECT。编辑及显隐仅使用时段写入 advisory 锁和时段行锁，不取得这两张表的锁。

运行账号只有父活动只读权限，直接执行 EXCLUSIVE 表锁会被 PostgreSQL 拒绝。为此新增固定无参数 `public.admin_lock_seckill_time_references_v1()`：函数只依次锁 `public.store_activity`、`public.store_seckill`，不读取或改变业务数据，不接受 SQL、对象、角色或权限参数，也不执行任何 GRANT。服务在现有 DELETE 事务内调用；缺失、漂移、授权不足或锁超时均拒绝操作，没有直接表锁 fallback。

## 显式安装

外部迁移为 [`0167_seckill_time_reference_lock.sql`](../migrations/0167_seckill_time_reference_lock.sql)，embedded 注册为 `0173`。当前完整清单为 169 个外部 SQL 文件、174 个 embedded 步骤；旧 `0166` / `0172` 充值 seed 不变。已有 schema 使用独立 forward 0167，不重新运行 `runAll()`。

维护者先创建一个独立的、从未建立连接的 NOLOGIN owner。该角色不能复用 checkout pricing owner、运行账号或现有对象所有者，不能拥有成员关系、角色切换路径、CREATE 权限或其他业务 DML。下面名称仅展示设置方式，正式名称由维护者选择并记录：

```sql
CREATE ROLE cinashop_seckill_reference_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS;

BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL cinashop.seckill_time_reference_owner = 'cinashop_seckill_reference_owner';
-- 在本事务执行 migrations/0167_seckill_time_reference_lock.sql。
COMMIT;
```

[`installSeckillTimeReferenceLock`](../src/migrations/seckillTimeReferenceLock.ts) 是 root 数据库连接的维护入口，可以显式传入 owner 名称；embedded / standalone runner 从维护连接的显式 `cinashop.seckill_time_reference_owner` 设置读取 owner。安装器不创建角色，不猜测 owner，不为 LOGIN 授权，不修复已有漂移。迁移设置需要与安装事务处于同一连接，不能依赖连接池中的其他会话。

首次安装在事务内短暂授予 owner schema CREATE 以移交函数所有权，随后撤销 CREATE。最终 owner 只有 schema USAGE、两张目标表的 UPDATE 锁权限及该固定函数的所有权；不拥有表，不修改任何业务行。PUBLIC EXECUTE 被撤销。失败时函数和新增 owner 权限随事务回滚。重复安装核验同一 owner、函数 OID、定义及 ACL，保持它们不变。

## 运行权限和边界

仅在既有维护 commissioning 流程中应用固定 [`runtimeBusinessPrivilegePlan`](../src/migrations/runtimeBusinessPrivilegePlan.ts) / grant / audit 协议。admin profile 新增 `store_seckill_time` UPDATE、DELETE 和这一个固定函数 EXECUTE；INSERT、SELECT 沿用原计划。app profile 只读时段，无该函数 EXECUTE。两个 profile 均不新增父活动 UPDATE、DELETE、INSERT，也不获得 owner 成员关系、SET ROLE、函数 GRANT OPTION、表所有权或任意表锁能力。

[`auditRuntimeBusinessPrivileges`](../src/migrations/auditRuntimeBusinessPrivileges.ts) 仅对 admin 当前确切 OID 且定义、owner、ACL 完全通过检查的函数作 definer 例外。其他 callable SECURITY DEFINER 仍拒绝。catalog 检查固定无参数签名、完整函数体、`search_path=pg_catalog, pg_temp`、普通固定两表、独立受限 owner、无 incoming/outgoing membership、无 surviving owner session、无无关 DML 和无 grant option；PUBLIC grant、overload、RLS、owner 或函数漂移全部 fail closed。它不会自动撤销或修补漂移。

调用必须使用 READ COMMITTED。函数把 statement / lock / idle-in-transaction 期限收窄至最多 5 / 2 / 5 秒，并保留调用者更短的期限。安装使用 5 / 1 / 5 秒期限和父→子 ACCESS EXCLUSIVE NOWAIT；维护 advisory gate 与业务 shared gate 互斥，避免安装和业务调用并行改定义。资格审计、锁或约束失败时整个 DELETE 事务回滚。

## 隔离验证

[`seckill-time-reference-lock.test.ts`](../test/seckill-time-reference-lock.test.ts) 使用实际 PostgreSQL 16、独立 LOGIN 和 backend PID 屏障验证原权限拒绝、固定锁、锁顺序、提交/回滚、截止、漂移、owner 扩权和 app / PUBLIC 拒绝。PGlite 业务用例不会被当作 SECURITY DEFINER 或真实角色权限证据。

[`seckill-time-reference-lock-upgrade.test.ts`](../test/seckill-time-reference-lock-upgrade.test.ts) 覆盖旧完整外部 schema through 0166 独立 forward 0167、fresh 169 个外部文件、fresh 174 个 embedded 步骤。升级快照检查所有 279 张 public 表的业务行、既有对象身份及权限，以及表、列、约束、索引、序列五类 catalog；新 owner 的两个锁权限是明确允许的安装差异。既有 runtime restricted LOGIN 套件作为全 profile 回归。全部在自有 loopback 测试实例中创建和清理，不执行生产安装或授权。

该 LOGIN 回归覆盖普通及预售购买，没有覆盖实际秒杀 app 购买。现有 app profile 对父活动和时段只授 SELECT，而购买的 FOR SHARE 行锁还需要 UPDATE 权限；本批不扩大 app 或父活动 DML，后续父活动合同与真实角色验收需单独处理这一既有缺口。维护身份的原生购买并发证据不能代替该 app profile 的购买资格验收。
