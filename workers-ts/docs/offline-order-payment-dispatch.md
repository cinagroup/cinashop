# 线下消费首次支付发起与未知结果恢复

2026-09-20，本机候选，未接公开收银接口、未注册生产DDL、未部署。承接[路径互斥](offline-order-payment-selection.md)、[回调结算](offline-order-external-payment.md)和[查单证据与恢复](offline-order-query-recovery.md)。这是首次发起链路，不是完整的支付续期、关闭、退款或生产验收。

同日后续已新增[鉴权建单／支付／只读详情 HTTP](offline-order-http.md)，进入实际路由装配，仍未部署或完成受控安装；本页下文描述的是首次派发核心阶段的边界。

进一步的本地增量已新增[独立受控安装与协议权限入口](offline-order-installation.md)；
生产安装、编号迁移/ORM/目录清单注册及协调发布仍未完成。下文“安装器待补”是此前阶段记录。

## 本次实现

`dispatchOfflineOrderPayment` 只接受受信鉴权UID、原订单号、provider和边缘层取得的客户端IP；金额、应用/商户、微信payer、profile及交易类型来自服务端配置与不可变准入/选择。没有客户传入金额、payer、回调地址或过期时间的通道。当前没有公开路由，未来HTTP适配层仍须落实鉴权、IP来源和DTO边界。

先在短事务核对原订单与已有发起记录，提交后读取支付开关、配置并真实导入/验证RSA密钥格式。请求级闭包保留当次私钥、公钥、应用、商户及回调地址，不进入数据库、日志、队列或全局变量。私钥与平台公钥是不同用途；预检只证明格式/算法可用，不证明商户资质、渠道开通或密钥实际归属。

第二个短事务重新检查订单、账号与竞态，将首次支付选择、`initiated_time` 恢复案件和单次发起记录一起提交；提交成功后才允许调用provider。缺表、权限、付款身份、有效IP或金额失败全部回滚，无网络请求。共同锁序为provider/order恢复锁→案件→订单/账号→发起记录，READ COMMITTED，语句5秒/锁1秒且不放宽更短会话设置。

| 持久状态 | 含义 | 重复调用 |
| --- | --- | --- |
| ISSUING | 请求发出前的事务已提交；可能尚未发送、正在发送或响应已丢失 | 只返回需核对，不抢占、不重发 |
| READY | 保存了允许展示的支付入口，不是收款证据 | 原身份和有效窗口内读取同一入口 |
| UNKNOWN | 网络、provider拒绝或无法验证的响应 | 交给原身份查单/回调恢复，不换余额或其他provider |

每个支付选择只有一个attempt和一个case；只有ISSUING可一次性转READY或UNKNOWN。完成事务失败会保留ISSUING。恢复记录、财务收款和支付入口的状态分别保存：迟到的入口响应不覆盖已结算/冲突/人工关闭案件；账号在请求途中禁用时仍保存结果但不返回可用入口。确认已付须同时匹配本地已付订单、原支付方式/交易号和已完成恢复案件。

已有旧式孤立selection或无dispatch的recovery case不能被当成“从未发出请求”，因此不会自动新建尝试。原商户配置改变、OpenID重新绑定、页面刷新或超时都不释放原选择。

## Provider与展示合同

- 微信H5/JSAPI/小程序使用冻结的整数分、原订单、CNY和独立`offline_order`标记；H5拒绝无效、未指定和回环IP（含展开/映射IPv6），不使用0.0.0.0默认值。实际边缘IP来源仍是未来HTTP入口责任。
- 微信请求真实RSA签名，响应（包括错误响应）验签、时间窗和平台公钥ID校验，有8秒请求预算及64KiB读取界限。H5只返回官方固定主机/路径的完整原URL；JSAPI返回固定七字段并用原商户私钥签名，不透出raw响应或payer。
- 支付宝WAP生成真实RSA2签名的官方跳转URL，没有商户服务器“下单成功响应”，更不是付款成功。精确元字符串从整数分生成，金额最高21,474,836.47元，与现有int32回调账本保持一致。app/notify/return来自冻结服务端配置，不支持app_auth_token服务商模式。seller映射来自运维受信直连配置，不冒充WAP返回或签名响应中的seller字段。
- 入口存储只包含允许的展示字段及绑定selection UUID的SHA-256摘要，最大8192字节；重放再次核对摘要、形状、原应用/交易类型，支付宝同时核对原单号、金额及业务标记。没有私钥、原始响应或明文客户端IP记录；必要payer仍仅存在内部冻结选择中。

微信官方说明H5链接有效5分钟且不得拆改；失效需重新获取链接，不表示交易未支付。[微信H5合同](https://pay.weixin.qq.com/doc/v3/merchant/4012791834.md)。支付宝WAP是页面跳转支付入口。[支付宝WAP合同](https://opendocs.alipay.com/open/02ivbs.md)。

本候选所有入口采用**从持久发起时刻起300秒的保守展示窗口**：H5不超过官方窗口；JSAPI/支付宝只是本系统暂定展示上限，不声称其上游有效期也是五分钟。不修改provider的time_expire，不关闭交易、不释放支付路径，不据此写NO_PAYMENT。窗口过后转为只读恢复提示；安全刷新同一交易入口、可信关闭后重建尝试和长时间未支付清理仍必须实现，不能把永久拒绝重发当作完整收银生命周期。

## 数据库与权限

新增未注册`OFFLINE_ORDER_PAYMENT_DISPATCH_SQL`及候选模型。受控新夹具安装顺序：admission→selection→balance→external/query evidence→callback domain→dispatch。主键和唯一键限制一选择/一案件/一次attempt；CHECK约束状态、时间、UUID及容量；固定search_path的SECURITY DEFINER触发器核对原选择、未付订单、有效账号、已登记且匹配的原恢复案件，禁止改身份、重复转态、删除和截断，撤销PUBLIC表/函数权限。

业务测试用真实独立非所有者LOGIN，发起角色没有余额/积分/收款字段写权限或现金流水INSERT，只获得必需行锁列、选择/案件/发起记录权限。财务恢复测试才单独授予既有结算权限。维护角色仅建立自有随机夹具、授予测试ACL及注入故障；它能禁用触发器，不在业务信任边界内。

这不是生产安装或旧候选升级脚本。schema总入口、MigrationService注册、显式版本升级/回滚、目录与ACL证明、保留/删除策略尚未完成，禁止直接复制SQL上线。

## 可复验验证

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-payment-dispatch.test.ts test/offline-order-payment-selection.test.ts test/offline-order-query-recovery.test.ts
node node_modules/vitest/vitest.mjs run test/offline-payment-provider.test.ts test/payment-query-identity.test.ts test/local-finance-postgres-runner.test.ts test/third-party-refund.test.ts test/payment-readiness.test.ts test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/payment-callback-route.test.ts test/alipay.test.ts test/wechat-crypto.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
node node_modules/vitest/vitest.mjs run --config vitest.worker.config.ts test/runtime/offline-payment-contract.test.ts --maxWorkers=1
```

初轮新发起套件22项原生PG16.15通过（125.03秒）；初轮五文件177项相关回归通过。扩展后十文件222项签名/合同及相关回归通过（18.11秒）。业务使用实际SQL/约束/独立连接和本地生成的真实RSA密钥，provider传输及配置KV为本地夹具，无真实商户请求。回调抢先测试使用可信解码夹具，不冒充真实provider→HTTP端到端链路；完整验签HTTP由既有callback-pipeline套件覆盖。

最终联合三文件**100项原生PG测试全过**（发起27、选择35、查单恢复38），443.44秒，零失败/跳过。并发用独立LOGIN与实际`pg_blocking_pids`屏障证明；请求阶段从观察连接确认业务连接空闲且事务已结束。过期测试由维护夹具整体平移不可变时间线，模拟五分钟经过，没有真实等待或更改运行时数据库时钟。包括入口摘要/案件关联损坏、账号在途禁用、商户/付款人改绑、提交后断连、末端写权限失败、原身份实际签名查询→结算一次。初轮与最终批次有重叠，不累加为新增用例数。

主/运行时类型检查通过，运行器语法及作用域行尾空白检查通过。初次主类型发现新测试多余导入，后续扩展实际使用该模型；初次运行时类型发现Workers的generateKey/exportKey联合返回类型不能直接当作key pair/DER，改为真实形状/ArrayBuffer检查后通过，未强转或压制类型错误。

两个本轮自建集群`finance-postgres-kgfrcx:51819`、`finance-postgres-7mYIa2:55669`均由运行器清理测试库/角色至0并停止。独立只读主机检查确认pg_ctl=3、无PID或启动口令文件、对应端口监听0，可信测试目录和无法识别路径的PostgreSQL进程均0，本仓库workerd进程0。诊断目录保留，原九个暂存路径未变。

历史首次两次 workerd 尝试没有执行成功：普通沙箱有 Wrangler 日志路径 EPERM，提升权限后仍在导入测试前 `0xc0000005`，当时 0 项执行。后续同一二进制与独立目录 Microsoft 签名运行库的 A/B 定位到本机运行库组合；不改系统或依赖。2026-09-20 已复验 **47 项 workerd 合同＋7 项实际 workerd→本地 Hyperdrive→原生 PG 发起／查单／结算场景通过**，另170项相关回归与双类型通过。失败历史、精确边界和重现命令见[运行时验证](offline-order-workerd-verification.md)；不是线上 Hyperdrive 或真实商户验收。

## 剩余目标

原商户旧凭据与密钥版本保留/选择；上游期限、入口安全刷新、确认关闭和退款/补偿；跨业务订单号统一权威；公开鉴权接口与持久收银页面；零金额明确政策；受控DDL/目录/ACL及旧候选升级；正式HTTP/Queue运行时完整链路、真实provider/Hyperdrive/浏览器/CI和协调发布。SUP-001、FE-003F保持开放，Checklist仍240完成/164开放/404总项。

Workers/PostgreSQL技能指导事务外I/O、原子记录、有界读取和最小权限；Firecrawl连接器核对官方支付及[Workers node:net文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)。本机CLI不可用，没有因此安装工具或修改环境。用户已确认新图能读取，本轮不重复改图/缓存；不访问生产、不暂存提交推送或部署。
