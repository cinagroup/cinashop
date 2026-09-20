# 线下支付 Workers／本地 Hyperdrive／PostgreSQL 验证

2026-09-20，本地候选验证，未部署。补充[首次持久派发](offline-order-payment-dispatch.md)的运行时证据；不是线上 Hyperdrive、真实商户、正式 HTTP 收银入口或全仓验收。

## 实际经过的边界

`offline-order-payment-workerd.test.ts` 用 esbuild 的 `workerd` 条件打包测试入口 `integration/OfflinePaymentWorkerdScenario.ts`，运行在仓库现有 workerd 2026-08-11。Miniflare 5 使用自身导出的 `convertV4MiniflareOptions`（与已安装的 Workers Vitest pool 一致），不修改依赖版本或部署配置。

测试入口复用生成绑定所扩展的生产 `Env`、`createDb(env)`、postgres.js 的 Cloudflare 实现及实际 DI／建单／派发／恢复／结算服务。通过 **Miniflare 本地 Hyperdrive 绑定**连接原生 PostgreSQL 16.15，CONFIG_KV 也使用本地实际 KV 绑定，不用 Node SQL 替身代替 Worker 执行业务。

测试维护连接只负责创建随机隔离库、授予明确权限、安排下一次查单时间及注入权限故障。Worker 仅拿到临时非所有者 LOGIN；每次业务请求从自己的 PostgreSQL 后端核验数据库、session_user=current_user、非超级用户／非建库／非建角色／非 BYPASSRLS、非 other_order 所有者及版本。测试还比较 Worker 和 Node 观察连接的 backend PID，确认不是在 Node 中调用业务服务冒充运行时。

入口没有生产路由引用，只有固定测试操作／合成顾客／金额。随机令牌先做 SHA-256 后常量时间比较，未授权请求返回 403；绑定数据库／账号必须匹配测试专用命名。无任意 SQL、维护凭据或环境变量回传；错误仅返回 SQLSTATE。每请求关闭客户端，退出场景先 dispose Miniflare，再回收角色和隔离库。

所有 Worker 支付 fetch 均由本机 outboundService 截获。模拟器独立验证 RSA 请求签名、原商户／单号／1000 分金额／业务标记／渠道及 H5 IP 或原 OpenID，回复本地生成密钥签名的样本；不访问真实支付平台。每次外发都从维护观察连接检查该运行角色没有活动事务；预支付请求时还检查已提交的 ISSUING 记录。

## 本轮结果

- **7 项原生 PG＋workerd 场景通过**，66.95 秒，零失败／跳过：微信 H5、公众号 JSAPI、小程序、支付宝 WAP 四渠道生成和重放入口；实际签名查单结算；响应丢失后不重新发起；未验签的查询不写证据或到账；发起 INSERT 缺权导致整笔预留回滚且不发请求；赠分账单 INSERT 缺权导致财务整笔回滚，恢复权限后仅重放已提交查询证据、不再次调用支付平台。
- 成功结算后反复恢复／支付重放仍只有一份收款、一条赠分账单和一条会员节省。合成会员 12.50 元按冻结权益实付 10.00 元；积分 50→64，余额保持 100.00，会员有效期不被 type=3 收款更改，无现金扣款流水。
- **47 项 workerd 合同／适配器测试再次通过**，两文件，14.63 秒；包含此前未能启动的 9 项基础合同及 38 项实际支付适配器合同。
- **170 项 Node 相关回归通过**，三文件，13.49 秒：provider、原身份合同和本地运行器边界。与 workerd 的适配器合同有重叠，不累加成独立业务用例数。
- 主类型检查与运行时类型检查均通过（Node 4GB 堆上限）；运行器语法检查通过。

失败过程保留：首轮 7 项在夹具准备阶段因两个渠道重复 OpenID 触发 `wu_openid_uq`，改为只准备当前渠道；第二轮 7 项在 Miniflare 构造时发现旧参数形状，改用安装版本明确提供的转换接口。两轮没有进入支付业务断言。第一次类型检查触及 Node 默认 2GB 堆限制；4GB 重跑明确报出上述构造参数类型错误，修正后通过。没有放宽数据库约束、断言或类型规则。

本轮自建 `finance-postgres-RgWhPC:61843`、`finance-postgres-q45K8W:57525`、`finance-postgres-WgHyBp:57585` 三个集群均回收测试库／角色至 0 并停止。随后独立只读主机检查确认三者 pg_ctl=3、无 postmaster.pid／启动口令文件、测试端口监听 0、可信测试 PostgreSQL／本仓库 workerd／路径不明相关进程均 0。诊断目录保留，原九个暂存路径不变。

## Windows workerd 启动对照

先前两次 `0xc0000005` 为真实失败，不改写为通过。后续不导入业务、不配绑定或监听端口的 `test/fixtures/workerd-startup.capnp` 同样在原系统运行库下崩溃。

系统 `vcruntime140.dll`／`msvcp140.dll` 为 14.00.24215.1，而 `vcruntime140_1.dll` 为 14.51.36247.0。将**同一份 workerd.exe**和本机已存在、Microsoft 签名有效的 14.51.36231.0 运行库放入独立目录后，最小原生测试、47 项合同测试以及上述 PG 集成测试通过。这支持本机运行库组合是启动失败原因；没有定位到某个具体 DLL 函数。

独立目录：`C:\cinagroup\cinashop\.cache\workerd-local-runtime-20260920-a84d4e6c`。原与副本 EXE 的 SHA-256 均为 `CBBA402D8FAD83B0D70787F115C614549B2466FB7C5A4836CDF124BC35345B4A`，本轮再次核验。DLL 来自现有 Codex 依赖中的 `native/jxrlib/jxrlib/bin`，复制前逐一核验签名与版本。未安装软件、替换 System32 DLL、更新依赖或写持久环境变量；这是本机测试绕行，不是系统级修复，不将这些二进制提交入库。

在 workers-ts 目录可重现（以下路径仅适用于当前已核验的本机副本；其他主机使用自身可信运行时）：

```powershell
$env:MINIFLARE_WORKERD_PATH = 'C:/cinagroup/cinashop/.cache/workerd-local-runtime-20260920-a84d4e6c/workerd.exe'
$env:WRANGLER_LOG_PATH = 'C:/cinagroup/cinashop/.cache/workerd-local-runtime-20260920-a84d4e6c/wrangler-pg-tests.log'
$env:WRANGLER_SEND_METRICS = 'false'
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-payment-workerd.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.worker.config.ts test/runtime/offline-payment-contract.test.ts test/runtime/offline-payment-provider.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/offline-payment-provider.test.ts test/payment-query-identity.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## 未完成范围

本地 Hyperdrive 不是 Cloudflare 远端连接池／缓存／跨区域行为验收；本地签名样本不是实际微信或支付宝支付。这里通过测试专用处理器直接调用恢复消费者，不冒充正式鉴权收银 HTTP、真实 Queue 投递或通知 HTTP→Workers→数据库端到端验证。公开接口／页面、安全刷新及上游关闭退款、旧商户凭据版本、受控 DDL／ACL 注册和升级、真实 provider／Hyperdrive／浏览器／当前代码 CI／发布仍开放。SUP-001、FE-003F 不勾选，Checklist 仍为 240 完成／164 开放／404 总项。

Workers／PostgreSQL 技能促成每请求客户端、事务外 I/O 和真实最小权限验证；通过 Firecrawl 核对[Cloudflare 当前最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)，并直接读取官方最新 `@cloudflare/workers-types` 5.20260919.1 的相关定义。没有生产访问或支付、没有图片／缓存修改、暂存、提交、推送或部署。
