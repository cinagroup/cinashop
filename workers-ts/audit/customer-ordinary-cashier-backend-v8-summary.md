# 普通商品收银后端 v8 源码与验收汇总

2026-10-13，普通商品隔离分支基于 `168d0005c4d6e9b17a99357a8b77f747eb7b9ac4`。完整源码哈希、原 17 份未提交文件的合并保护记录、16 路由、回执及原始日志哈希见 [JSON 汇总](customer-ordinary-cashier-backend-v8-summary.json)。本报告在 v8 实现检查结束后新增，不扩大该轮验收范围。

后端接入真实 type0 实体商品和多 SKU owner 草稿，支持追加/合并/恢复行、数量和移除操作，沿成熟创建/报价/库存/优惠券/积分/配送/等级价格/赠品/自定义表单/现金及真实零元流程。游客 `buyer_uid=0` 绑定真实 `tourist_key`，不构造用户0、积分、优惠券或地址归属。`creator_uid` 和实际 `payer_uid` 可以不同。

报价公开真实 `quote_fingerprint`、价格、总数量、积分政策、优惠券和赠积分/券/商品/标签活动；总数量含赠商品。活动 `threshold_type:1|2` 来自同次实际 gift intent，分别表示金额和件数。签名图片完成后再计算读封套 `SHA256({scope_key,data})`。多个非零自定义表单 ID 必须相同，零表单商品可混合。

`/api/mobile/work/cashier/ordinary` 下 16 条接口均用强制 UserJWT，actor/service/scope 从服务器实际来源核对：

| 方法 | 相对路径 | 用途 |
| --- | --- | --- |
| POST | `/drafts` | 建立 owner 多 SKU 草稿 |
| GET | `/drafts/:key` | 读取原草稿 |
| POST | `/drafts/:key/rows` | 追加、合并和恢复 SKU 行 |
| POST | `/drafts/:key/quantity` | 修改数量 |
| POST | `/drafts/:key/remove` | 移除并保留恢复事实 |
| POST | `/quote` | 原 creation UUID 的真实报价 |
| POST | `/orders` | 报价确认创建 |
| POST | `/orders/:id/cash` | 实际现金/零元支付 |
| GET | `/operations/:key` | owner 查询原 UUID 回执 |
| POST | `/operations/:key/abandon` | 原 UUID 永久终止或返回已提交事实 |
| GET | `/readiness` | 实际来源和权限验收状态 |
| GET | `/catalog` | 普通商品搜索及分页 |
| GET | `/catalog/:id` | 商品、多 SKU 和图片 |
| GET | `/users` | 会员搜索及分页 |
| GET | `/users/:uid/addresses` | 会员归属地址 |
| GET | `/quotes/:token/coupons` | 真实报价上下文的优惠券 |

草稿、创建、支付使用不同 UUID；完整原 intent 与 actor/key/hash/scope 绑定。报价 token 为 UUID 去横线生成的 32 位小写十六进制，绑定 actor 和原 creation UUID，期限 1800 秒。UNKNOWN 只查询原 UUID，GET null 仍保留未知操作。abandon 与原 POST 使用同一请求锁：真实提交先完成则返回原回执，abandon 先完成则永久阻止晚到原 POST。owner 在经营资格撤销后仍可读取/终止自己的原操作。

支付回执证明 durable payment 和真实 outbox 入账；消费者实际 COMPLETED 及受保护 creation/origin/payment 全事实相符后，才可作为人工退款来源。佣金测试验证真实创建计算和成熟等待订单完成的边界，没有提前派奖信用。

新 `cashier_ordinary_{draft,cart,operation,origin}_v1` 四表使用独立 literal owner 维护 SQL 和 append-only 保护，不增加 ORM PgTable cohort。新 PG16 目录 pin 为 `c3045d4094b759d189876d4883c2c984ffd89e7f48cd99745da564ef20860ab3`，由独立 fresh native fixture 生成并固定。安装入口只说明显式 root maintenance READ COMMITTED 事务；本工作仅在隔离测试库安装，没有执行生产 DDL 或部署，startup/runAll 不调用安装入口。

未完成真实 commissioning 时能力保持 closed。ready 要同时满足实际目录、原 scope/promotion 锁、普通模块精确 routine OID/owner/定义/ACL、来源表列序列函数、真实 LOGIN 和四表 SELECT/INSERT-only 权限。仅同 tx 的服务器私有 WeakMap capability 可复用既有 NOLOGIN taxonomy 锁并 fresh SELECT；旧路径保留 FOR SHARE，无新 taxonomy UPDATE grant。无新 realm SELECT 的成熟 app LOGIN 先走权限元数据检查，继续成熟 consumer 分支。原 16 manual pins/SQL/runAll、second-card-v1 与旧 wire 保持原样。

v8 完整结束，wrapper session `23468` exit0，四项代码 `[0,0,0,0]`：

| 检查 | 实际结果 |
| --- | --- |
| Workers `tsc --noEmit` | 完整类型检查 0 diagnostic |
| Workers runtime tsconfig | 完整类型检查 0 diagnostic |
| 完整合同测试文件 | 6 pass / 0 fail / 0 skip |
| 5 个完整 native 文件，原 600 秒 runner | 111 pass / 0 fail / 0 skip |

5 个 native 文件为新 ordinary catalog/business 和原 checkout coupon authority、paid labels、second-card 三文件。真实病例包含库存回滚、优惠券/积分/等级价/配送、赠品和 CSV 标签、原 UUID 及并发 abandon/晚到 POST、actor/hash/scope 冲突、creator≠payer、真实 UserJWT HTTP、原 app LOGIN 无新 realm 权限、NOLOGIN 标签锁 55P03 与完整奖励事务回滚、真实现金/零元及 consumer。

3889 份 captured 应用输入、2840 份 Worker 输入及 738 个 alias 在检查前后核对；28 份改动的后端源码/测试再次逐字节匹配 v8 冻结。原合并时的 17 份未提交文件（15 Worker +2 前端）全部原字节保护，后续增加 13 个 Worker 路径。旧物理工具 43992 份与独立正常 npm-ci/postinstall Worker 7639 份及 15 安装来源输入完整核对。owned PG `kDpMXF` 剩余 fixture0、STOPPED、独立 `pg_ctl status=3`。

原始 13 份 JSON/log 按原字节留在网盘忽略目录 `customer-ordinary-cashier-20261013-evidence/backend-v8`，archive manifest 逐份记录大小及 SHA。native log SHA `ae5fc80a8adc315069525440e583694c716fb4f9611f70ab6bbce40851599732`；source manifest SHA `e0fd53954fb34c18af12ffac44b49ef40804942134e494fb5741642fe91c28dd`。

历史失败完整保留：v1 跨 view 输入缺失及真实类型错误；v2 借用安装脚本原字节 EOL 不匹配；v3 fresh 正常 npm-ci 成功后旧输出原字节比较失败，独立新安装封套验真；v4 目录断言未取实际 P0001 导致 2 pass/1 fail；v5 修正后目录 3 pass；v6 原 taxonomy 权限 beforeAll 失败使 22 business 用例实际跳过；v7 地址空格预期和错误 JSON 标签种子造成 25 pass/2 fail/0 skip。v8 修正真实协议后完整通过，不把此前失败或跳过改记为成功。

本报告的信用限于 exact 后端实现、fixture、两套 Workers 类型和上述完整测试文件。未取得整个仓库、当前前端安装、UI、生产权限、生产 DDL 或部署通过信用。原 app LOGIN 测试针对实际 fixture cohort，没有扩大为全店 profile admission 或额外 legacy 无 ordinary origin 用例。当前分支仍需由 Root 整合后续公共 CI 修复及前端独立验收后统一提交；本次没有 commit/push。