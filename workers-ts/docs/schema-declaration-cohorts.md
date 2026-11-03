# 独立声明 cohort 与 writeoff 来源后继

本轮以本地 a03a52a119122615fbf5bd5c3a983dc6f60bb5cd 为基点，继续关闭来源和构造验收缺口。用户“暂不执行远端操作”的决定持续有效；本轮只有本地代码、验证、提交／main 快进和已合并开发分支清理，不更改仓库可见性、环境／凭据或推送。固定原 PHP 供应计划与 55 项待核实内容仍按[原输入合同](legacy-php-ci-input.md)暂缓。

## Writeoff 的精确来源后继

实际 Git d715da71abf6ce6f3dba6f2ee1b57e143744ebe3 的父提交为 4094ce1e033bdd8b4dc4ccf43da9057a76514228。该文件唯一差异是完整一行约束名：cwo_pk → customer_writeoff_operation_request_pkey；没有表、列或主键列变化。

新增受限读取函数先要求当前完整 15,653 字节与 05b10c0c… 来源摘要完全匹配，再逆转这一行，核对完整父图 15,619 字节和旧 044d8aa8… 摘要。旧 pin 保留在原 explicitDeclarations 中，仅该文件的历史声明断言接收逆推图；真实源文件、实际安装 SQL 和物理约束名均保持当前版本。不接受旧图回退、前后缀变化、其他约束／主键列或函数体变化，也不刷新未知 hash。

9 项测试核对真实当前图／完整父图、全部列和主键列、读盘源不变以及 7 个拒绝反例。实际父／子 Git 全文件差异另外由主流程直接核对，运行测试无需私有 PHP Git 历史或网络。

## 新增 41 表的独立声明合同

固定 fixture 基于 a03a52a1 的真实 Git：63 份唯一完整源码，共 813,071 字节，覆盖 33 个声明模块、31 份维护安装器源文件、61 个命名入口，以及 41 张表的有序列／主键（平台菜单文件兼具声明与维护入口，因此去重为 63）。主流程逐个 Git show 核对 fixture 正文、完整摘要和实际工作区字节。fixture 文件 SHA256 为 ae97e9e557a7bb669ea618e9b267fb4c001aba3cda1d051e3c7a1e41ffde5dae；不从运行中的 ORM／目录输出重算期望。

helper 固定整份 fixture／canonical 摘要并递归冻结数据，从真实文件读取后再核全图；TypeScript AST 只读取同一 literal segment 内完整闭合的 CREATE TABLE。33 个 SQL 声明均为插值模板，34 个未求值插值表达式保留各自正文／位置／语法种类，不拼接静态段，不把未知替换成空串，不执行迁移 TS 或输出可执行组合 SQL。这 34 处仅限所列 33 个 SQL 常量，不替代默认扫描报告的全源未求值范围。表结构、static segment 摘要、插值、真实命名 import、owner SQL 执行语句与入口范围都受固定合同约束。

两个真实原子 bundle 保留：Admin App 操作＋Native App account/evidence 三表，以及 Routine witness＋payment attempt 两表。平台菜单 receipt 还依赖独立 NOLOGIN capability owner／函数授权；单有 receipt 声明不证明权限就绪。全文件 pin 覆盖已列 owner 的正文，并非全传递依赖／调用图审计。

18 项新测试覆盖真实字节／41 表／列／PK、来源与入口清单、不可变 proof、精确 basename 筛选不会排除未知模块的合成清单反例、34 个未求值插值表达式、两 bundle、module／owner 漂移、伪造清单和 owner 缺失。该 fixture 始终声明 installationEquivalenceProven=false、runAllRegistrationProven=false、completeSqlEvaluation=false、unresolvedListExhaustive=false。

## 保留历史层，并单独验当前完整图

data-migration 保留七个历史声明层 301／305／310／312／315／319／320、旧表名清单和来源 pin。只有通过上述完整证明的 33 个精确 basename 可以从这些历史视图移出；未来未知模块仍留在旧视图，其中可解析的新增表声明会被旧／当前完整集合核对拒绝；这不涵盖任意动态 SQL，未求值范围和默认安装门槛仍保留。原全源 ALTER-before-CREATE 断言继续读取所有模块。

新增当前完整 raw 声明视图 361 表和静态 literal 补充视图 364 表：旧 36 个 TS-only 加新增 41 个，必须精确等于 77 个独立已知差异，且无重名。literal 解码补齐同城三表；所有新增 41 表都不进入既有 external／embedded／ORM 注册表清单。这只关闭已列声明归属，不是忽略差异或把声明等价当安装等价。

## 最终验证

pure-01 完整六阶段 728.32 秒，native-02 两个完整文件 290.67 秒；两批预列 8607 输入逐阶段不变且两批清单／字节一致。单层共享串行锁，单元批次显式单 worker／禁止文件并行；PG 每阶段只运行一个完整文件且单 worker，没有文件并发。原 8192MiB 类型预算、600 秒单命令／1200 秒整组保持。

| 阶段 | 实际结果 | 秒数 |
| --- | --- | ---: |
| Worker unit 类型 | exit 0 | 205.71 |
| Worker runtime 类型 | exit 0 | 102.00 |
| 4 个完整单测文件 | 77 通过／0 失败／0 跳过 | 110.52 |
| 完整固定 PHP 输入 | exit 0 | 7.04 |
| 真实 schema CLI | exit 1，保留声明／安装等价失败 | 2.81 |
| 真实原生完整分组 | exit 0 | 300.22 |
| invoice 完整 PG16 文件 | 19 通过／0 跳过，remaining=0／STOPPED | 147.01 |
| seckill／city／abandon 完整 PG16 文件 | 2 通过／0 跳过，remaining=0／STOPPED | 143.66 |

最终仅计 98 次成功：单元 77（新来源27＋原 data-migration36＋既有 literal14）和真实 PG16 21，零跳过。data-migration 的旧失败已恢复，七个历史层及当前完整集合同时通过；不累计前一轮或中间执行。两套类型是各自完整配置通过，不以此覆盖上一轮 combined typecheck 超时记录。

真实 PG16 使用新建、隔离的本地集群与实际维护／独立 LOGIN 路径。invoice 文件执行完整 external 182 文件、embedded runAll 185 步、ORM 实际生成与目录检查，对应287／283／292表；seckill文件另运行同城／abandon显式组合，并保留现有对象OID／owner／ACL与拒绝重复安装。两个宿主均验明fixture数据库／角色remaining=0且pg_ctl状态STOPPED。它们不证明这31份附加维护安装器均已安装、获得实际用户批准或完成生产部署。

实际 CLI 继续 exit1：外部287／Worker声明364，raw361；外部only0／Workeronly77／列PK差异0，36静态补充和536已知未求值项。默认完整提取／安装标志仍false，未忽略77差异或跳过失败记绿。

实际原生收集1654文件各一次，827／827互斥完整分片，固定角色58文件串行。这只是collection／配置证明，没有执行全部文件或证明旧10秒容量用例通过。

本轮只改测试来源／声明合同与文档，生产源码／迁移SQL／grants保持基点字节。完整日志／冻结／实际Git全图核对／静态交叉复核在本机.cache/php-ts-phase55-validation；3个cohort文件由另一作者编写、主流程完整另读并逐个核63 Git图，4个root文件经其独立只读复核，不称全量独立重跑／安全审计。两份文档仅在全部重验证终态后补，最终九提交文件另扫秘密并核暂存／提交字节。

## 后续边界

默认 schema CLI 仍须拒绝 77 个 Worker-only 声明及未求值范围；清单证明不能代替真实可比安装构造。下一步应基于实际 external 287、runAll 283＋独立 city 3＋abandonment 1 的构造合同，验证完整对象／列／约束／索引／函数／触发器／ACL／身份，并明确每组维护附加对象的准入，而不是全局忽略 77 表。31 份维护安装器源文件（61 个命名入口）不等于 31 个数据库 owner 角色或已安装实例，本轮没有因此自动安装附加对象或取得业务批准。

旧原生容量测试 10 秒子进程／15 秒 case 期限不变，完整收集仍慢；Vitest extends 根配置重复加载只是未证因果的调查方向。私有原库供应与新 SHA 云端 CI 仍因用户远端暂缓而未执行。完整归属 manifest／单次许可／原子切换、其他通知作者／角色／非微信及整体迁移继续未完成。

没有生产 DDL／Env 切换、部署或真实微信／Browser／Workerd／Hyperdrive验收；保留用户／UID／权益／旧单／付款，未知归属不猜，跨 AppID 屏障与 runtime_ready=false 保持。
