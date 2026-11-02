# UniApp 定向依赖升级与 D3 来源合同 — 2026-11-01

本轮接续 `fcfaaf40e517b63e849dcd17bdcb02dc6e5a3ac0`，处理迁移验收中的 UniApp 公告检查与真实消费者兼容性。没有修改支付、用户、权益、订单、数据库权限或部署配置。整体 PHP→TS 迁移、TEST-004D3 的可选模式和设备边界仍未完成。

## 实际报告与修复范围

既有 [b19 的 UniApp CI](https://github.com/cinagroup/cinashop/actions/runs/41295584357/job/124816017584) 在 live D3 报告 `invalid vulnerability entry centra`，三端构建尚未执行。相同错误也见于 a2 的 run41289941301/job124799173850。该历史任务没有保留完整原始报告，本轮不能据此判断具体失败字段。

本轮采用与 CI 相同的 Node24.14.1/npm11.11.0，执行获授权的官方 lock-only audit。原依赖图实际返回66条，原始45429字节，SHA256 `c0048770f8b3cda65a879343352b2191e75b1dafed7d26f3c5e46ed4de2821ea`。其中没有 centra，新增来源为1244003和1244012。审计前后 package/lock 字节不变。随后定向升级并重新采集的报告仍没有 centra；历史错误原因保持未确认。

- `follow-redirects` 采用官方1.16.2，解决 [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p)。测试固定全部7个官方文件与实际 load-bmfont→phin3.7.1→Centra2.7.0 解析。反转[官方修复的两处片段](https://github.com/follow-redirects/follow-redirects/commit/b0a7751e9cd64cd8eeb6ec67d2f206a9cc88d3f8)，可恢复与官方1.16.1完整 index.js 相同的字节，再在两个回环 HTTP 服务中重现原跨 realm 数组泄露。新版本对普通和跨 realm 数组均剥除跨源自定义及内建凭据，保留无害头及同源凭据行为，实际 Centra 也使用修复后的依赖。
- 仅 `unplugin-auto-import` 的两处安装与 `@vue/language-core` 从 minimatch9.0.9 转到官方11.0.1。固定全部37个官方文件，执行两个真实插件的 CJS/ESM 热更新、正负目录匹配、Windows 斜线字符串和 Vue 实际模板属性生成。优化器案例只用32/64个模式，不执行默认100000或压力样本。[官方公告与修复](https://github.com/advisories/GHSA-g3hv-75wg-m249) 指向11.0.1。
- Glob7/TestExclude6 保留 callable minimatch3.1.5。其全部4个文件与官方包一致，源码没有该公告描述的 `firstPhasePreProcess`、`secondPhasePreProcess` 或 `optimizationLevel` 机制，真实 sync/async、ignore、dot、否定匹配继续验证。npm 的 `<11.0.1` 版本范围告警仍然存在；这不是官方 fixed3.x 或一般安全结论。[范围澄清仍开放](https://github.com/github/advisory-database/issues/10811)。

没有全局 minimatch major override，没有升级 DCloud 配对版本或替换原 Vite/Intlify/Jest 源码回补。锁变化仅为上述消费者及其必要子依赖、follow-redirects，以及 root balanced-match 的关联 dev 标记。安装验证使用 `npm ci --ignore-scripts --no-audit`。

## 严格清单与可重放来源

升级后原始42699字节，SHA256 `61f479703abab30377eefdf176d519d393a709c8e0cd2724813b78afafc3dc19`。报告为62条受影响包记录（info0/low4/moderate28/high30/critical0）、26个直接来源、25个 GHSA URL；8个定义中7个活跃。这些不是独立漏洞或可利用问题的数量。

原25个直接 tuple 与23个已解决/撤回/替换来源记录逐字段保留。新增1244003禁回规则；新增1244012只允许 root `node_modules/minimatch`，其闭包为14个新增和6个既有条目。三个已升级节点及其上游不再进入该闭包。不存在过滤未分类包、放宽 severity 或接受空 via 的分支。

门禁只把原先合并的入口判断拆成静态字段诊断；接受域不变。锁指纹、直接来源/URL/severity/range、全部安装路径、forward edges、派生链和元数据一致性继续逐项校验。完整旧基线、具名 old/new delta 和官方文件清单由以下文件绑定：

- [完整机器审查](../audit/uni-d3-consumer-upgrades-20261101.json)，原始字节 SHA256 `cd2b62eefb5c2f43a6029a504963d248ff6bf9461c1364aac10d1679560b28d8`。
- [冻结旧基线](../../view/uniapp-ts/scripts/d3-advisory-gate.pre-consumer-upgrades-20261101.baseline.json)，SHA256 `7790eafd184b534236d93d81b51412b30c80fb42211e0c441fbed4a0c98dcdf6`。
- [minimatch 官方文件回执](../../view/uniapp-ts/vendor/minimatch-official-source-20261101.json)与 [follow-redirects 官方文件回执](../../view/uniapp-ts/vendor/follow-redirects-official-source-20261101.json)。

当前 raw lock SHA256 为 `781507e6d3f23f0597807fe02c2bed99c458522ae1d4763d37720caed3808d13`；门禁使用跨换行的 semantic SHA256 `f0d1ebaf5e0c8e45f635c2118d2ce6c0e9f0cda2d179d593d0031effa55abf5a`。四份新增固定哈希 JSON 另以精确 `.gitattributes` 路径保持 LF。

## 本地验证及失败记录

全部重验证采用共享串行锁、Node24.14.1/npm11.11.0。原工具链首100文件按排序清单分10组，随后23个 npm 子命令逐项执行；静态审查核对无遗漏、额外项或重复分组。单阶段600秒和原用例限制保留，拆组增加聚合可用时间。没有改变 CI 工作流的20分钟预算。

| 检查 | 最终可用证据 |
| --- | --- |
| UniApp 类型 | full-02 exit0 |
| 工具链首100文件 | full-02 全10组 exit0，2723次用例执行 |
| 原23个后续工具链命令 | full-02 全23组 exit0，1029次用例执行 |
| adm-zip / Express-qs / Jest-jsdom-once | full-02 分别6/21/4通过 |
| H5 / Weixin / App资源构建、产物 | full-02 全三构建 exit0，产物4通过 |
| 当前 D3 离线及 live | final-03 94通过，live覆盖62条/26来源/25 URL/8定义 |
| 实际 QR、资源图 | final-03 分别5/13通过；含原始 PNG/JPEG 与四个实际编译图 |
| Uni / PC shared toolchain | final-03 分别14/16通过 |

表中是原脚本清单的执行计数，原脚本在不同任务重复执行的相同测试也照计。它不是互异测试的数量，也不包括早期失败、中断及额外重跑。

`full-01` 在大型整包工具链期间主动中断，终态130，不计完整通过。第一次 D3 离线为92通过/2失败：CLI旧断言仍写48，sprintf历史测试仍假设旧排他包名永不重现；修正为当前62和来源专属旧路径后94通过。原来源禁回规则保留。

`full-02` 前42阶段退出0，第43阶段 QR 为4通过/1失败，因此整批失败，runtime/common未执行。原因是 D3 测试重复写入清单包名，触发既有禁止远程调试路径的文本扫描。去掉这处冗余字面量后，完整 review SHA、六项具名 old/new 和整个 baseline 深比较仍保留；QR 扫描和例外名单未变。

`final-03` 随后重跑当前 D3/live、QR、runtime及 Uni/PC common，五阶段全退出0，用时138.18秒。与 full-02 的1044项声明输入相比，只改了 D3 测试；类型、完整工具链、三端构建及产物检查复用其不变输入。full-02 的1044项从头不变，运行中补充的8496项快照结束核对不变；final-03 的8495项从头不变。补充快照在运行中采集，不冒充 pre-run 证明；冻结范围为所列源码、锁、工具入口及监督脚本，不包含整个安装目录与环境。

完整原始报告、监督计划、各阶段 stdout/终态、失败与中断日志、哈希和独立静态审查均在本地 `.cache/php-ts-phase37-validation/`。文档与换行属性在上述执行结束后补齐，提交文件另行做秘密扫描；不将最终文档字节说成已被上述命令执行。

## 未完成边界与下一步

本机 full-02 在 QR 终态前用时1286.67秒，不能证明 GitHub 原20分钟总预算通过。精确新提交的 Linux CI 尚待推送后验证，既有 CI 失败记录保留。PC 仍使用1.16.1，其新重定向公告未在本轮解决；PC/Kefu 的整树审计缺口也未关闭。没有 native Windows、真实设备、真实供应商请求、生产 DDL 或部署结果。

用户已确认后续门店规则：**仅后台受控分配到门店，并保留不可变分配回执**。本轮未实现该作者。下一步需真实后台下单/原付款/分配作者→Manager 整单发货→既有 outbox/Queue/App 首上传；技术设计优先保留平台根单与原财务、库存事实，使用专用履约证明与入口，继续保留通用财务归属检查。该技术设计仍需实现和原生验收，不能把已有有效店长身份 bootstrap 或种子订单说成新业务作者。
