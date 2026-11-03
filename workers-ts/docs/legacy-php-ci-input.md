# 固定旧 PHP 原库作为只读 CI 输入

第53轮记录保留其当时状态；后续实际配置、传输中止和 CI 读口修复见文末第59轮。

## 第53轮完成时的历史状态

本轮为两个 Worker unit 分片提供完整固定原库检出和失败关闭的预检；没有修改生产业务源码、数据库协议或依赖。用户选择完整原库，并在检查发布范围后选择私有仓库、CI 只读访问。本轮本地实现及验证完成时，GitHub 的 `cinagroup/cinashop-php`（仓库 ID `1418182944`）仍是空的公开仓库，固定提交不在远端；私有化、环境规则、deploy key、secret 和首次原库推送均未执行。配置供应方和推送本轮消费者提交仍须明确授权，不能把本地成功当作云端检出证明。

此前提交 `f2a848eb6b8375b292de33df2937e9c091673662` 已按精确授权推送并直接核对远端 main。[其 CI](https://github.com/cinagroup/cinashop/actions/runs/41571731884) 在本轮最后 jobs 快照中为其他 10 项成功、Worker 两分片仍运行；没有全绿或本轮新 SHA 的验收声明。

## 原证合同与本地输入

| 项目 | 固定值 |
| --- | --- |
| 原提交 | `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，初始提交，无父提交 |
| 根 tree | `f5ad9067cdacf1f14202ff450e434be970388fbc` |
| 完整工作树 | 14,664 个文件，313,865,557 字节，均为 `100644` |
| 原始 `ls-tree -r -z --full-tree` SHA256 | `e5da92505019ef765b654d9ebee9cbf0fb1ff444018d52a2536e2771b576aae0` |

本地从原仓库对象独立克隆到忽略的 cache，保留真正 `.git`、固定对象及全部原始工作树字节。没有改动已有 `../cinashop-php` 的索引、对象、工作树或换行设置；其 40 项现存差异经核对为 CRLF 差异，未被当作 canonical 文件复制。默认 `git archive` 会受嵌套 `export-ignore` 影响遗漏 218 文件，因此不能替代完整原库检出。

[`verify-legacy-php-input.ts`](../scripts/verify-legacy-php-input.ts) 在运行任何源文消费者前检查：

1. 独立 `.git` 目录、真实 checkout 根、精确 HEAD 与根 tree，以及 `git fsck --full --strict --no-reflogs` 的对象内容完整性。
2. 全部 tree 条目的模式、blob 类型与大小，以及每个实际工作文件的原生 Git blob SHA1、总文件数和字节数。缺失、换行变化、可执行位、链接、额外文件（包括 ignored 文件）或脏索引均拒绝。
3. 原有 hotwords 清单的 11 个真实固定版本 `git show` 原文及 15 段原有片段，原始字节 SHA256、大小和行数保持原约束；另检查 26 个路由权威文件与原 SQL 摘要。没有合成 `git show` 或把报告代作原文。

仅 connectivity/type/size 检查会接受一个同大小但内容损坏的 loose object。本轮以真实新建 Git 标本重现，再以完整 fsck 拒绝；正确工作文件未被替换。13 项真实 Git 标本覆盖此反例及缺仓库、archive、错 ref、缺对象、工作字节/换行/索引变化、额外文件、链接和占用/悬空 sibling。临时 chmod 仅作用于本测试自建的 loose object。

脚本只运行 Git 和 Node 文件读取，不执行原 PHP、hooks、依赖脚本或旧构建产物。回执只有身份、数量、摘要与布尔结果。`--link-sibling` 仅接受当前仓库的 `.cache/legacy-php-input`；新建独立 sibling 链接，或接受已经指向同一目标的链接/目录。遇到已有其他 checkout 或悬空链接时停止，保留原路径。

本地只读检查可在仓库根运行：

```sh
node --experimental-strip-types workers-ts/scripts/verify-legacy-php-input.ts --input /absolute/path/to/clean-fixed-checkout
```

## 私有 CI 供应和准入边界

两个分片均在 Node/npm 固定版本检查后、安装依赖前，用已固定的 `actions/checkout` 检出 `cinagroup/cinashop-php` 的完整固定 SHA 到 `.cache/legacy-php-input`。使用专用 `LEGACY_PHP_READONLY_SSH_KEY`、`ssh-strict: true`、`persist-credentials: false`，随即完整预检并创建隔离 runner 的 sibling 输入。上传清单只增加 `workers-ts/legacy-php-input-receipt.json`，不增加原库、`.git` 或密钥路径。[固定 checkout 的 SSH 与路径参数](https://github.com/actions/checkout/blob/de0fac2e4500dabe0009e67214ff5f5447ce83dd/README.md) 是当前接线依据。

消费者仓库 `cinagroup/cinashop`（ID `1326510566`）为公开仓库。YAML 引用 `legacy-php-readonly` environment，**本身不会创建可信 branch policy**。必须先通过管理 API 创建并回读 selected branch policy，只有一条 `type: branch, name: main`，无 tag 或 PR-ref 规则，然后才允许存储环境级 secret。GitHub 的环境规则按运行 ref 判定；仅 main 的规则会阻止所有 PR ref，包括同仓库 PR 和 fork PR。两个必需 Worker job 因此不能在 PR 上成功，原聚合仍严格要求 success；不以 skip 或缺失覆盖率制造绿色。[环境保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

原库须先改为私有并重新核对仓库 ID、private 标志和空 main，之后才传 Git 对象。专用 deploy key 只属于原库，明确 `read_only=true`；私钥仅通过 stdin 存为上述消费者 environment secret，不放到 repository/org secret、命令参数、源码、日志或 artifact。[Deploy key 的仓库与权限范围](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)

待授权顺序为：私有化及回读 → main-only environment 及回读 → 专用只读 deploy key → 环境 secret 及元数据核对 → 仅原始 `8ed2a5b…:refs/heads/main` 的私有推送及 tree/父提交核对 → 精确消费者新 SHA 推送 → 实际新 SHA 两分片 SSH 检出、完整预检和最终 CI 验收。任何状态不符即停止；无 force、历史改写、其他 refs 或原库文件改写。当前仅有本地生成的专用密钥，权限为目录 0700/私钥 0600，未上传。

## 保留历史证明与失败退出码

新证明 `legacy-php-input-source-binding-20261103.json` 的 SHA256 为 `e5427c63002e4def70c41cd63c5c1e06bc771d6a2dc7400622db972f98f13d47`。新 reader 只对已核对的完整当前 workflow 应用 5 项精确逆编辑，还原完整 f2 前驱，再交给原有两层证明；其余文件读取仍是真实 fs。原 Uni 证明 `uni-ci-workflow-source-binding-20261102.json` 的完整 SHA256 `72feefd0ae48a70f80edfc8c8124e880421754e50b45a496e9b284cc5023c1f0` 不变，旧 helper/test 仅改 import，断言正文不变。26 项新绑定用例检查真实当前图、完整历史层、精确 edit/hash 和拒绝漂移；容量 gate 直接读取实际当前图。

真实 schema CLI 在发现定义差异时退出 1；原 `producer | JSON consumer` 可能因 consumer 成功而整体退出 0。本轮只在 schema/route 两个原 block 加 `set -euo pipefail`，不改审计命令、报告字段、断言或超时。实际 bash 验收的相同 schema 报告在旧 pipeline 为 0、新 pipeline 为 1：这是保留失败的修复，schema 差异仍未解决。

## 最终验证与现存失败

所有重验证经单一共享串行锁、单 worker/no-file-parallelism，在现有命令 600 秒/整组 1200 秒预算内执行。最终 `final-07` 完整 13 阶段耗时 1029.29 秒；预列 25,765 输入的字节在每阶段后均保持。root 与隔离 candidate 各 8,589 文件，规范化仓库路径后完全相同；精确 f2 baseline 8,584 文件，其余 3 项为 driver/Node。文档在完整批次终态后补。

| 验证 | 实际结果 |
| --- | --- |
| 完整原库预检、实际 sibling 路径及最终重读 | 均成功；14,664 文件、11 原文/15 片段、26 路由与 SQL 摘要相符 |
| 新输入/绑定、旧 workflow、容量四套用例 | 81 通过/1 失败，共 82；新增 13+26 项全通过，零跳过 |
| Worker unit/runtime 类型检查 | 两套通过，307.59 秒 |
| 实际 sibling 的四套源文消费者 | 194 通过/5 失败，共 199，零跳过 |
| 精确 f2 的相同四套完整文件 | 同为 194/5；失败 case 与规范化后的错误内容逐项相同 |
| 真实 route CLI | 退出 0；是审计执行成功，不代表所有路由已迁移 |
| candidate 与精确 f2 的 schema CLI | 均退出 1；原日志字节相同 |
| 原/新 bash pipeline | 相同报告，退出 0/1，失败传播得到证明 |
| 实际 Vitest 文件收集与分片 | 1,650 文件各一次、825+825、58 个固定角色文件串行；仅收集覆盖，不是全部文件执行 |

候选两组用例合计 275 通过/6 失败，基线及中间批次通过数不重复累加。容量失败是原有真实分片子进程超过未修改的 10 秒 deadline，已在精确 f2 另行复现。5 项源文失败包括 `customerWriteoffOperation.ts` 的既有源摘要不符，以及 hotwords 对 package/pages/routes 的历史合并摘要不符；没有刷新这些 pin 或放宽断言。

Schema 覆盖源表 201、目标 287、共享 201、源列缺口 0；外部定义 only 3 项、Worker only 77 项、column drift 0，仍违反现有等价断言。Route 报告仍有 unavailable 21、missing 811、retired 16、actionableMissing 795。`allCommandsSucceeded` 明确为 false，不能描述为完整 CI 通过。

保留前序缺失 archive 文件、connectivity-only 漏检、测试标本只读对象写入问题、ProcessEnv 类型失败、取消的中间 run，以及实际审计失败；仅最终相同源图计入上述结果。独立只读增量复核覆盖源/证明和原始日志，不冒称独立重跑或完整安全审计。本机忽略的 `.cache/php-ts-phase53-validation` 保存完整日志、冻结清单、基线对照及管理审阅计划；提交文件另按最终字节做秘密扫描和暂存/提交核对。

## 原库发布范围与未完成项

完整固定原库按真实 blob 清点后，gitleaks 8.29 默认规则、无本仓库 allowlist 的限深扫描得到 66 项发现，涉及 55 文件，退出 1。11 项已有技术上下文线索，另 55 项需持有人核实；没有在线试用凭据、认定全部失效或新增忽略规则。OAuth appsecret 配置、初始管理员密码哈希 seed 与源码再分发限制确实存在；JWT 的接口示例上下文不作活跃认证断言。一次 33 字节配置文件的 Brotli 解析错误已保留，另按原始字节补扫零发现；也不能据此把完整扫描称为通过。

保留原 SHA 会保留上述内容和原作者/提交者元数据。私有只读方案不等于公开发布许可、凭据失效证明或全部第三方/vendor/font 许可审查完成。新消费者提交文件扫描与原库范围扫描是两份独立结果，不能相互替代。原库源文不执行、当前 artifact 不加入原库，也不构成未来任意测试日志不会输出敏感内容的保证。

原 Git LF `view/uniapp/pages.json` 为 39,359 字节，SHA256 `875a8a9c6187f528898b824ad41d3af82b43314bd6dae942b4d44b84041db3dc`；旧手动 Uni 审计固定的是 41,222 字节 CRLF、SHA256 `b3f0d0db6f6e7e1e2c039695712797fbbb0b1146acc85d304c24bb344e185eb7`。本轮未供应或运行该手动 derivative，不通过全局 autocrlf 或改旧 hash 来掩盖差异。

远端私有供应及新 SHA CI、现存 6 项断言失败/schema 等价差异、完整维护 manifest/单次许可/原子切换、其他通知角色与非微信路径及整体 PHP→TS 迁移仍未完成。未执行生产 DDL/Env 切换、部署、真实微信、浏览器或 Workerd/Hyperdrive 验收。旧用户/UID/权益/旧单/付款、未知归属不猜、跨 AppID 屏障及 `runtime_ready=false` 保持。


## 第59轮：实际配置、传输中止与 Uni CI 读口修复

用户先恢复远端操作，随后针对固定旧源码中的敏感项、私有目标、专用密钥及 main-only／PR 阻塞边界明确回复“明确授权该私有源码及密钥接入”。消费者从 `f2a848eb…` 后的六笔连续提交已推送并直接核对至 `5622484081fb4b221f2ddb0840bfdfdf8846fdc8`；65 个最终文件及六笔 patch 的扫描零发现，与旧库范围扫描分开。

`cinagroup/cinashop-php` 已改为私有；消费者的 `legacy-php-readonly` environment、仅允许 main 的 branch policy、专用 `read_only=true` deploy key 和环境级 `LEGACY_PHP_READONLY_SSH_KEY` 已配置。私钥未进入仓库文件、命令参数或 artifact；续传只读取公钥核对指纹，没有再次读取或发送私钥。当前不删除这些已配置访问项，也不把 secret 元数据当成成功的 CI 检出证明。

固定原库首次上传在 180 秒发生 `TimeoutExpired`。后续只续传同一 `8ed2a5b…`，使用独立 600 秒传输期限、一个 pack thread 和 64MiB pack window；没有改变本地验证的 600／1200 秒预算。用户询问“旧库不上传是否可行”后，仍在进行的专用传输组被停止，实际 push 运行 329.49 秒，以 TERM／exit -15 结束，外层 session 退出 1。2026-11-03 10:17:16 UTC 的回读仍为私库 main API `409 empty`，没有可用 main；专用进程组已退出。**已有部分 Git 对象传输字节发送到私库，空 main 不等于 GitHub 未收到或未保留任何数据。** 不声明私库供应完成、真实 SSH checkout 通过或此前传输数据已清除。

不上传完整旧库仍可在本机保留真实固定检出并继续完整只读预检和原文验收。当前 GitHub-hosted Worker job 无条件检出私库，缺少输入会失败，必需聚合仍要求 success，不能以 skip 或快照替代制造绿色。受保护自托管 runner 可把完整原库留在本地受控卷，但实查该仓库 self-hosted runner 数为 0，供应与隔离接线尚未实现，不能让不受信任的 PR 读取该卷。仅 11 个原文件不能覆盖现合同：hotwords 11、路由权威 26（交集 2）及 SQL 1 的显式输入并集至少 36 个，且当前完整预检仍要求 14,664 文件。较小原文／Git 对象包或受信任外部构建证明需要另立完整、失败关闭的供应合同；构建回执不能替代现有真实 `git show`。本次询问没有选定新的供应架构。

真实新 SHA 的 [CI run 41613267383](https://github.com/cinagroup/cinashop/actions/runs/41613267383) 暴露了独立问题：两个 Uni job 的旧 `ci-migration-gates.test.cjs` 直接解析当前 workflow，与原完整分组基线比较时，遇到第53轮新增 environment、legacy checkout、receipt 和 pipefail。该失败不能归因于 PHP 上传或凭据。

本轮仅改三份 CJS：新增严格历史读口及其测试，旧入口只替换 fs import 并导入新测试。读口复用原 `e5427c…` 完整证明，对精确当前 workflow `2dd8f6…` 应用五处精确逆编辑，得到 f2 完整前像 `30c491…`；其余路径仍读真实文件，未知字节、历史 fallback、证明或 edit 漂移均拒绝。实际 workflow、旧 CJS baseline、旧 49 项 verify／mutants／Bash 断言正文和预算没有修改；精确撤回两处 import 后原文件完整 SHA256 仍为 `624a77aefb8fcaaa3e6c246c24d17c2351429334f7be8b26112a27b48ce11a54`。

真实 CI 旧入口一次执行 **94 项＝原 49＋新 45，全部通过、零跳过，1.53 秒**；8,629 个预列输入运行前后字节一致，单并发、600／1200 秒预算保持。没有另跑新文件重复累计，也没有在本轮运行类型检查、构建、完整 Worker 或云端新提交验收；TS、依赖和业务代码未变。参与作者的交叉阅读不是独立重跑或安全审计。日志、冻结、逐阶段远端元数据和中止记录保存在本机忽略的 `.cache/php-ts-phase59-validation`，最终五个提交文件另按字节扫描、审阅并核暂存／提交。

当前云端 gate 尚未通过；原库供应／替代架构、完整 CI 与整体迁移仍未完成。没有部署、生产 DDL、业务 Env 切换、维护 permit 或 AppID 原子切换。本轮本地 CI 修复与私库传输是独立结果。
