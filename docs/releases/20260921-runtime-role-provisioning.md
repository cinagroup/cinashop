# 2026-09-21 受限运行角色供应（未切换应用）

用户明确授权新增专用受限数据库角色，并在验证后调整生产 Hyperdrive 连接身份。本轮已完成**角色创建、新 Hyperdrive 配置和独立真实 LOGIN 验证**；没有修改主站绑定，没有给新角色授予业务表/序列权限，没有合并 main、发布应用或清理未发布分支。角色可登录不代表已能承载商城。

## 生产实际结果

09:38（Asia/Singapore）固定维护入口在现有 PostgreSQL 16.14 / `postgres` 数据库创建三个全新角色，碰撞时拒绝，不修改既有角色或自动重置密码：

| 角色 | LOGIN | 用途 | 连接上限 |
| --- | --- | --- | ---: |
| `cinashop_app_v1` | 是 | 后续商城、回调和队列运行身份 | 40 |
| `cinashop_admin_v1` | 是 | 后续通过完整后台鉴权后的管理操作身份 | 15 |
| `cinashop_pricing_owner_v1` | 否 | 后续固定计价锁函数专用所有者 | 默认；禁止登录 |

三者均无 superuser、CREATEDB、CREATEROLE、INHERIT、REPLICATION、BYPASSRLS，无角色成员关系、对象所有权、schema/database CREATE、复制模式旁路、public 业务表/列和序列权限。两个 LOGIN 仅显式获得数据库 CONNECT 和 public USAGE。此处是初始权限包络，不是完整业务或全库安全验收。

密码独立随机生成，数据库使用 SCRAM；本机仅保存当前 Windows 用户 DPAPI 加密载荷，目录 ACL 仅当前用户和 SYSTEM。文件位于忽略的 `.cache/runtime-role-credentials-e5f2bd8fac0b4a8e81fbf28b31873326/credentials.dpapi`，不上传 Git、不输出明文。不应重新运行创建器；存在角色时必须只读复核，不自动旋转密码。

09:41 创建并独立回读两个新配置，沿用已核对的 VPC 服务和数据库，均关闭查询缓存：

| 配置 | ID | 数据库角色 |
| --- | --- | --- |
| `cinashop-runtime-app-v1` | `ba7faa6680cd48d4b3a1d36a7a5fc8f7` | `cinashop_app_v1` |
| `cinashop-runtime-admin-v1` | `446e94a4de0143f58c8e5178ec55db8b` | `cinashop_admin_v1` |

09:50 两个临时 Worker 分别通过新 Hyperdrive 建立连接，独立查询确认 `current_user = session_user = pg_stat_activity` 后端身份等于预期 LOGIN，三角色的初始限制仍成立。不是在维护连接上 `SET ROLE` 模拟。

原 `9748c294e21c49a99579c9cef70102e0` 配置完整回读一致，未 PATCH/删除，`cinashop-api` 的 Hyperdrive 绑定前后不变。旧连接仍是维护身份，因此本轮**没有消除正式应用高权限运行的风险**；验证完整业务权限后才可切换。

角色创建 Worker `cinashop-role-provision-1eef3027cef0`、成功登录探针 `cinashop-runtime-login-audit-41c0541798b2` 和 `cinashop-runtime-login-audit-97d80ef6b296` 均已删除并确认控制面 404。首次只读登录探针 `cinashop-runtime-login-audit-c1957bdf3432` 未成功、已清理，原始失败原因未确定；后续只增加 SQLSTATE 脱敏诊断并明确重跑只读探针，没有重试角色创建或修改密码。

## 09:58 生产只读协议复核

临时 `cinashop-paid-runtime-audit-9dfe57018d73` 已删除、控制面 404；匿名 403、错误方法 405、查询输入 404。预检始终返回 `ready=false`，不把目录观察当作发布通过。

- 0146–0151 前置协议 ready；孤儿付款用户为 0。九表 49 行摘要仍为 `46ddfeaf28560affc8533ea2c2f9970e159e115e39e74b307027fa235476d71b`，本轮未再删除订单。
- 四表 `system_config`、`user`、`user_bill`、`user_money` 精确匹配从独立 canonical PG16 DDL 减去 19 个既定普通索引得到的基线，且 owned/safe 均通过；其余六项依赖匹配既定前态。这关闭了“是否还存在该目录包络覆盖的其它差异”的不确定性，不代表全库无差异。
- 固定索引修复器仅增加这 19 个索引；拒绝漂移，NOWAIT 锁、逐语句 5 秒超时、每表 10,000 行上限、事务内前后摘要相同才提交。**尚未在生产执行**；逐语句限制不等于总事务 5 秒。
- 0155/0156 仍缺失，0157/0158 为 fresh，0159 为 drift，0160 函数缺失。三角色存在未使这些协议自动安装。

## 本地增量与 CI

`432e3223309a48445787c330c7e9a72441f8e225` 的 [Linux CI 35549756319](https://github.com/cinagroup/cinashop/actions/runs/35549756319) 已结束为 failure，不是仍运行或超时：两个分片合计 9,355 项，9,346 通过、9 失败、零 pending。五端构建、workerd、独立 PG 目录与密钥扫描通过，但不能替代单元门禁。

其中 8 个失败来自三份当前结算退款夹具：缺少真实数量预留及一致的履约身份。已修正夹具，通过原事务建立数量预留并保存实际 store/supplier 标识；未放宽退款业务保护。第九项运费规则并发用例当时在 NOWAIT 锁失败，原 CI 没有保存 SQLSTATE，原因未证实；未改生产锁语义或降低断言。其后两文件 76 项复测全部通过，但这不能证明偶发原因已消除。

新增显式 `shared-shop` 审计范围，使普通结算和线下收银两个固定 SECURITY DEFINER 锁能力可以在同一独立 LOGIN 下组合验证。只接受完整目录、函数体/ACL/所有者/调用者包络及精确 OID，默认 isolated 行为不变；漂移函数、同名重载、跨 schema、PUBLIC EXECUTE、隐藏维护身份仍拒绝。该范围尚未接入生产切换流程，不是整站授权方案。

初始验证：相关退款/数量补偿三文件 161 项通过；角色供应及索引原生 PG 测试 7 项通过；共享能力 11 项通过；维护 Worker workerd 边界 18 项通过。最近只读协议与两个维护 HTTP 文件共 72 项通过。重叠重型测试时曾有建库/清理钩子超时，不能计作成功；停止重叠任务后重新运行，结果另行记录。

最终不重叠重型测试的六文件原生 PG16 回归 **123 项全部通过**（303.67 秒），包含角色供应、索引、共享能力、计价锁、线下权限及付款订单权限；运行器确认夹具为 0、服务器停止。维护入口补充调用者流读取/取消异常的脱敏和锁释放，最终三文件 HTTP/协议测试 **74 项通过**、真实 workerd **20 项通过**。这些集合存在覆盖重叠，不累计成全量测试数量。

最终两套 Worker TypeScript（4 GiB 堆上限）均退出 0；三个 PowerShell 脚本解析无错误；暂存增量的 Gitleaks 8.29.0 扫描无密钥发现，差异格式检查通过。候选仍须单独运行当前提交的完整 Linux CI。

失败本机集群 `.cache/finance-postgres-hRKYV3` 中仅核对并删除两个自有测试库，余下夹具数为 0，服务器停止，日志保留；未触碰生产库或其它本机服务。

## 未完成的切换条件

1. 受控安装 19 个共享索引及 0155–0160 协议，独立复核、保留业务数据摘要。
2. 完成逐业务表/列权限清单。商城身份不能获得计价配置写权限；后台身份不能仅凭 URL 获得，须在 JWT、账号状态和路由权限全部检查后选择。回调/队列也需要经过相应权限验证。
3. 新 Hyperdrive 下验证实际业务权限、精确协议及拒绝用例，而不仅是角色可登录。
4. 当前不可变候选全量 CI 及上述门禁通过后，合并 main，按同一提交协调部署 API 和五个 Pages；线上测试通过后才清理已完成分支。保留旧连接和部署版本，不假设未经兼容性验证即可回滚。

Cloudflare/Wrangler 技能用于独立配置、临时短期入口及回读/清理；PostgreSQL 技能用于最小权限和有界事务。没有使用 `GRANT ALL`、历史 `runAll`、清库、扩大线下退款范围或修改域名来绕过条件。
