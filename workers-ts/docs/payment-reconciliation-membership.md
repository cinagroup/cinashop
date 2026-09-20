# 支付对账的会员订单类型边界

2026-09-19，本地修复，未提交、推送或部署。用户已确认新测试图片可读，本增量不再修改图片或缓存。

## 发现与修复

`PaidMembershipService.findMembershipOrderByOrderId` 只认可 `other_order.type=0/1` 的唯一订单，但 `PaymentReconciliationService` 的主动查单本地证据和人工 `ACCEPT_LOCAL` 原先只检查 `paid=1`，没有读取类型。这使已付的 type=3 收银订单、type=2 激活记录及非法类型可被当成会员支付证据。

首轮真实 PostgreSQL 16 测试为 **19通过、9失败**：四种非会员类型被人工确认为 `CONFIRMED`；主动查单在已知会员域和未解析域中均把 type=2/3 误判为“本地已付、渠道未成功”的冲突；独立连接锁住订单并将 type 从0改3后，人工接受仍成功。

两个入口现共用 `isPaidMembershipOrder`：必须 `paid=1` 且 `type=0/1`。仍按订单号最多读取两行，再检查唯一性，**不在 SQL 中先过滤类型**，因此同号会员行和收银行不会因过滤掉后者而伪装成唯一身份。人工处置保留 `FOR UPDATE`，等待其他写入提交后检查最新类型；错误拒绝不留下处置动作或案件更新。

正常 type=0/1、商城与充值人工接受路径不变。人工接受仍是带管理员身份、原因码、幂等键的明确覆盖操作，不新增对历史 `pay_type` 或 `trade_no` 的要求。未解析域仍不能人工接受。该修复不把 type=3 接入会员支付，也不修改会员有效期、余额或积分。

## 验证范围

新套件 `test/payment-reconciliation-membership.test.ts` 使用当前完整 ORM DDL、随机独立本机数据库和独立非所有者 LOGIN。维护账号仅安装夹具、预置数据、注入故障及观察锁；业务账号仅获得读取、取得订单行锁所需的 `UPDATE(id)`、案件更新、处置动作插入和对应序列权限，没有订单支付列或用户资金列写权限。

- 最终 **33项全部通过，零跳过**（15.20秒）；中间30项通过批次有重叠，不累加为独立用例数。
- 覆盖非会员类型拒绝、正常会员及重复动作、未付/缺失/同号多行、未解析域拒绝、商城/充值兼容、主动查单类型边界与混合类型歧义。
- 渠道适配器注入 `PENDING/SUCCESS`，真实案件领取、业务域查找、状态写入与人工处置代码执行；unsupported 类型在成功查单后仍为 `CONFLICT/order_missing`，不能触发会员结算。
- 独立 PostgreSQL 后端以 `pg_blocking_pids` 证明实际等待，再提交类型变更，验证锁后重验。通过 `pg_stat_activity` 观察渠道适配器开始时业务连接已为 `idle` 且 `xact_start=NULL`，案件领取已提交。
- 撤销动作插入权限、以及仅保留案件行锁权限后撤销后续更新权限，分别验证失败不留动作、不改变案件；明确验证业务角色不能改订单 `paid` 或用户资金。
- 三文件 **69项** 对账/回调/本机运行器回归通过；Worker主类型和运行时类型检查、运行器语法、作用域空白检查通过。首次主类型检查指出测试 mock 返回值被拓宽为 string，已改成显式泛型，未放宽生产类型。

Hono仅提供测试用的有类型服务构造边界，未伪造完整 `Env`。这里不是生产HTTP鉴权验收，不是真实微信/支付宝调用，也不是 Cloudflare runtime、Queue 或 Hyperdrive 集成测试。全局外部 fetch 被禁止；未访问生产数据。

可复验命令（已存在且可信的本机 PG16 二进制）：

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/payment-reconciliation-membership.test.ts
node node_modules/vitest/vitest.mjs run test/payment-reconciliation.test.ts test/payment-callback-event.test.ts test/local-finance-postgres-runner.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## 清理与剩余边界

本轮三个集群 `finance-postgres-7r8uKJ:50697`（红测）、`finance-postgres-5CIKJq:64485`、`finance-postgres-vylsDH:49639` 均清理随机测试库/角色并停机。独立只读主机检查逐一确认 `pg_ctl status=3`、无PID和启动口令文件、三个测试端口无监听、可信测试目录的PostgreSQL进程为0。停止的诊断目录保留，不删除已有文件。

这只是会员本地证据的类型修复，不是完整的跨表支付身份统一：已知域下其他表的同号冲突、回调/主动恢复共同的独立收银身份、金额上限及原始渠道冻结、余额与外部支付意图互斥、零元/期限、公开接口和页面、受控DDL及发布验收仍需继续审计和实现。不能以这33项测试宣称所有外部支付链路已完成。

Workers/PostgreSQL技能指导保留事务外渠道调用、真实行锁重验及非所有者最小权限验证。原九个暂存路径未变，未提交推送部署；`SUP-001`、`FE-003F` 保持开放，Checklist仍为240已勾选、164未勾选、404总项。
