# 实际安装后的 public 目录观察

用户“暂不执行远端操作”的决定持续有效。本轮在本地6ae2bf97基点上补充真实PG16安装观察；不推送、改动GitHub可见性／环境／凭据或部署。

## 构造合同

实现入口为 [installed-construction-audit.ts](../scripts/installed-construction-audit.ts)。

新增离线诊断入口仅接收 `--profile pg16-public-external0184-runall0184-city0173-abandon0174-raw-v1 --json`。目标URL仍使用现有严格校验，只允许专用回环测试服务finance_test/cinashop_finance_test，连接后核实际服务身份／版本／地址，再创建并记录随机测试库和专用NOLOGIN维护角色。此测试维护服务的超级用户权限不代表应用运行角色获得该权限。

external路径实际依次运行全部182份已核注册SQL，形成287表；embedded路径实际调用MigrationService.runAll的185步，形成283表，再使用既有受限city三表和abandonment一表显式构造，形成287表。沿用独立名称清单、完整来源pin、既有对象保留及重复安装拒绝；不自动安装其他维护附加表、不把ORM 292表或其他完整auditOrmDdl路径混成这个方案。两条构造全部完成后才各自在REPEATABLE READ READ ONLY事务读取目录。

## 比较范围及拒绝条件

旧5类reader和合同不变。新增12组观察：物理列顺序／丢弃列、关系属性、完整函数／过程、全部触发器、视图／规则、RLS策略、对象owner、ACL、默认ACL、相关角色配置、PG16角色成员授权以及未知对象清单。保留默认值、函数正文和security/config、触发器O/D/R/A状态／内部标志／条件／参数／约束父子关系、真实角色／grantor／grant option；不读取密码、业务行或不加区分导出全局角色。角色读取从public owner／ACL／policy／默认ACL和当前库owner出发，包含双向成员闭包及授权人。public-specific默认ACL均读取；global默认ACL仅限该闭包中的owner。成员grantor仅保留其属性，不因此遍历它的无关全局默认授权；不宣称所有数据库／全局权限覆盖。

列ACL原样传给PG16 strict aclexplode：NULL返回零行，外层聚合得到空entries；合法一维零项ACL仍可读，aclIsNull保留NULL与非NULL区别，不用SQL零维空数组补造。

对象OID和含OID的原始SQL节点树另列identities，仅供观察，不将数据库分配的数字直接当结构差异。函数正文中原有的OID数字不会因此删除：prosrc和functiondef仍整段比较。实际角色名、函数正文、pg_get_functiondef和内部外键触发器名不作替换、裁切或后缀归一化。触发器OLD/NEW条件由完整pg_get_triggerdef保留；不对NEW的varno=2错误调用pg_get_expr。存在未知public对象时，即使两边未知清单一致，也拒绝equal。未提供type ACL语义读取；任何非NULL public typacl（包括自动rowtype的显式授权）也作为未知拒绝。域／枚举／独立类型、聚合／window等未模型化过程、扩展、operator／opclass／opfamily、collation、conversion、extended statistics、全文检索及非视图默认规则等显式入未知清单；该清单不是全PostgreSQL所有对象种类的覆盖承诺。

所列字段完整性／重复key／关键boolean与number及ACL形状先校验，再逐key精确比较。relhasindex等目录属性属于原始观察，不能将本命令称为语义权限等价证明。仅当前观察范围零差异且无未知对象时命令exit0；这也不改变fullInstallationEquivalence／wholeInstalledCatalogEquivalent／effectivePrivilegesProven／runtimeCommissioned／wholeMigrationReady的false状态。不可把保存的JSON作为新一轮构造验收输入。

命令前后核自有src／scripts／migrations／test/helpers／test/fixtures和包／类型配置文件，记录每份字节与摘要、Node实际可执行文件及postgres／drizzle-orm／tsx包元数据；拒绝该源清单中的symlink，并要求前后相同。这不是全传递依赖文件或供应链认证。清理只处理本次成功CREATE后记录的库／角色，尝试全部对象，逐项复核不存在；cleanup未确认则不返回成功报告。没有FORCE／通配删除或终止其他会话。

PG16会把superuser发出的成员授权记在bootstrap角色名下（[官方GRANT规则](https://www.postgresql.org/docs/16/sql-grant.html)）。新原生范围反例先把本次随机测试库临时改给独立NOLOGIN owner，再查询pg_auth_members取得实际bootstrap grantor（本地／CI名称不同），不硬编码名字，临时向另一个新建孤立NOLOGIN角色添加该grantor的全局默认SELECT。测试要求真实默认ACL存在、grantor属性保留，但无关global默认ACL及其identity不进入范围、孤立角色不进入roles；随后逐项独立尝试撤回该新grantee授权／成员授权，恢复本次库的原finance_test owner，删除并核验两个新角色均不存在。不新建superuser、不修改真实应用角色。

## 实际终态验证

首批pure-01在unit类型阶段214.80秒因新测试样本的TS2352失败，后续阶段未执行；完整失败日志保留。终态后改用显式Record初始化，并收紧两处global默认ACL owner范围，新增真实bootstrap授权反例。最终pure-02完整六阶段800.53秒、final-05 PG／reader／类型三阶段471.02秒（PG文件167.60秒）。pure预列8613输入、final预列8616输入分别每阶段不变；共有输入仅原生case正文后继、reader两处SQL别名引号及列ACL输入、对应pure断言，另增三份验证driver。final-03完整unit类型曾通过，但PG因未quoted camel别名得到1通过／3失败、CLI无JSON；fixture0／STOPPED，完整失败终态保留。final-04类型204.05秒和reader31曾通过，PG161.71秒又因补造零维空ACL数组得到1通过／3失败、CLI无JSON；清理同样remaining0／STOPPED，后续去掉补造数组并精确更新原有pure断言，不累计这轮那1通过。该改动适配本地与CI不同bootstrap名，以实际grantor和临时独立库owner构造边界，完整前后源图已保留、case外前后缀及导入均不变。此前单元中794项及runtime类型／原证／旧CLI结果限定复用，reader31以最终重跑替换；最终图另重跑完整unit类型、reader31及整个PG文件，不把修复前图称作最终全图重验。单层共享锁，pure显式单worker／禁止文件并行；PG只运行一个完整文件且单worker。原8192MiB类型预算、600秒单命令／1200秒整组保持。

| 阶段 | 实际终态 | 秒数 |
| --- | --- | ---: |
| Worker unit完整类型（pure图） | exit0 | 218.06 |
| Worker runtime完整类型 | exit0 | 103.47 |
| 7个完整单测文件 | 825通过／0失败／0跳过 | 155.43 |
| 完整固定PHP输入 | exit0 | 11.01 |
| 真实旧schema CLI | exit1，保留旧声明／安装差异 | 2.84 |
| 实际原生分组收集 | exit0 | 309.71 |
| 扩展目录完整PG16文件 | 4通过／0跳过；remaining=0／STOPPED | 167.60 |
| 读取器最终图31项 | 31通过／0失败／0跳过 | 99.64 |
| Worker unit完整类型（最终图） | exit0 | 203.78 |

最终仅计829次成功执行：单元825（复用794＋最终reader31）＋实际PG16四例；新增51＝reader31＋CLI准入16＋PG4，不累计首批失败／前轮用例。现有data-migration36、literal14、旧目录8以及完整runner／unit-gate回归同时运行。两套类型各自完整配置通过，不表示执行了全部Worker runtime或全量业务测试。

实际原生收集1657文件各一次，829／828互斥完整分组，固定角色58文件配置串行；此前58文件集合保留，仅允许新测试入口增加。该收集在仅原生case正文可移植修复之前完成；文件名与native case外测试字节／导入关系未变，reader另有上述两处SQL别名引号与列ACL输入后继，pure只更新对应原有断言，没有再次全量收集。该证据仅collection／配置，不是1657文件全部执行或旧10秒容量用例恢复。

### 两次真实构造观察

| 入口 | PG版本号 | 源码前后相同 | 已确认清理 | JSON字节 |
| --- | ---: | --- | --- | ---: |
| INSTALLED_PUBLIC_CATALOG_API | 160014 | True | True | — |
| INSTALLED_PUBLIC_CATALOG_CLI | 160014 | True | True | 17065521 |

两次都实际执行external182／embedded185，再显式city＋abandon达到287／287表；旧5类均零差异，但扩展观察保留以下真实差异。数值是reference-only／candidate-only／changed，不推断语义等价或自动消除差异。

| 观察类 | API | CLI |
| --- | --- | --- |
| columnAttributes | 0/0/49 | 0/0/49 |
| relationAttributes | 0/0/0 | 0/0/0 |
| routines | 0/0/2 | 0/0/2 |
| triggers | 272/272/0 | 272/272/0 |
| views | 0/0/0 | 0/0/0 |
| policies | 0/0/0 | 0/0/0 |
| objectOwners | 0/0/2 | 0/0/2 |
| acls | 0/0/56 | 0/0/56 |
| defaultAcls | 0/0/0 | 0/0/0 |
| roles | 2/2/0 | 2/2/0 |
| roleMemberships | 0/0/0 | 0/0/0 |
| unsupportedObjects | 0/0/0 | 0/0/0 |

未知对象计数API {'reference': 0, 'candidate': 0}、CLI {'reference': 0, 'candidate': 0}；两次equal=False/False、fullInstallationEquivalence=false。实际CLI因原始差异exit1，原生用例验证该真实非零状态，不跳过或伪装安装等价为绿。未知清单为空也不升级为全PG对象／语义权限证明。

完整日志、actual summary、前后输入／工具字节、批次终态和只读交叉复核在本机.cache/php-ts-phase56-validation。原始目录在真实API／CLI调用中读取并比较，stdout JSON在CLI用例内实际解析；缓存summary不作为下一次安装验收输入。实现由两位作者分别编写并交叉静态审阅；没有全量独立重跑或安全审计。两文档仅在完整验证终态后补，八提交文件另做秘密扫描和暂存／提交字节核对。

## 后续边界

旧schema CLI的77个Worker-only声明、536个已知未求值项以及完整提取／安装标志继续保留；本profile不覆盖31份额外维护安装器的所有入口、运行角色commissioning、完整依赖／归属manifest／单次许可／原子切换或其他业务迁移。私有旧PHP供应与新SHA云端CI因用户远端暂缓而未执行。用户、UID、权益、旧单／付款及跨AppID屏障继续保留，未知归属不猜，runtime_ready=false。
