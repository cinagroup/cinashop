# CinaShop PHP → Cloudflare 迁移完成 Checklist

审计基线：`main@34394ce`（2026-08-27，已推送并确认与 `origin/main` 一致）。PHP 权威源为 `C:\cinagroup\cinashop-php`，Cloudflare 目标为本仓库 `workers-ts` 与五个 TypeScript 前端。生产数据库通过 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 只读核验；主 Worker 和正式前端没有因本次审计被发布。

## 审计结论

迁移进度不能用一个百分比概括：结构定义已经完整，生产结构接近完整，但 HTTP 合同、真实数据、第三方配置和发布状态明显滞后。

| 维度 | 当前证据 | 判定 |
|---|---:|---|
| MySQL 表结构映射 | PHP 201/201 表、缺源列 0 | 源结构定义完成 |
| 仓库目标结构 | 外部 SQL 217 表；Worker 内嵌 217 表；表/列/主键漂移 0 | 完成 |
| 生产目标结构 | 217/217 表；缺失 0、额外 0 | 完成 |
| PHP HTTP 合同 | 精确注册 519/1,912；其中 15 条接入明确 501 | 注册 27.1%，静态可执行上限 26.4% |
| 真实数据复制 | `data_migration_run=0`，本机无 `SOURCE_MYSQL_URL` | 未开始 |
| Worker 单元测试 | 110 文件、640 项通过 | 本地业务回归通过 |
| Workers runtime | Windows `workerd` 启动即 `0xc0000005` | 未执行断言，不能算通过 |
| CI | 仓库没有 `.github/workflows` | 未建立 |
| 主 Worker 发布 | 生产仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef` | 未发布当前代码 |
| Pages 发布 | Admin/H5 最新来源仍为 `48297d2`；PC 来源为空；无 Supplier/Kefu 项目 | 未发布当前代码 |

静态路由统计由 `cd workers-ts && npm run audit:routes` 生成。参数名差异会归一化，ThinkPHP `resource` 会按 `only/except` 展开，通配 501 不计为覆盖。该统计仍只是上限：它不证明权限、响应字段、并发状态机、数据或第三方副作用等价。

### 路由合同分布

| 面 | PHP | Workers | 精确匹配 | 明确 501 | 缺失 | 静态可执行上限 |
|---|---:|---:|---:|---:|---:|---:|
| `/api` | 460 | 551 | 164 | 0 | 296 | 35.7% |
| `/adminapi` | 1,156 | 470 | 202 | 15 | 954 | 16.2% |
| `/supplierapi` | 184 | 112 | 79 | 0 | 105 | 42.9% |
| `/kefuapi` | 63 | 49 | 47 | 0 | 16 | 74.6% |
| `/outapi` | 41 | 27 | 27 | 0 | 14 | 65.9% |
| `/erpapi` | 8 | 0 | 0 | 0 | 8 | 0% |
| 合计 | 1,912 | 1,209 | 519 | 15 | 1,393 | 26.4% |

最大缺口组：`/api` 的 v2 54、admin 51、PC 22、order 19、user 13、marketing 13、store 12、work 10；`/adminapi` 的 setting 153、marketing 115、product 98、user 78、app 76、supplier 67、order 57；`/supplierapi` 的 order 30、product 16、file 11、admin 8。精确逐路由清单以 `audit:routes` JSON 为准，不在本文复制 1,393 行。

### 生产数据库事实

- PostgreSQL 16.14；应用两个账本迁移后，生产 `public` 当前 217 表、3,021 列、696 索引、204 主键。
- `order_print_job`、`order_print_job_action`、`order_waybill_job`、`order_waybill_job_action` 已创建且行数为 0；仓库 217 表清单与生产集合差均为空。
- 商品 71、订单 29、订单明细 28、售后 3；客服账号 0、会话 0，但客服消息历史 3。
- 商品描述 0、访问记录 0、`type=1` 商品分类关系 0，相关页面无法仅靠现有生产数据完成真实验收。
- 数据迁移控制表存在但运行记录为 0；源 MySQL 连接变量缺失，`npm run data:plan` 明确失败为 `SOURCE_MYSQL_URL is required`。
- `system_config` 有 6 个重复键、20 条额外历史行；其中 `site_url` 曾同时出现示例值和实际 Pages 值，不能自动删除。

### Cloudflare 资源与配置事实

- 已存在并匹配仓库配置：Hyperdrive、`cinashop-api-CONFIG_KV`、`cinashop-assets` R2、`cinashop-order`、`cinashop-order-dlq`、`cinashop-order-dlq-unarchived`。
- 主 Worker 当前只有 6 个 Secret 名：`APP_KEY`、`DEBUG`、`INTERNAL_CHAT_TOKEN`、`OPERATIONS_TOKEN`、`UPSTASH_REDIS_URL`、`UPSTASH_REDIS_TOKEN`。
- 支付、短信、Turnstile、电子面单所需 Secret 当前未配置；即使代码存在也不能投入生产。

## 执行规则

- `[x]` 只表示已获得可重复证据；源码中“有接口/有页面”不等于完成。
- 每个写状态机必须具备权限边界、幂等、并发锁、失败恢复、脱敏审计和 PostgreSQL 隔离场景。
- 每批先完成单元/类型/构建，必要时再使用随机 schema 连接生产 Hyperdrive；禁止把合成数据直接播种到 `public`。
- 生产 DDL 必须短事务、固定 `search_path=public`、设置 `lock_timeout/statement_timeout`，执行前后核对表与业务行指纹，并验证二次执行幂等。
- 主 Worker/Pages 正式发布仍需单独明确批准；本 checklist 不把提交推送解释为发布授权。
- 外部账号、源 MySQL、生产凭据或业务取舍缺失时标记 `BLOCKED`，不得用假数据把项目标为完成。

## P0：生产结构与真实数据

- [x] **AUD-001 可重复路由审计器**：新增 `workers-ts/scripts/route-parity-audit.ts` 和 `npm run audit:routes`；验收为 Kefu 63/47、Out 41/27、ERP 8/0 与人工核对一致。
- [x] **AUD-002 生产只读目录审计**：通过一次性认证 Worker 读取表名、目录计数、迁移控制和非敏感业务计数；三次临时 Worker 均已删除，生产无写入。
- [x] **DB-001 创建小票任务账本表**：已应用外部 `0090_print_job_outbox.sql`（Worker 内嵌 `migration_0097`），创建 `order_print_job` 与 `order_print_job_action`；二次执行只返回 `already exists, skipping`，六张业务表指纹不变。生产引擎随机 schema 场景确认自动/手工幂等、租户隔离、Queue 脱敏、并发单次调用、UNKNOWN 不盲重试与三类人工处置全部通过，临时 schema/Worker 已删除。
- [x] **DB-002 创建电子面单任务账本表**：已应用外部 `0091_electronic_waybill_outbox.sql`（Worker 内嵌 `migration_0098`），创建 `order_waybill_job` 与 `order_waybill_job_action`；二次执行幂等，六张业务表指纹不变，最终四张任务表均为空。生产引擎随机 schema 场景确认请求重放、根单活跃任务、租户隔离、Queue 脱敏、提供商未知/拒绝/本地失败、人工处置与履约精确一次全部通过。
- [ ] **DB-003 清理重复系统配置（BLOCKED：需运营确认）**：逐键选择权威记录，特别确认正式 `site_url`；先导出 ID/值摘要和引用，再删除或停用 20 条额外行。禁止按最大 ID 或空值自动猜测。
- [ ] **DATA-001 取得只读源 MySQL（BLOCKED：需连接）**：提供可访问的 `SOURCE_MYSQL_URL`，账号只允许 `SELECT`；先完成 TLS/网络/字符集/时区检查，不在仓库保存凭据。
- [ ] **DATA-002 全量迁移计划**：运行 `data:plan`，确认 201 表依赖顺序、复合游标、重命名映射、预计行数与目标冲突策略；计划本身不得写目标库。
- [ ] **DATA-003 分批复制与可恢复游标**：先账号/ACL/配置，再商品，再用户/社交，最后订单/资金/消息；每批使用 `data_migration_run/checkpoint`，失败后可从同一游标安全恢复。
- [ ] **DATA-004 全量校验**：执行 `data:verify`；逐表核对行数、主键范围、金额总和、外键/孤儿、时间区间、枚举分布、抽样摘要与序列；所有差异必须有书面处置。
- [ ] **DATA-005 私有媒体迁移**：把旧 `store/comment` 等对象迁入 `cinashop-assets`，重写附件关系并验证签名 URL、过期、租户隔离与孤儿清理；不得把旧对象存储密钥带入运行时。
- [ ] **DATA-006 关键业务真实数据验收**：至少覆盖真实客服账号/会话/话术、商品描述/分类/访问、管理员角色菜单、供应商、支付配置、打印机、电子面单、微信内容与通知模板。

## P0：资金、回调与认证边界

- [ ] **CORE-001 支付/业务回调**：迁移并验签 `ANY /api/pay/notify/:type`、`order_call_back`、微信/小程序/企业微信/同城配送回调；要求重放保护、事件账本、乱序处理和对账任务。
- [ ] **CORE-002 客服资金退款**：补齐 `PUT /kefuapi/refund/refund/:id` 及其同意退款合同；金额绑定订单与售后、提供商幂等、处理中/未知状态、主动查询、重复回调和客服归属必须验证。
- [ ] **CORE-003 对外 API 资金与用户写入**：在 HMAC ACL 下恢复或正式废弃 Out API 的退款、商品/分类/优惠券/用户写入；每条接口必须有独立权限 ID、幂等键和不可变审计。
- [ ] **CORE-004 认证入口合同**：处理旧 `GET /api/verify_code`、AJCaptcha 别名、短信登录/重置、社交登录及可选参数差异；统一 Turnstile/用途绑定/手机号限流/一次性消费。
- [ ] **CORE-005 默认管理员与 Token 兼容**：确认生产无历史默认密码，轮换管理员密码；验证 `APP_KEY` 与旧 PHP token 兼容策略，记录切换/失效时间。

## P1：用户端 `/api` 路由批次

- [ ] **API-001 公共首页与商品发现**：补齐首页菜单、品牌、推荐、搜索筛选、排行、详情内容、评价列表/统计、预售等公共读取；用已迁移真实商品数据对账。
- [ ] **API-002 订单与售后 19 条缺口**：逐项迁移创建后操作、支付选择、取消、收货、物流、评价、发票、退款申请/退回/删除等合同；复用现有短事务状态机而非复制旧控制器。
- [ ] **API-003 用户中心 13 条缺口**：地址、收藏、账单、佣金、签到、积分、提现、发票、会员与消息；所有金额和积分操作需要不可变流水。
- [ ] **API-004 `/api/v2` 54 条缺口**：按商品、订单、活动、用户拆批；先确认是否仍有正式客户端调用，未使用合同可走带证据的退役流程。
- [ ] **API-005 `/api/pc` 22 条缺口**：以 PC TypeScript 实际调用为准恢复登录、商品、订单、用户和内容别名；完成桌面/移动浏览器 E2E。
- [ ] **API-006 营销/活动缺口**：处理 marketing 13、bargain 4、combination 4、seckill 3 及其资格、库存、支付、超时、退款和奖励状态机。
- [ ] **API-007 社区/内容/DIY**：补齐 article 7、reply 4、diy 8 以及仍被 UniApp 调用的社区合同；媒体统一走私有 R2。
- [ ] **API-008 门店/企业微信/内嵌 Admin**：处理 store 12、work 10、`/api/admin` 51；外部写操作必须 Queue 化，不能同步调用第三方。

## P1：Admin `/adminapi` 路由批次

- [ ] **ADM-001 系统设置与表单**：setting 153、system 31、file 12；区分运行时权威配置、仅历史只读目录和明确退役功能。
- [ ] **ADM-002 营销与微信应用**：marketing 115、app 76、live 17、notify 14；恢复本地目录读写后，再逐类启用微信远端写入与回调。
- [ ] **ADM-003 商品运营**：product 98、freight 9；覆盖规格、属性、分类、品牌、库存、评价、运费模板、虚拟商品与批量操作。
- [ ] **ADM-004 用户与分销**：user 78、agent 35；覆盖标签/分组、等级、资金、佣金、推广关系、事业部、导出和权限。
- [ ] **ADM-005 供应商与财务**：supplier 67、finance 19；覆盖审核、结算、提现、流水、对账及租户隔离。
- [ ] **ADM-006 订单/退款/门店**：order 57、refund 5、store 10；复用订单、履约、核销、打印、面单与退款账本。
- [ ] **ADM-007 内容/DIY/导出**：diy 25、cms 18、export 22；恢复可视化页面链接、素材、文章与异步导出。
- [ ] **ADM-008 客服后台与历史任务**：serve 22、queue 3；管理员不得冒充客服，历史 ThinkPHP Queue/Timer 只读目录需逐项迁移消费者或正式退役。
- [ ] **ADM-009 企业微信 501 占位**：当前 15 条 PHP 精确合同虽已注册但返回 501；为 moment/client/group/template/welcome 建立 Queue、幂等投递、重试/死信、回调验签后才能转为完成。

## P1：Supplier `/supplierapi`

- [ ] **SUP-001 订单 30 条缺口**：列表筛选、导出、详情、备注、发货、拆单、核销、打印/面单、退款协同；验证供应商只能访问自身订单/明细/账本。
- [ ] **SUP-002 商品 16 条缺口**：分类、规格、批量上下架、库存、虚拟库存与商品类型；解除“仅实物商品”限制前必须完成对应履约链。
- [ ] **SUP-003 文件 11 条缺口**：迁移分类、移动、重命名、删除、上传别名，并验证 R2 租户前缀和签名 URL。
- [ ] **SUP-004 账号/设置/首页**：admin 8、setting 5、system 4、home 2 以及密码、城市、菜单、通知；补齐供应商角色权限矩阵。
- [ ] **SUP-005 导出/队列/售后**：export 4、queue 5、refund 3；导出使用一次性票据，队列只传引用，售后状态机与平台一致。

## P1：Kefu `/kefuapi`

- [ ] **KEFU-001 扫码/微信登录 4 条**：`ticket/[:appid]`、`key`、`scan/:key`、`wechat`；需要一次性挑战、回调验签、重放保护和账号绑定。
- [ ] **KEFU-002 游客链路 8 条**：`tourist/user|adv|feedback|order|product|chat|upload`；必须签发短期游客会话，限制订单/商品作用域，上传走隔离 R2，不能恢复弱公共令牌。
- [ ] **KEFU-003 面单模板与旧退款入口**：`POST /order/refund`、`GET /order/temp`；先澄清 PHP 方法/字段矛盾，面单只读模板与可重试签发任务分离。
- [ ] **KEFU-004 退款同意与资金退款**：`GET /refund/agree/:order_id` 的旧 query/path 矛盾需形成兼容合同；资金退款按 CORE-002 验收。
- [ ] **KEFU-005 真实账号浏览器 E2E**：迁移至少一个有效客服账号后验证密码登录限流、WS hibernation、断线重连、上传/重签、转接三端通知、日限额、多会话、商品/订单/售后权限。

## P1：Out API 与 ERP

- [ ] **OUT-001 分类写入 4 条**：新增、修改、删除、上下架；需要库存/商品引用门禁和 HMAC ACL。
- [ ] **OUT-002 商品写入 4 条**：新增、修改、上下架、库存同步；需要请求幂等、供应商归属和审计。
- [ ] **OUT-003 优惠券写入 3 条**：新增、状态、删除；验证已领取/已使用关系和活动冲突。
- [ ] **OUT-004 用户写入 3 条**：新增、修改、赠送金额/积分；赠送必须产生不可变流水并阻止重复请求。
- [ ] **ERP-001 认证 3 条（BLOCKED：需 ERP 协议/账号）**：授权、回调、access token；凭据只存 Secret，回调必须 state/签名/重放保护。
- [ ] **ERP-002 同步与回调 5 条（BLOCKED：需 ERP 沙箱）**：商品同步、库存、发货、取消、售后收货；必须以事件账本保证乱序和重复安全。

## P1：第三方配置与远端验收

- [ ] **CFG-001 Turnstile**：创建正式 widget，配置 `TURNSTILE_SECRET_KEY`、`TURNSTILE_SITE_KEY`、精确 hostname；PC/H5/App/小程序验证成功、过期、重放和失败恢复。
- [ ] **CFG-002 Aliyun SMS**：配置 access key、secret、签名、模板/区域；验证 Queue 重试、用途错配、频控与不记录验证码。
- [ ] **CFG-003 微信支付/退款**：配置商户私钥、API v3 key、平台公钥/证书 ID、通知 URL；用测试商户覆盖支付、退款、重复/乱序通知和主动查询。
- [ ] **CFG-004 支付宝**：配置 app/seller、私钥、公钥、通知/返回 URL；验证签名、重复通知、未知结果与对账。
- [ ] **CFG-005 CRMEB 一号通**：配置 access/secret 与平台/供应商面单参数；验证签发、明确拒绝、断线未知、已有单号处置与禁止盲重试。
- [ ] **CFG-006 微信公众号/小程序/企微**：逐能力配置 app/secret、token/AES、可信域名和回调；每项单独启用，不使用一个总开关掩盖缺失配置。
- [ ] **CFG-007 打印与物流提供商**：迁移打印机凭据、物流 AppCode；验证脱敏、租户隔离、UNKNOWN 人工处置及 Queue/DLQ。

## P2：前端、测试与发布

- [ ] **FE-001 Admin 页面补齐**：旧 Admin 378 个 Vue 页面组件，新 Admin TS 55；组件数不可直接当覆盖率，需按 ADM checklist 建页面/路由/API/E2E 映射并消灭当前业务入口的 501。
- [ ] **FE-002 PC 对账**：旧 PC 30、新 PC TS 29 个页面组件；完成 22 条 `/api/pc` 合同、支付回跳、手机号安全验证和全订单生命周期 E2E。
- [ ] **FE-003 UniApp 对账**：旧 250、新 54 个页面组件；按 `pages.json` 核对活动、社区、会员、分销、客服、门店、核销及各小程序平台条件编译。
- [ ] **FE-004 Supplier 对账**：旧 41、新 13 个页面组件；完成订单/商品/售后/财务/打印/面单/附件真实流程与移动布局。
- [ ] **FE-005 Kefu 对账**：旧 Admin 客服目录 31 个组件，新工作台 2 个整合页面；除已通过的预览履约流外，必须用真实账号和生产兼容数据验证。
- [ ] **TEST-001 Linux CI**：建立 GitHub Actions，锁定 Node/npm，运行 Worker 单元/类型/runtime、五端构建、Kefu 测试、schema drift、route audit 和 secret scan。
- [ ] **TEST-002 Workers runtime**：在 Linux 或受支持主机让 `test:runtime` 真正进入断言；覆盖 Cron、Queue ack/retry/DLQ、KV、DO、WebSocket hibernation 和 R2。
- [ ] **TEST-003 性能与可观测性**：为 Hyperdrive 慢查询、Queue/DLQ、DO、R2、登录、支付、退款、打印/面单设置指标、结构化日志和告警阈值。
- [ ] **REL-001 发布候选门禁**：所有 P0 完成，相关 P1 域完成；生成变更清单、DB 前置、Secret/资源检查、回滚版本和 smoke tests。
- [ ] **REL-002 主 Worker 发布（BLOCKED：需明确批准）**：发布当前候选，确认版本流量 100%，执行健康/安全负向/关键只读和受控写 smoke test。
- [ ] **REL-003 Pages 发布（BLOCKED：需明确批准）**：为 Admin、H5、PC、Supplier、Kefu 建立明确项目映射，先预览后正式；记录每个 deployment ID 与 Git SHA。
- [ ] **REL-004 发布后观察与旧 PHP 下线**：至少观察登录/写入/支付/退款/Queue/Hyperdrive/R2/DO；完成流量切换、回滚演练、旧回调撤销和旧数据库只读封存后才能下线 PHP。

## 当前下一步

`DB-001`、`DB-002` 已完成并重新只读核对生产达到 217/217。下一项 `DB-003` 涉及删除冲突配置，必须先由运营确认权威值；`DATA-001` 需要源 MySQL 连接。等待外部条件期间继续处理不依赖真实凭据的路由合同，优先从 Kefu 剩余订单/退款合同和 Out API 安全写入边界开始；第三方配置和正式发布仍需要用户提供外部条件或明确批准。
