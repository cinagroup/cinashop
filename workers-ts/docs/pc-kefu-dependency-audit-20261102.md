# PC / Kefu 完整依赖审计后继

本轮从已推送并直接核对远端的 `64bfb958e3ae27216036cb028c2c1a4e1a58386d` 继续。日期和远端运行时间使用 UTC。本轮没有业务页面、API、SQL 或工作流变更。

## 实际失败与修复范围

前序 `20f180ae` 的 [工作流](https://github.com/cinagroup/cinashop/actions/runs/41395985908) 中，PC 完整审计报告 3 moderate / 2 high，Kefu 为 3 moderate；链为 language-core → minimatch，以及 PC axios → follow-redirects。两端构建成功不代表审计成功。`64bfb958` 的 [工作流](https://github.com/cinagroup/cinashop/actions/runs/41403092386) 也在相同完整审计步骤失败，本轮不把这些旧失败改写成通过。

两端仅新增 `@vue/language-core: { minimatch: "11.0.1" }` 父包限定 override；PC 的 follow-redirects override 从 1.16.1 改为 1.16.2。锁闭包精确为 minimatch 9.0.9 → 11.0.1、brace-expansion 2.1.7 → 5.0.12、balanced-match 1.0.2 → 4.0.4、新增 @isaacs/nonrecursive-glob-match 1.0.3，以及 PC follow-redirects 的后继。所有新记录使用官方 npm URL / SRI。

PC 恰好 5 条记录变化，Kefu 恰好 4 条；其余 187 / 160 条记录（含根记录）和锁顶层完整不变。Vue 3.5.42、vue-tsc / language-core 2.2.12、TypeScript 5.9.3 和 PC axios 1.20.0 保持。没有全局替换 minimatch、强制 audit fix 或升级编译器；language-core 原声明 `^9.0.3` 没有改写。实际 CJS 消费者使用 `.minimatch` 命名接口。brace-expansion 5 的 Node 20 / >=22 要求由既定 Node 24.14.1 满足；保留两包的 BlueOak-1.0.0 官方许可证。

## 实际消费者与检查接线

新增公共测试从各端当前目录的实际 language-core 解析 minimatch 及其闭包，不借用 Uni 的 node_modules。核对实际版本、官方锁 URL / SRI、父包限定 override，并借用已提交的官方归档 receipt 核对 minimatch 11.0.1 完整 37 个源码文件字节。真实 `generateElementProps` 验证 data-* 过滤、aria-* 保留原名、空配置仍生成 camelCase，并观察真实命名匹配调用。CJS / ESM 的 32 / 64 有界 optimizer 与普通 glob 正反例也执行。

PC 重定向检查采用与 Uni 相同的 1.16.2：同 / 跨 realm、object / array headers、同 / 跨 origin 的 8 种内部组合，既验证敏感头剥离，也验证普通头和同源凭据保留。传输仅为本机 loopback，无真实凭据。

新测试只经现有 `toolchain-security.test.mjs` 条件接入 PC / Kefu。原 CI 的锁文件安装、公共检查和 `npm audit --audit-level=low --registry=https://registry.npmjs.org` 完整门槛保持；Admin / Supplier 不受新 major 断言影响。

## 本地执行与证据边界

使用 Node 24.14.1 / npm 11.11.0，所有 npm / Node 验证经单层共享串行锁，单 worker、每命令 600 秒 / 整组 1200 秒限制。先复制任务内已有官方公共 npm 缓存，在独立缓存中离线生成最小锁后继并 reify 现有安装；源公共缓存逐文件不变。第一次在 npm 版本预检因 user / global config 同为 `/dev/null` 被拒，安装尚未启动、锁未变；使用两个不同空配置文件后继续，原失败留存。

离线 validate-03 完整通过，49.94 秒，8542 冻结输入不变。它证明已有安装的后继，不当作 fresh npm ci 或 live audit。

随后 fresh-04 实际执行两端 `npm ci --ignore-scripts --no-audit --no-fund`，完整官方 npm audit，再执行当前工具链、测试和构建。全新安装成功，安装脚本未执行；完整审计包含开发 / 可选依赖，没有 omit、允许清单或严重度放宽。2026-11-02 本次官方报告的 PC 总依赖数 191、Kefu 163，两端 info / low / moderate / high / critical 全为 0。此结果只代表本次审计时点，不是永久无漏洞或新提交 CI 全绿声明。

fresh 批次 65.36 秒、8542 输入终态不变；PC 公共 19 项、Kefu 公共 29 项、PC auth / images 367 + 9 项、Kefu 5 文件 / 30 项及两端正式类型 / Vite 构建通过，共 454 次用例执行。另有实际 Uni 共享重定向 2 项通过，共 456 次选中执行；先前离线重复不再累计。没有为依赖改动重跑全项目 Worker、PG 或 Browser，也没有把第43轮浏览器证据作为本轮新结果。

日志 / 原审计 JSON / 冻结输入 / 精确锁差异及只读独立复核保存在本机忽略目录 `.cache/php-ts-phase44-validation/`。静态独立复核没有执行安装或测试，不冒充第二次独立执行。文档在验证后补齐，最终文件另做秘密扫描及暂存 / 提交字节核对。

截至本轮已读取的 `64bfb958` 远端快照，Uni 作者组 5 分 30 秒成功，core 组仍在运行；不以成功分组或本地时长证明完整预算。新提交远端 fresh 安装（含正常安装脚本）及所有 CI 终态仍需另行核对。完整归属 manifest、单次许可、原子 AppID 切换、历史绑定和整体迁移继续未完成。现有 UID / 权益 / 旧单 / 付款、未知归属不猜及跨账号屏障保持，没有生产 DDL、部署或真实提供方调用。
