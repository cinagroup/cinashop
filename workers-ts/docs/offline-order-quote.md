# 线下消费报价与支付域缺口审计

2026-09-19；本地候选，未提交、推送或部署。没有连接生产数据库或改动线上图片。

2026-09-20 当前规则：用户已明确禁止零元结算，折扣后应付须至少0.01元；报价、准入和支付均拒绝不足一分，不能擅自向上取整。当前完整接线、正式注册及本轮验收见[最低应付政策](offline-order-http.md#最低应付政策2026-09-20-最新决定本地未部署)。其余“未接线”描述保留为首次审计历史。

后续增量：已新增未接公开路由的真实建单准入候选，保存未支付 type=3 订单、不可变确认金额和请求防重凭据，见[建单准入及权限审计](offline-order-admission.md)。下文三条公开路由的开放状态不变，建单核心不等于收银支付完成。

## 结论与边界

旧站的线下消费是无商品的 `other_order.type=3` 收银订单，不是商城 `store_order` 的 `pay_type=offline`，也不是会员卡购买/扫码激活。此前推进会员节省金额时发现的缺口，必须恢复完整的独立订单域，不能只给商城支付任务多加一条账。

本增量仅恢复会员报价。下面两个收款相关接口仍未注册；未用静态支付方式或伪成功占位。

| 旧 API | 本增量状态 | 证据 |
| --- | --- | --- |
| `POST /api/order/offline/check/price` | 已实现，只读、强制顾客鉴权 | 实际 `apiRoutes`、Hono/JWT、原生 PG 测试 |
| `POST /api/order/offline/create` | 公开端点未实现、不开放；内部准入候选另验收 | 实际 HTTP 404 与静态路由审计 |
| `GET /api/order/offline/pay/type` | 未实现、不开放 | 实际 HTTP 404 与静态路由审计 |

未修改 PHP 权威快照、DDL、角色迁移、绑定、依赖或现有支付写入。没有重跑浏览器；没有新的可用收银页面。

## PHP 合同依据

源码在相邻 `cinashop-php` 仓库，非目标运行代码：

- `route/api.php:373` 起：上述三条路由。
- `app/controller/api/v1/order/OtherOrder.php:43`：当前付费会员及 offline 权益判断、BCMath 折扣、无会员报价时数字零。
- 同文件 `:77`、`:278`：建单及微信/余额/支付宝/线下分支、支付配置读取。
- `app/services/order/OtherOrderServices.php:162`、`:237`、`:365`：建单、支付成功、已付 type=3 收银记录。
- `app/jobs/order/OtherOrderJob.php:146`、`:179`：赠分和 `store_order_economize.order_type=2` 节省金额账本。
- `view/uniapp/pages/annex/offline_pay/index.vue`：报价使用 POST JSON `{pay_price: money}`；建单发送 `{type:3, price:payPrice || money, money, ...}`。

旧控制器在 POST 路由里调用 `getMore`，但实际客户端发 JSON。本实现按实际客户端接受 JSON body，不合并查询参数。不能照搬的旧行为还包括：信任客户端实付价、重付缺订单归属检查、任意回跳 URL、无可靠幂等的账本/赠分任务，以及计算余额开关后从支付方式响应中删除它。这些问题是后续写入合同的约束，不代表本轮已修复旧代码。

## 已实现的报价合同

- 只接受 body 字段 `pay_price`；流式读取最大 1 KiB。拒绝其他 body 字段，查询参数不参与金额、身份或权益。
- 金额必须为正数，最大 `99999999.99`，对应未来订单 `pay_price NUMERIC(10,2)` 上限。接受十进制字符串和 JSON 数字；数字按 JSON 解析后的值校验。精确金额调用应使用字符串。字符串不接受空白、正负号、指数、前导零、缺整数部分或超过两位小数。
- 当前用户只取真实顾客鉴权的 UID。报价 SQL 再核验用户未删除且状态为 1；不用鉴权阶段读取的会员标记。
- 用户资格、全局 `member_card_status` 和 `member_right.offline` 在**同一 SELECT/MVCC 快照**读取。会员资格为永久会员，或付费会员且到期秒数大于数据库当前语句时间。
- 配置按全局 `is_store=0`、`sort DESC/id DESC` 取一条；配置 `status` 是显示属性，不是开关。缺失/空值默认启用，兼容 JSON 编码字符串，只有规范化整数 1 启用，非法值报错。
- offline 权益保留最低 ID 的记录，即使该记录停用也不换用更高 ID。不存在、停用或 number=0 表示无报价。适用权益必须为整数 1–100；超过 100 报错，不生成加价报价。
- 用整数分和 BigInt 计算 `floor(rawCents × percent / 100)`，不使用浮点金额乘除。
- 无会员报价返回 `{pay_price: 0}`；有效报价返回至少0.01元的两位字符串，如 `{pay_price: "8.00"}`。`0.01 × 80%` 现在拒绝，不返回零元报价；**数字 0 哨兵仍不是免费付款**。
- 成功和错误均沿用私有 `no-store` 响应；SQL 故障不降级为零报价。报价服务无数据库写入、缓存或 provider 调用；生产鉴权既有 Redis 依赖未改变。

这是显示预览，不是签名报价、价格锁定或支付授权。未来建单必须重新计算并保存准入证据；不能相信浏览器回传的 `price`。本机直连 PG 证明不等于已验证生产 Hyperdrive 的查询缓存策略及实效，相关上线门禁仍开放。

## 完整收银功能仍需实现

1. **建单与身份**：服务器限定 type=3，确定门店/员工权限和订单所有者；绑定原始消费额、会员资格、offline 权益及最终实付的不可变证据。定义报价过期/变更重确认、零金额边界、严格金额编码，以及跨重试/刷新不重复建单的持久幂等合同。
2. **数据迁移及权限**：核验 `other_order` 唯一订单标识、支付意图/事件键、价格证据和状态记录；仅用显式注册迁移、最小运行角色和回滚/恢复验收，不运行时建表或修复历史行。
3. **支付能力与前端**：按权威开关、余额功能和 provider 凭据返回真实可用渠道；明确余额开关 DTO、允许的渠道/回跳域名。补收银页登录/换号隔离、提交互斥、未知结果只查不重付、持久恢复和服务器支付结果读取。支付方式接口随完整链路开放。
4. **余额和外部支付**：余额检查、扣款、账单、订单支付状态在同一事务中幂等提交，锁序与既有用户资金一致。微信/支付宝先持久化支付意图，外部 I/O 不放在资金事务里；超时进入 UNKNOWN，按原意图查询恢复，不能新建第二笔扣款。
5. **回调与重放**：验签、商户/用户/金额/币种/订单域/支付意图匹配，严格防止把商城或会员购买的回调应用到 type=3；同一状态转换一次，重复/乱序回调和迟后失败可恢复，不能依赖客户端“支付成功”。
6. **节省账本和赠分**：支付成功写 `order_type=2`、`offline_price=原始金额−实付`，按准入证据而非今日权益计算，唯一事件冲突验证不可变字段。赠分任务与用户积分/账单原子且可重试。PHP 的 `order_give_integral × pay_price` 截断及会员权益“加值”实现和“双倍”注释不一致，须明确实际业务合同后接线，不能凭注释修改算法。
7. **后续历史及补偿**：核对推广员条件、通知、收银记录筛选/权限/总数/金额、会员历史排除 type=3、异常退款或人工补偿规则；完成真实 Redis、最小角色、Hyperdrive、provider 和页面验收后再发布。

本项是付费会员/收银跨域依赖，不是供应商订单专属功能。SUP-001 中既有“线下 other_order 节省金额”提醒继续开放，FE-003F 收银台/线下支付也不关闭。Checklist 总数保持 **240 已勾选 / 164 开放 / 404 总计**。

## 本地验证与重跑

新测试 `test/offline-order-quote.test.ts` 必须使用专用原生 PG16 回环夹具；没有生产或 PGlite 回退。测试维护账号仅创建/清理随机测试数据库和独立 LOGIN 角色。HTTP 请求使用无 SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS 的角色，只授予三表 SELECT，并实际设置和核验 `default_transaction_read_only=on`。

测试包含金额上下界/截断/哨兵、JSON 字节边界、未知字段/查询伪造、真实 JWT/密码/封禁/删除、他人会员隔离、当前期限、配置和权益优先级、缺失/非法配置、鉴权后独立连接修改、未提交状态隔离与提交后重新读取、两条实际 SQL（鉴权＋一个报价查询）、权限故障和未开放端点。SQL 查询和鉴权返回不伪造；协调钩子仅在真实鉴权读取后让另一个 PG 连接提交变更。所有测试禁止 fetch，核验订单/节省金额/用户账单未新增。

该套件按完整 ORM 建表，**不是**完整注册迁移或生产权限验收。联合回归中的既有会员节省金额套件另使用自身完整迁移夹具，不能据此替代 offline 域尚未实现的迁移验证。

```powershell
# workers-ts 目录；使用当前本机的可信 Node 与 PG16 二进制
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/offline-order-quote.test.ts test/order-member-economize.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/http-cache-policy.test.ts test/response-cache.test.ts test/route-parity-audit.test.ts test/order-member-savings.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
node --check scripts/run-local-finance-postgres.mjs
node node_modules/tsx/dist/cli.mjs scripts/route-parity-audit.ts
```

阶段记录：最初 3 项均为真实 HTTP 404 红测；实现后 3/3，再扩展 66/66 通过；随后补充他人账号隔离。最终联合原生 PG16.15 两文件 **83 项**（报价 67、会员节省账本 16）零失败/跳过，耗时 125.74 秒。五文件 **107 项**纯计算/HTTP 缓存/运行器/路由解析回归通过。首次主类型检查暴露测试绑定强转、未知 JSON 和两个 this 标注问题；第二轮揭示生成绑定把 NODE_ENV 固定为 production，测试改用 Hono 支持的局部绑定，不改生产类型。最终 Worker 主类型、运行时类型、运行器语法和作用域空白检查通过；阶段批次有重叠，不相加为独立用例总数。

四次本机集群 `rMJyHT:62137`、`puKDWl:58426`、`O4O4p4:51336`、`uoUqMq:59375` 均由运行器核实随机夹具数据库和角色剩余为零并停止。另用获准的主机只读检查独立确认四处 `pg_ctl status` 为停止、无 postmaster PID/启动临时口令文件，四端口监听及可信测试 PostgreSQL 进程均为零。已停止的私有诊断目录保留，没有删除用户数据。原九个暂存路径保持，未暂存本增量。

只读静态路由审计当前为 PHP 1904、TS 1663、匹配 883、可执行匹配 862、未实现匹配 21、原始缺失 1021、退役 17、待处理缺失 1004；有效可执行覆盖 45.7%。这是全仓静态注册指标，不等于行为迁移完成率；未重写基线或权威快照。

Workers/PostgreSQL 技能影响本实现的请求字节上限、单语句权威读取、精确金额与独立只读角色验证。当前官方 Workers 参考和最新类型已检索；未因此改动无关绑定或升级依赖。
