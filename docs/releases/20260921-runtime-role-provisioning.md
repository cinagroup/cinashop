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

### 10:27 生产 schema 阶段完成（尚未切换主站）

固定操作 `reviewed-indexes-and-0155-0160-schema-v1` 已在一笔事务中完成 19 个索引以及 0155–0160 协议安装。
0155/0156 complete、0157=v2、0158/0159=v1，0160 的定义、NOLOGIN 所有者和 ACL 均验证通过。
14 张既有业务表共 95 行的事务前后指纹完全一致，独立只读复核再次一致，没有回填历史数据。
`runtimeCommissioned=false`：此结果不代表两个新 LOGIN 已具备业务权限。
维护 Worker `cinashop-release-schema-6a0820a5376f` 已删除、控制面 404；匿名 403、错误方法 405、查询输入 404、缺少显式操作名 400。
脱敏回执保留在被 Git 忽略的 `.cache/cinashop-release-schema-6a0820a5376f/receipt.json`。
本地原生 PG 最终 5/5、维护入口 workerd 12/12、两套 TypeScript 检查通过；测试库清理为 0 并停止。

用户选择**先完成权限隔离再部署**，不接受保留超级用户连接的测试发布。

### 后台边界实现与本机验证（尚未生产启用）

- 四处正式后台路由改为完整认证/路由授权之后才打开 `HYPERDRIVE_ADMIN`。缺失或重用普通绑定时拒绝，无超级用户回退；请求结束关闭后台连接并恢复普通容器。代客下单明确保留普通结算连接。
- 增加 `runtimeAdminBoundary` 的受控事务安装器及只读精确校验。它是 **SECURITY INVOKER** 触发器：普通 LOGIN 只能创建/维护供应商 type=4 账号和角色，不能更改平台管理员密码、类型、权限或菜单；平台登录时间/次数仍可更新。它不是供应商之间的行级隔离替代品，不授予业务权限，也未在生产安装。
- 本机真实 PostgreSQL：六文件后台 HTTP/鉴权回归 **135/135**；独立 LOGIN 的共享账号表保护 **25/25**；真实双连接 HTTP 选路、配置写权限拒绝与连接关闭 **1/1**。所有对应测试库均已清理为 0、服务器停止。两套 Worker TypeScript 检查通过。
- 首次普通模式 HTTP 回归因夹具需创建 NOLOGIN 角色而在初始化失败，已定位 `permission denied to create role`；只在新建临时集群启用维护测试模式后复测通过，没有提升已有环境权限。
- 本地 `wrangler.toml` 候选配置已指向两个新绑定，但**没有部署**。业务 GRANT 清单、新连接完整业务验证和正式发布门禁完成前，不可运行生产 deploy。

候选 `7245841` 的 [CI 35553068667](https://github.com/cinagroup/cinashop/actions/runs/35553068667) 最终不是成功：分片 1 成功，分片 2 在持续执行时达到 40 分钟上限被取消；UniApp 的安全断言完成后进程未退出，到 20 分钟被取消。其余四端、workerd、独立 PG 目录和密钥扫描通过。
本地诊断复现 Vite 关闭后的两个 `FSEventWrap` 残留；测试进程增加真实 watcher 的退出期清理（不替换文件访问或安全断言、不强制退出、不跳过测试），随后完整 UniApp 工具链 **396/396** 自然退出。
分片总预算调整为 60 分钟，单项测试时限、全部用例及精确零跳过覆盖检查保持不变；仍需新候选 Linux CI 证明，不把本地通过写作 CI 通过。
只读脚本 `audit-runtime-table-access.ts` 提供源码表操作证据，但明确不完整、不可执行；动态表、BaseDao 和行锁列权限仍需人工核对，不能把它自动转换为生产 GRANT。

完整本机 workerd 运行时回归 **19 文件 / 340 项通过**。共享权限组合扩展到运费生命周期与企业微信父键包络，仍只接受两套精确计价能力 OID；默认 isolated 不变。组合测试先发现 `pg_get_*` 指纹受调用者 `search_path` 影响，修正为仅在目录读取期间设置既定路径并恢复，最终 **12/12** 原生 PG 测试通过。
`runtimeBusinessPrivilegePlan.ts` 目前仅为**不可执行草案**，导出 `RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY=false`，没有生产执行器。尚需核对行锁、upsert、通用 DAO 和完整业务路径；不得凭表/列存在性检查就宣告可切换。

### 11:32 权限草案与真实 LOGIN 业务验收检查点（仍未切换）

- 源码清单补充 import 别名及 `onConflictDoUpdate` 证据；人工追踪 supplier/kefu/queue 的复用服务，补上投影 watermark、缓存/商品描述 upsert、供应商打印/面单操作记录及动态活动删除等权限。源码扫描仍不宣称完整调用图，也不自动生成生产授权。
- 发现砍价自提和 Out 优惠券停用仍直接锁 `system_config`，已改用既有精确计价锁能力；后者已先持有优惠券目录互斥锁，配置 SHARE 锁同样阻止 UPDATE、DELETE 和幻影 INSERT。配置仍只读，没有通过授予配置 UPDATE 修补功能。相关原生 PG 并发/业务测试 **92/92**。
- 新增 `runtimeLockOnlyBoundary`（尚未生产安装）：对仅用于行/表锁的目录权限拒绝语义 UPDATE，抽奖库存仅允许既有 `total` 计数变化。SECURITY INVOKER，不提升身份；缺失、定义/属性/ACL/触发器漂移不自动修复。
- 完整草案在自有临时原生 PG16、两个独立 LOGIN 下通过商城下单/重放、线下余额支付/重放、缓存 upsert、Out 优惠券创建/停用；没有使用生产数据，没有对外请求。新增只读审计逐表/列/序列比较实际有效权限，并验证角色身份、共享账号保护、锁专用保护和精确计价能力。额外表权限、配置列写权限、序列授权转授、跨 schema 数据权限均能被识别。此结果**不是全部业务覆盖证明**。
- 最终联合原生 PG 验收 **28/28**；对应测试库余数为 0、临时服务器停止。完整 workerd **19 文件 / 340 项**、两套 TypeScript、普通单元 **27/27** 通过。
- 首次新业务用例因 Drizzle 将数组展开为 record 的 SQL 写法失败，已改为显式参数 IN 列表后复测通过；一次 workerd 命令误写不存在的配置文件名，只启动失败，使用实际配置复跑通过。未据失败结果执行生产 GRANT 或修改线上数据。
- 当前仍保留草案开关为 false；**尚无新业务授权的生产执行与新 Hyperdrive 业务验收结果**，不可合并或部署此检查点。主站仍在原连接上运行。

1. 已完成受控安装 19 个共享索引及 0155–0160 协议、独立复核和业务数据摘要。
2. 完成逐业务表/列权限清单。商城身份不能获得计价配置写权限；后台身份不能仅凭 URL 获得，须在 JWT、账号状态和路由权限全部检查后选择。回调/队列也需要经过相应权限验证。
3. 新 Hyperdrive 下验证实际业务权限、精确协议及拒绝用例，而不仅是角色可登录。
4. 当前不可变候选全量 CI 及上述门禁通过后，合并 main，按同一提交协调部署 API 和五个 Pages；线上测试通过后才清理已完成分支。保留旧连接和部署版本，不假设未经兼容性验证即可回滚。

Cloudflare/Wrangler 技能用于独立配置、临时短期入口及回读/清理；PostgreSQL 技能用于最小权限和有界事务。没有使用 `GRANT ALL`、历史 `runAll`、清库、扩大线下退款范围或修改域名来绕过条件。
