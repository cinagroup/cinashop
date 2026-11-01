# 履约同城冲突读取合同

共享发货与拆包需要核对同一付款根的同城任务。基础 App/Admin 没有这些任务表的原始 SELECT，不能靠额外 raw grant 跳过履约屏障。`fulfillment_city_conflict_v1(integer)` 提供显式安装、同事务使用的窄读取端口。它不授予同城任务写入或第三方配送能力，也不开放跨 AppID 归属切换；`runtime_ready=false` 保留。

## 正式维护入口

`upgradeFulfillmentCityConflictReaders(db, target, declaration, peers, appReader?)` 由真实 PG16 维护 LOGIN 在 READ COMMITTED / READ WRITE 下执行。`upgradeFulfillmentCityConflictReadersInTransaction` 供现有维护事务使用，全部 DDL 与 ACL 随调用者提交或回滚。请求路径不安装或修复目录。

`declaration.readers` 为封闭数据对象，包含独立 `owner` 和至少一个显式为 true 的 `app`、`admin`、`manager`。维护者事先提供专用、空的 NOLOGIN owner；安装器不创建角色。完整 target 的 database、maintenance、app、admin、local 与 caseLock 必须与 peers 一致，peers 必须声明既有 Financial、Cashier、Manager 共存合同，并带完全相同的 `cityConflictReaders`。现有 App reader 声明另以 `appReader` 传入。

```ts
const readers = { owner: 'cinashop_city_conflict_reader_owner_v1', app: true, admin: true } as const;
await upgradeFulfillmentCityConflictReaders(db, target, { readers },
  { ...existingPeers, cityConflictReaders: readers }, existingAppReader);
```

增加 Manager 时必须提交精确 `previousReaders`，新 readers 保持同一 owner 且只增加 actor；对应 Manager peer 也须显式声明。Manager 基础角色不会自动得到 EXECUTE。移除 actor、更换 owner、半安装、漂移或不相关权限均拒绝。精确重复会重新审核完整运行合同，然后返回 `applied:false`，不执行 DDL 或修改 ACL、业务行。

入口在首次 await 前复制并校验有界数据，拒绝 getter、稀疏数组和非原始身份。维护者必须是当前数据库的实际 superuser LOGIN，current_user=session_user=后端认证身份，无 SET ROLE、活动 event trigger 或 replication-role 绕行。完整 App/Admin/Manager 审计连同已声明 Financial/Cashier 合同在前后执行。

## 权限与元数据证明

固定函数为 SECURITY DEFINER，专用 owner 只有同城 job 的 id/root_order_id/status、binding 的 job_id/active 列 SELECT，以及 store_delivery_order 的 UPDATE 权限；最后一项只用于 PostgreSQL 要求的表锁，函数不执行 UPDATE。owner 没有登录、成员关系、schema CREATE、其他对象所有权、序列或同城写权限。PUBLIC 的函数 EXECUTE 被撤回，只有 owner 与声明的 actor 得到精确 EXECUTE，不带 grant option；运行账号没有新增同城表 SELECT。

`inspectFulfillmentCityConflictReader` 只读目录，核对数据库、命名角色及 OID、源表 OID/owner/完整形状、固定函数 body/配置/ACL 和 owner 权限闭包。函数内的 JSON 仅提供待核对的候选身份，ACL 不产生身份授权。检查不执行函数、不取得业务锁，也不调用完整运行/定价审计，避免循环依赖。完整审计及共享 pricing envelope 仅豁免这一个经过证明的函数 OID。

函数的 search_path 固定为 pg_catalog,pg_temp，目录函数与实际 public 源表均有显式限定。目录检查只规范化已知 PG16 同 public 外键名称和序列默认表达式，不更改连接 GUC。非系统 schema 中的同名能力命名空间、孤儿及部分对象均拒绝。

## 事务与锁

维护 forward 先按既有全局顺序取得 try-only 排他 advisory 门，包含新门 `[731721,0]`，再对三张同城表和 store_delivery_order 取得 ACCESS EXCLUSIVE NOWAIT。任何竞争均整笔回滚，不等待持有付款根锁的运行请求。

运行调用者先持有既有付款根 advisory 锁 `[63842,rootId]`，再尝试同一事务的共享 `[731721,0]` 门。固定函数重新核对实际 session_user、LOGIN/OID、无 SET ROLE、PG16/RCRW/origin、数据库及源 OID，并对 store_delivery_order 取得 SHARE ROW EXCLUSIVE NOWAIT，锁保留至业务事务结束。超时只收紧：statement 至多 5 秒、lock 至多 2 秒，生产 fence 再收紧 lock 至多 1 秒。

函数最多读取 501 行；超过 500、PENDING/PROCESSING/UNKNOWN 或 active=1 的 ADMITTED 均返回业务冲突 P2131。门或表锁繁忙返回 P2132。没有允许某 jobId 绕过的参数。真正同城 writer 仍走完整写合同、真实同根任务与其原锁链；手工发货 reader 不替代该合同。

历史同城命名空间完全缺失时，共享 fence 保留原 no-op。旧安装没有 reader 时仍走原读取路径，不隐式授权。存在 reader 后，手工发货必须使用完整已安装端口；源漂移或 actor 不符不能退回 raw SQL。

## 分包消费者与验收边界

原账号分包上传还要求实际 App 被显式选入该 reader。首次准备先验证 reader，再解析归档凭据材料；准入和实际上传前还会再次取得共享门并复验。最后一次复验发生在 token I/O 之后、上传 POST 之前，复验事务关闭后才执行 POST。已持久化 code=0 回执的只读恢复不取得新 reader 门，也不重新授权 HTTP。完整业务规则见[原账号发货合同](routine-shipping-accounts.md)。

隔离 PG16 的完整 18 项正式验收覆盖五个真实 LOGIN 共存、App/Admin 首装、显式 Manager successor、调用者回滚、精确重复、参数快照、源/owner/body/ACL 漂移不修复、实际三角色调用、付款根锁前置、竞争 NOWAIT、ROLE/RCRO 拒绝及安装后的 TEMP/search_path 反例。冲突任务使用明确的维护测试标本，不代表真实配送 provider；真实 Admin 拆包/发货与 App Queue 由另一个完整 12 项文件验证。

尚未单独执行 reader 维护与 fresh upload/recovery 的业务层竞态、退款物化家族负例、15/16 包边界或连续三次以上扩包。类型3有物流分类单测，当前真实拆包生产者仍使用类型1；未证明新的门店归属作者或 Manager 发货 HTTP。没有生产 DDL、部署或真实微信调用。

PostgreSQL 依据：[LOCK 的权限、NOWAIT 与事务持有期](https://www.postgresql.org/docs/16/sql-lock.html)、[SECURITY DEFINER 的 search_path 与 PUBLIC EXECUTE](https://www.postgresql.org/docs/16/sql-createfunction.html)、[current_user 与 session_user](https://www.postgresql.org/docs/16/functions-info.html)。
