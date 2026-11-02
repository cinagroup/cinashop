# UniApp CI 容量分组与历史工作流证据

本轮从 `20f180ae24a88f40fe6d0a35c26d2cae0204ca01` 继续；该提交已按用户精确授权推送并直接核对远端 main。本记录使用 UTC 时间。

## 触发与行为

[原 run 41390906709](https://github.com/cinagroup/cinashop/actions/runs/41390906709/job/125102245707) 的 UniApp 主 type/test/build 合同在 16 分 59 秒成功，随后共享安全回归成功，作者链执行约 165 秒后取消，整个 job 为 20 分 17 秒。实际终态是 cancelled，取消原因未确证，不能改称 timed_out。

将原 UniApp matrix 行分成两个独立 Ubuntu 24.04 runner：`uni-core` 保留原 12 个串联命令及共享安全回归；`uni-authors` 保留原 10 条作者脚本。每组仍为 20 分钟，保留原 Node24.14.1/npm11.11.0、固定 Actions SHA、锁文件安装及失败传播。其他四个前端、PC/Kefu 完整依赖审计、Worker/PG16/runtime/秘密扫描、触发路径和权限均保持。

唯一 `UniApp build` 聚合检查使用 `always()`，严格要求两个 needs.result 都为 success；failure/cancelled/skipped 均失败。聚合自身为 2 分钟，不提供业务执行容量。两个 runner 各自安装依赖会增加独立安装工作；新 SHA 的实际运行时间仍需远端 CI 证明。

## 实际工作流与来源

`view/uniapp-ts/scripts/ci-migration-gates.baseline.json` 保存父提交完整解析工作流及原始摘要；测试使用现有锁定 yaml1.10.3 解析实际新 YAML，完整深比对未变部分、逐条校验原命令和新分组。49 项检查含重复 YAML key、22 条命令逐一遗漏、9 种结构削弱反例，以及真实 Bash 聚合的 16 种结果组合。该检查直接读取磁盘当前工作流，不经过历史读取器。

修复 D3 离线检查的过时尾部假设：阶段41已在 security-backports 后加入 Manager 回归，因此严格核对两条脚本的原内容、顺序和唯一次数，并拒绝删除、反序、重复或尾后追加。没有改公告允许范围、包版本或锁文件。

旧 7,185,263 字节 merge 证据及 PIN 保持，SHA256 为 `11b657f6c1d223bcc730a21c604c4a89b61d379ac4145ea5b4938559db7ce4cb`。它早于 b874 的既有工作流追加，不能直接拿新 YAML 当成旧输入。新增独立完整来源证明 `uni-ci-workflow-source-binding-20261102.json`（SHA256 `72feefd0ae48a70f80edfc8c8124e880421754e50b45a496e9b284cc5023c1f0`），严格执行 candidate30c49172→20f180/b874提交后版本fae6a6cf→b874直接父/旧merge95be73a9 两层精确逆变换；完整图像、字节数、来源提交、每层编辑及摘要均固定。四份 Git blob、b874 直接父提交和两份 import 前像已独立逐字节核对。

仅两个旧文件的 import 接入该读取器，断言正文、旧 inverse、AST 和 inventory 不变。读取器仅映射这一条精确 workflow 路径，其他文件实读；未知当前字节或旧图像冒充当前均拒绝。38 项新用例覆盖该边界。其他历史绑定漂移继续保留；本轮只选中旧套件的两项 workflow 用例，另 456 项未选择，不能声称旧套件全绿。

## 本地验证

所有重型检查均经单层共享串行锁，Vitest 单 worker、不并行文件，沿用既有内存、每命令 600 秒及 authors 整组 1200 秒限制。

- gates-01：实际工作流 49 项、D3 离线 69 项通过，1053 份所选输入不变。
- authors-02：完整十条原作者脚本 1087 项通过，加分组检查共 439.21 秒，6071 份所选输入不变。使用本机现有锁定依赖，未测 fresh npm ci，不把该时间当成 GitHub 总预算证明。
- worker-04：既有容量 5 项、新来源 38 项、旧 workflow 两项及 Worker unit 类型检查通过；类型耗时 198.6 秒，8541 份输入在该轮运行期间不变。worker-03 的类型失败保留：新读取器对 Uint8Array 使用带编码的 toString；只改为严格 UTF-8 TextDecoder 后，完整重跑受影响图。
- 按测试身份去重为 1250 项定向用例；分组检查的重复执行不再加数。独立只读复核未发现范围内阻塞问题，没有独立重跑或安全审计声明。

日志、输入摘要和 Git 来源核对记录在本地忽略目录 `.cache/php-ts-phase42-validation/`。文档在最终运行结束后补齐，提交文件另做秘密扫描及暂存/提交字节核对。

本轮未重新执行完整 core 链、live npm audit、依赖安装、三端构建或 Browser；原命令保留的结构证明不替代实际新 SHA CI 终态。没有包/锁文件、业务页面或运行时代码变更，没有生产 DDL、部署或真实提供方调用。PC/Kefu 审计、其他历史绑定、完整迁移和运行时就绪条件仍未完成，用户/UID/权益/旧单/付款、未知归属不猜、跨 AppID 屏障与 runtime_ready=false 保留。
