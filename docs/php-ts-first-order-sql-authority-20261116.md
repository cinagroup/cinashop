# 首单优惠 SQL 配置统一迁移（2026-11-16）

本批解决首单优惠在公开估算、购物车、普通结算和代客预览之间分别读取 SQL 与旧 KV，导致价格和优惠券排斥结果不一致的问题。所有首单计价统一读取同一组 6 个 SQL 配置，普通结算在现有定价保护后再次读取并比较语义配置；配置变化时拒绝提交，回滚 SQL 业务写入。

基线：`9743df508e94eaafa2c724b62f8e181311b981fe`；源码 30 文件（26 个既有文件、4 个新增文件）；保护其余 9338 个既有文件。本批是完整可验收迁移批次，整个 PHP → TypeScript 迁移仍未完成。

## 实现与边界

- SQL 全局配置按 `sort DESC, id DESC` 选择，字段可见性不当作功能开关；首单读取采用有界投影。
- 普通结算把首单 6 键合入原有配置投影，共 17 键与 2 个会员权益，保护后重新核对。缺失键插入、重复键成为新赢家、删除及重命名均受现有保护约束。
- 首单 6 键保留 SQL 原始值，由既有纯函数解析一次，避免嵌套 JSON 二次解析。原有 11 个计价字段保留原标准化规则。此处不宣称旧 KV 路径对畸形数据与所有 PHP 框架行为等价。
- 代客预览的购物车、首单和结算读取均位于已有 `REPEATABLE READ, READ ONLY` 快照；支付就绪检查在快照前，报价凭据 KV 写入在 SQL 提交后。
- 删除首单配置可信覆盖参数；兼容加载接口保留调用签名并委托 SQL。注册赠礼等非本批配置仍保留已有读取行为。
- 测试夹具的启用、禁用与种子改为真实 SQL 设置，保留原有金额、券排斥、回滚和幂等断言。

## 实际本地验收

当前单一外层串行门禁新执行 13 个命令，实际终端返回 0；另复用旧 85700 运行中已实际通过的 18 个完整原生子命令，共覆盖 31 项门禁。旧 85700 外层仍记为失败（退出码 1），未被改称成功。复用前逐字节核对运行时依赖，并验证完整测试导入图和项目归属未变；18 项没有声称重新执行。单元测试 20 个完整文件、1089 个用例通过，零跳过。原始 Worker 配置的 4481 个根文件由恰好 2 个分片覆盖，编译选项与类型库解析保持一致；原运行时类型配置检查通过。Workerd 30 文件、410 用例通过。生产依赖审计漏洞为 0。

23 个完整原生 PostgreSQL 文件共 494 个用例通过，各自确认夹具剩余 0、`pg_ctl status` 返回 3、端口关闭。

| 完整原生文件 | 通过用例 | 证据来源 |
| --- | ---: | --- |
| `test/first-order-sql-authority.test.ts` | 21 | 旧通过子命令；未变依赖已证明 |
| `test/membership-pricing-policy.test.ts` | 26 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-pricing-config-authority.test.ts` | 34 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-pricing-lock.test.ts` | 36 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-pricing-lock-registration.test.ts` | 20 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-confirmation-postgres.test.ts` | 7 | 旧通过子命令；未变依赖已证明 |
| `test/account-cancellation-order-admission-postgres.test.ts` | 10 | 旧通过子命令；未变依赖已证明 |
| `test/assisted-purchase-flow-postgres.test.ts` | 50 | 旧通过子命令；未变依赖已证明 |
| `test/assisted-purchase-runtime-postgres.test.ts` | 40 | 旧通过子命令；未变依赖已证明 |
| `test/assisted-payment-race-postgres.test.ts` | 4 | 旧通过子命令；未变依赖已证明 |
| `test/public-product-estimate-native.test.ts` | 16 | 旧通过子命令；未变依赖已证明 |
| `test/coupon-rounding-native.test.ts` | 9 | 旧通过子命令；未变依赖已证明 |
| `test/cart-computation-http.test.ts` | 49 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-line-finance.test.ts` | 13 | 旧通过子命令；未变依赖已证明 |
| `test/order-full-gift-checkout.test.ts` | 6 | 旧通过子命令；未变依赖已证明 |
| `test/checkout-confirmation.test.ts` | 27 | 旧通过子命令；未变依赖已证明 |
| `test/uni-coupon-buy-native.test.ts` | 4 | 旧通过子命令；未变依赖已证明 |
| `test/pc-product-content-native.test.ts` | 5 | 旧通过子命令；未变依赖已证明 |
| `test/newcomer-purchase-postgres.test.ts` | 33 | 本轮新执行 |
| `test/pc-coupon-wallet-postgres.test.ts` | 5 | 本轮新执行 |
| `test/pc-order-coupon-postgres.test.ts` | 5 | 本轮新执行 |
| `test/presale-checkout-postgres.test.ts` | 66 | 本轮新执行 |
| `test/checkout-marketing-scenarios-postgres.test.ts` | 8 | 本轮新执行 |

历史 16 文件另行完整诊断，并与源码内容逐字节匹配 9743 的上一批未提交候选版本所产生的实际原始结果逐用例、首条错误和完整收集错误对照：仍为 1714 用例中 1404 通过、310 失败，另有 2 个文件收集错误；结果完全一致，无新增失败。这些历史失败未计入通过门禁。 当前库存较旧诊断至少多 6 个路径（旧批两份报告与本批四个新增测试/凭据文件），配置也会重扫测试导入图；这里证明的是完整实际结果一致，未声称两次环境完全相同。

新增 56 个源码连续性用例绑定完整当前字节，并将 26 个既有文件严格逆变换为固定 9743 Git 原文；旧公开商品估算凭据、负例及历史失败边界保留。

开发中出现的代客夹具接口错误、嵌套解析反例、旧优惠券 KV 夹具失败、KV 模拟器类型错误及重复配置无序查询断言失败均完整归档。最终验收采用新冻结后的实际执行结果与严格证明未变的 18 个旧通过子命令，明确保留其各自运行来源。

## 交付证据

源码清单 SHA-256：`e10b1673125eccbc646dd0d62553af80261b730d83410d1f25b64f0ed9263c7d`。依赖清单 SHA-256：`d422e7bdfdeb1b2c4bbbefda6d6650c7592de6d0dfbd23eb3c20cbec7218c948`。机器报告：`workers-ts/audit/first-order-sql-authority-20261116.json`。实际命令、日志、终端回执、失败归档和后续提交/推送/CI 回执保存在 `/tmp/php-ts-first-order-authority-20261116`。

报告生成时本地验收已完成；本批提交与推送 CI 由后续实际回执记录。已知 CI 基线为 run 43907900986：Worker 两分片的固定 PHP 提交检出失败和其聚合失败仍需区分，未执行的单元步骤不可称通过。

本批没有前端源码改动，未重复本地前端构建或浏览器验收；推送后的真实 CI 另行检查。真实 PHP 仓库的 HEAD 与既有脏状态、5 个用户依赖链接、150 个恢复资源、UniApp 包定义和并发配置均保持原样。未部署生产，未调用真实支付、短信、提供商或业务队列。
