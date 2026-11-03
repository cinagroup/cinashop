# CI 来源后继与静态 SQL 声明审计

本轮以本地 `53f212ddf1a1025c19642c92be795d5c245af483` 为基点，修复合并后来源证明与静态 SQL 声明读取。用户对上一轮具体私有供应计划的答复是 **“暂不执行远端操作”**。该计划已标记 deferred；本轮不改仓库可见性、environment、deploy key 或 secret，不发送凭据、不推送原 PHP 仓库或消费仓库。固定原库、55 项待持有人核实的内容及再分发边界仍按[原输入合同](legacy-php-ci-input.md)处理。

## 合并后的完整来源后继

新增 `post-merge-source-binding-20261103.json` 和受限测试读取器，固定当前完整文件为 53f212dd 的真实字节，再按已核 Git 提交的精确逆编辑还原 `3d4780a6a5816934f7b82b31132c0111a5f5065d` 的完整图：

| 当前真实文件 | 精确逆编辑数 |
| --- | ---: |
| view/uniapp-ts/package.json | 5 |
| view/uniapp-ts/src/pages.json | 1 |
| workers-ts/src/routes/v1/index.ts | 3 |
| workers-ts/package.json | 1 |

六个真实历史提交为 b874c56a、a8a57da7、fc7d61e3、fdefefe7、26a43cc7、20f180ae；fixture 保存每笔 parent 与前后摘要；另外保存四个当前文件及其 3d4780a6 前驱的完整正文。Worker package 的唯一后继是既有 postgres vendored tarball；本轮没有修改任何实际 package、锁文件、页面或路由。

新读取器位于已有合并／Uni CI／PHP CI 历史读取层之下，只改 PHP 输入 helper 的一个真实 import 行。原三份证明、旧断言及旧 hash 原样保留；不向旧 metadata 字符串做全局替换。全部当前来源与完整前驱必须匹配，拒绝前缀／后缀漂移、旧图回退和伪造 proof；无关路径、FD、当前直接读取与真实 Git 原文继续使用真实文件系统。它只提供历史来源连续性，不代表当前 API 行为或生产安装证明。

23 项新用例核对整份 proof、四个当前完整图、逆编辑与全部前驱、三份旧证明字节、单行接线、字符串／URL／byte-path 读取，以及漂移和伪造拒绝。全部 153 项既有热词来源用例恢复通过，其中包含上轮失败的四项；没有删断言或重新生成旧来源 pin。

## SQL 字面量与安装范围

原审计直接对 TS 源码做 SQL 解析，无法读取 customerCityDelivery.ts 中 JSON 转义的完整字符串。本轮用 TypeScript AST 的 literal.text 解码**顶层 exported const SQL／*_SQL 字符串及无插值模板**；记录文件、symbol、行列和原始区间。不导入迁移模块、不执行被审阅的迁移 TS，不求值表达式或猜测插值。

只把可证明的字面量追加到声明扫描，原 raw TS 结果单独保留。已覆盖的注释、普通消息／字符串及单引号 SQL 值反例不晋升为声明；这不是完整 SQL 词法证明，dollar-quoted 等未覆盖形式不能由这些反例推断安全。可变、调用、引用、拼接、缺初始化器及 SQL 插值报告 unresolved；DO／EXECUTE format 中的插值同样保留未知。解析出错拒绝。范围是有界补充，unresolved 列表并非穷尽。

JSON 的 declarationScan 明确：

- interpretation=declared-source-not-installed-catalog；
- installationEquivalenceProven=false；
- completeStaticSqlExtraction=false；
- unresolvedListExhaustive=false。

默认 raw-source 模式即使将来表差异和已知 unresolved 为空，也不能越过安装合同门槛。明确的自包含 TARGET_EMBEDDED_MIGRATION_SOURCE 原始 SQL 覆盖保留既有语义，既不当 TS 解析，也不宣称安装事实。实际数据库复制／计划命令和生产迁移源码、SQL、grants 未改。

14 项新用例包括正向静态值、错误／动态反例、真实同城 SQL 全字节与三表列／PK，以及实际 CLI main 的自有 SQL 覆盖。真实同城值必须与独立外部 0173 SQL 完整一致，不能只按表名计数。

## 最终验证与保留失败

final-06 六阶段完整执行 742.80 秒；预列 8598 输入在每阶段不变。两套完整类型配置分别通过，未提高既有 8192MiB 上限或 600 秒单命令／1200 秒整组预算。单层共享串行锁、Vitest 单 worker 且禁止文件并行。

| 阶段 | 实际结果 | 秒数 |
| --- | --- | ---: |
| Worker unit 类型 | exit 0 | 203.55 |
| Worker runtime 类型 | exit 0 | 102.78 |
| 完整固定 PHP 输入 | exit 0 | 8.81 |
| 九个完整测试文件 | 312 通过／1 既有失败，零跳过 | 120.69 |
| 真实 schema CLI | exit 1，保留等价失败 | 2.96 |
| 真实原生完整分组收集 | exit 0 | 304.02 |

最终 313 项只计一次：312 通过／1 失败，零跳过；新增 23＋14 全通过，153 热词全通过。唯一旧来源 pin 的完整失败内容与 final-02 相同；前一轮的精确 f2 基线证据保留，本轮未另称重跑该基线。

实际 schema CLI：外部 287／Worker 声明 364，raw TS 声明 361；外部 only 从 3 变为 0，Worker only 仍 77，列／PK 差异 0。本次得到 36 个静态字面量补充，报告 536 个已知 unresolved；这两者都不能证明完整提取或安装。CLI 仍 exit1，未忽略 77 表或把失败管道记绿。

实际 Vitest 收集 1652 文件各一次、826／826 完整互斥分片、固定角色 58 文件串行。这里只是 collection／配置核对，没有执行全部 1652 测试文件，亦不是旧 10 秒容量用例恢复通过。

final-01 的三来源 proof 还缺 Worker package 后继、final-02 的 600 秒 combined typecheck 超时、remainder-04 的新测试 TS2554，以及 final-05 的新测试 TS2345 均保留。仅修复新测试的严格 UTF-8 解码／必填 ignoreBOM 选项和 stdout 的结构化 write 视图，原 Buffer.equals 全字节／列／PK 断言不变。最终是两个独立完整配置通过，不宣称原 combined 命令已经重跑成功。

先前 listFilesOnly 只用于输入成员诊断：候选 5027／基点 5023，规范化 realpath 后依赖各 869、无重复，只增加四个 TS 文件。这不是类型通过或超时因果证明；早期未规范化的跨根路径差异原记录保留。

完整日志／冻结清单／失败／Git 后继核对／后续 cohort 地图保留在本机 .cache/php-ts-phase54-validation。四个来源层文件经另一作者只读交叉复核；三个 schema 文件由其编写并由主流程另读，新增两处窄类型修复另审。不是全量独立重跑或安全审计。两份文档在所有重验证终态后补；最终九个提交文件另扫秘密并核对暂存／提交字节。

## 剩余工作

既有 data-migration 的 customerWriteoffOperation.ts 整体来源 pin 仍失败。只读 Git 核对显示 d715da71 的差异是约束名 cwo_pk → customer_writeoff_operation_request_pkey；下一步应保留历史 pin，再证明当前完整来源与这一精确后继，不回退生产 SQL或直接刷新 hash。

此外，原 301／305／310／312／315／319／320 声明层之后增加了 41 表（22 Admin、19 账号／归属／履约）；不能把旧 320 直接改为 361。只读清单已定位 33 声明模块及 31 owner 文件，尚需封闭当前 cohort 和各自安装合同。外部 287 表、注册 bootstrap 283 表、同城独立 3 表及 abandonment 1 表应在真实构造语义下组合核验；全部 TS 文本声明不能冒作 runAll 已安装。

固定角色完整原生收集仍慢，既有容量测试的 10 秒子进程／15 秒 case 期限未提高，也未删实际 collection 或改成假清单。已记录 Vitest 4.1.12 extends:true 多次加载根配置的候选成本，尚未 profile／验证因果，不能当作修复。

完整归属维护 manifest／单次许可／原子切换、其他通知作者／角色／非微信发送及整体迁移继续未完成。没有生产 DDL／Env 切换、部署、真实微信或 Browser／Workerd／Hyperdrive 验收；用户／UID／权益／旧单／付款保持，未知归属不猜，跨 AppID 屏障与 runtime_ready=false 保留。
