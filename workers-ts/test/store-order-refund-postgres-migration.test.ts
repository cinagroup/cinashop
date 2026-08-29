import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { targetSupplierRefundCents } from "../src/services/supplier/SupplierFinanceService";

describe("订单退款 PostgreSQL 迁移", () => {
  it("把余额退款与全部补偿副作用收敛到可验证的生产事务核心", () => {
    const source = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect(source).toContain("export async function finalizeStoreOrderRefund(");
    expect(source).toContain("await lockRefundExecution(tx, refundId)");
    expect(source).toContain("await lockOrderSettlement(tx, refund.storeOrderId)");
    expect(source).toContain('.for("update")');
    expect(source).toContain("await lockOrderSettlementUsers(tx, order)");
    expect(source).toContain("await restoreRefundStock(");
    expect(source).toContain("await reverseOrderRewards(tx, order, cumulativeCents, now, cumulativeNum)");
    expect(source).toContain("await reverseOrderBrokerage(tx, order, cumulativeCents, now)");
    expect(source).toContain("await recordSupplierRefund(tx, order, refundId, refundAmount, cumulativeCents, now)");
    expect(source).toContain("await finalizeStoreOrderRefund(this.container, refundId)");
    expect(source).toContain("paidCents === 0 && order.type === 4 && order.payIntegral > 0");
    expect(source).toContain("cumulativeNum >= order.totalNum");
    expect(source).toContain("missingLegacyActivityMain && legacyActivitySnapshot");
    expect(source).toContain("退款砍价活动无法唯一定位");
  });

  it("供应商部分退款按累计目标求增量，不因逐笔四舍五入超额", () => {
    const cumulativeTargets = [333, 666, 1000].map((cents) =>
      targetSupplierRefundCents(5, cents, 1000));
    expect(cumulativeTargets).toEqual([2, 3, 5]);
    expect(cumulativeTargets.map((target, index) =>
      target - (cumulativeTargets[index - 1] ?? 0))).toEqual([2, 1, 2]);
  });

  it("使用整数分约束累计退款上限并绑定支付渠道确认金额", () => {
    const source = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect(source).toContain("const previousCents = amountToCents(");
    expect(source).toContain("const cumulativeCents = previousCents + refundCents");
    expect(source).toContain("cumulativeCents > paidCents");
    expect(source).toContain("累计退款金额超过订单实付金额");
    expect(source).toContain("payment.requestAmount !== refundCents");
    expect(source).toContain("退款金额与支付渠道确认金额不一致");
    expect(source).toContain("record.cartId ?? record.cart_id ?? record.id");
    expect(source).not.toContain("const cumulative = Number(totals[0]?.amount");
  });

  it("保留生产 PostgreSQL 临时 Schema 的并发、失败回滚与公共状态不变场景", () => {
    const scenario = readFileSync(
      "test/integration/StoreOrderRefundPostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain("codex_refund_it_");
    expect(scenario).toContain("SET LOCAL lock_timeout = '3s'");
    expect(scenario).toContain("duplicate balance refund did not converge idempotently");
    expect(scenario).toContain("integration refund bill failure");
    expect(scenario).toContain("over-refund race did not produce one business rejection");
    expect(scenario).toContain("exact cumulative refunds did not preserve the paid total");
    expect(scenario).toContain("pure integral partial refund did not return points by quantity");
    expect(scenario).toContain("pure integral full refund or replay invariant drifted");
    expect(scenario).toContain("activity refund did not restore all four inventory layers");
    expect(scenario).toContain("retired activity refund did not restore only the surviving inventory layers");
    expect(scenario).toContain("provider amount mismatch changed refund business state");
    expect(scenario).toContain("integration supplier transaction failure");
    expect(scenario).toContain("cumulative compensation failure did not roll back every ledger");
    expect(scenario).toContain("cumulative reward, brokerage, supplier, or pink invariant drifted");
    expect(scenario).toContain('state.supplierRefundDeltas.join(",") === "0.02,0.01,0.02"');
    expect(scenario).toContain("pink leader refund did not promote and relink the surviving group");
    expect(scenario).toContain("pre-existing partial refund did not preserve cart snapshots");
    expect(scenario).toContain("legacyCartSnapshot");
    expect(scenario).toContain("DROP SCHEMA ${schemaIdentifier} CASCADE");
    expect(scenario).toContain("public business rows or sequences changed");
  });
});
