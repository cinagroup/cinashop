import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MigrationService } from "@/services/MigrationService";
import { prepareOrderQueueDeadLetter } from "@/services/order/OrderQueueDeadLetterService";
import {
  consumePaymentReconciliationMessage,
  isPaymentReconciliationDispatchMessage,
  isPaymentReconciliationMessage,
  paymentReconciliationBackoff,
} from "@/services/payment/PaymentReconciliationService";

const replayKey = "00000000-0000-4000-8000-000000000002";
const body = {
  action: "processPaymentReconciliation" as const,
  caseId: 52,
  replayKey,
};

describe("CORE-001-C active payment reconciliation", () => {
  it("keeps Queue payloads opaque and rejects expanded or malformed contracts", () => {
    expect(isPaymentReconciliationMessage(body)).toBe(true);
    expect(isPaymentReconciliationMessage({ ...body, orderNo: "private-order" })).toBe(false);
    expect(isPaymentReconciliationMessage({ ...body, replayKey: "invalid" })).toBe(false);
    expect(isPaymentReconciliationDispatchMessage({
      action: "dispatchPaymentReconciliation",
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
    })).toBe(true);
    expect(isPaymentReconciliationDispatchMessage({
      action: "dispatchPaymentReconciliation",
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
      provider: "wechat",
    })).toBe(false);
  });

  it("allows only validated opaque reconciliation jobs to be replayed from the DLQ", () => {
    expect(prepareOrderQueueDeadLetter(body)).toEqual({
      messageType: "processPaymentReconciliation",
      replayPolicy: "ALLOW",
      body,
      replayMessage: body,
    });
    const dispatch = {
      action: "dispatchPaymentReconciliation" as const,
      scheduledAt: 1_800_000_000_000,
      cursor: 0,
    };
    expect(prepareOrderQueueDeadLetter(dispatch)).toEqual({
      messageType: "dispatchPaymentReconciliation",
      replayPolicy: "ALLOW",
      body: dispatch,
      replayMessage: dispatch,
    });
  });

  it("uses bounded exponential provider-query backoff", () => {
    expect(paymentReconciliationBackoff(1)).toBe(60);
    expect(paymentReconciliationBackoff(2)).toBe(120);
    expect(paymentReconciliationBackoff(12)).toBe(21_600);
    expect(paymentReconciliationBackoff(100)).toBe(21_600);
  });

  it.each([
    "settled",
    "confirmed",
    "waiting",
    "no-payment",
    "unknown",
    "conflict",
    "dead",
    "already-terminal",
  ] as const)("acknowledges durable %s outcomes", async (result) => {
    const ack = vi.fn();
    const retry = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack, retry },
      { processMessage: vi.fn().mockResolvedValue(result) },
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries active leases, scheduled deferrals and storage failures", async () => {
    const retryBusy = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryBusy },
      { processMessage: vi.fn().mockResolvedValue("busy") },
    );
    expect(retryBusy).toHaveBeenCalledWith({ delaySeconds: 30 });

    const retryDeferred = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryDeferred },
      { processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 73 }) },
    );
    expect(retryDeferred).toHaveBeenCalledWith({ delaySeconds: 73 });

    const retryFailure = vi.fn();
    await consumePaymentReconciliationMessage(
      { body, attempts: 3, ack: vi.fn(), retry: retryFailure },
      { processMessage: vi.fn().mockRejectedValue(new Error("postgres unavailable")) },
    );
    expect(retryFailure).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it("keeps external and embedded DDL byte-for-byte identical and fail-closed", () => {
    const external = readFileSync("migrations/0121_payment_reconciliation.sql", "utf8");
    expect(new MigrationService({} as never).paymentReconciliationMigrationSqlForVerification())
      .toBe(external);
    expect((external.match(/^CREATE TABLE IF NOT EXISTS/gm) ?? [])).toHaveLength(2);
    expect(external).toContain("0127 payment reconciliation relation shape verification failed");
    expect(external).toContain("0127 payment reconciliation constraint set verification failed");
    expect(external).toContain("0127 payment reconciliation index set verification failed");
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
  });

  it("registers recovery intent before provider I/O across all external payment domains", () => {
    // Follow the current admission boundary and its awaited provider hook.
    // A bare substring (or indexOf=-1) cannot establish callback execution or
    // commit ordering. Actual three-domain Mini execution remains covered by
    // routine-payment-callers.test.ts; this guards the full static wiring.
    const tree = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const nodes = <T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] => {
      const found: T[] = [];
      const visit = (node: ts.Node) => { if (guard(node)) found.push(node); ts.forEachChild(node, visit); };
      visit(root); return found;
    };
    const one = <T,>(values: T[]): T => { expect(values).toHaveLength(1); return values[0]!; };
    const method = (file: ts.SourceFile, name: string) => one(nodes(file, ts.isMethodDeclaration).filter(node => node.name.getText(file) === name));
    const fn = (file: ts.SourceFile, name: string) => one(nodes(file, ts.isFunctionDeclaration).filter(node => node.name?.text === name));
    const calls = (root: ts.Node, name: string) => nodes(root, ts.isCallExpression).filter(node => node.expression.getText(root.getSourceFile()) === name);
    const awaited = (call: ts.CallExpression) => { expect(ts.isAwaitExpression(call.parent)).toBe(true); return call; };
    const before = (first: ts.Node, second: ts.Node) => expect(first.getStart()).toBeLessThan(second.getStart());
    const literal = (node: ts.Expression) => {
      while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
      expect(ts.isStringLiteral(node)).toBe(true); return (node as ts.StringLiteral).text;
    };
    const property = (object: ts.ObjectLiteralExpression, name: string) => one(object.properties.filter(node =>
      ts.isPropertyAssignment(node) && node.name.getText(object.getSourceFile()) === name)) as ts.PropertyAssignment;
    const initiated = (call: ts.CallExpression) => call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])
      && call.arguments[1].properties.some(node => ts.isPropertyAssignment(node) && node.name.getText() === 'initiated'
        && node.initializer.kind === ts.SyntaxKind.TrueKeyword);
    const store = tree("src/services/order/StoreOrderPayService.ts"), recharge = tree("src/services/payment/RechargePaymentService.ts");
    const membership = tree("src/services/user/PaidMembershipService.ts"), wechat = tree("src/services/wechat/WechatPayService.ts");
    const admission = tree("src/services/payment/PaymentInitiationAdmission.ts"), mini = tree("src/services/payment/RoutinePaymentInitiation.ts");
    for (const [file, name, domain] of [[store, 'wechatPay', 'store_order'], [recharge, 'startWechatPayment', 'recharge'],
      [membership, 'payOrder', 'membership']] as const) {
      const entry = method(file, name), provider = awaited(one(nodes(entry, ts.isCallExpression).filter(call =>
        ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'createOrder'
        && ts.isNewExpression(call.expression.expression) && call.expression.expression.expression.getText(file) === 'WechatPayService')));
      expect(provider.arguments).toHaveLength(1); expect(ts.isObjectLiteralExpression(provider.arguments[0]!)).toBe(true);
      const input = provider.arguments[0] as ts.ObjectLiteralExpression;
      const hook = one(nodes(input, ts.isPropertyAssignment).filter(node => node.name.getText(file) === 'beforeProviderRequest'));
      let callback = hook.initializer;
      if (ts.isIdentifier(callback)) {
        const initializer = one(nodes(entry, ts.isVariableDeclaration).filter(node => node.name.getText(file) === callback.getText(file))).initializer!;
        expect(ts.isConditionalExpression(initializer)).toBe(true);
        callback = (initializer as ts.ConditionalExpression).whenFalse;
      }
      expect(ts.isArrowFunction(callback)).toBe(true);
      awaited(one(calls(callback, 'admitExternalPaymentInitiation')));
      const routine = one(nodes(entry, ts.isVariableDeclaration).filter(node => node.name.getText(file) === 'routinePayer')).initializer!;
      expect(ts.isConditionalExpression(routine)).toBe(true);
      expect((routine as ts.ConditionalExpression).condition.getText(file).replace(/\s/g, '')).toBe("identity.profile==='routine'");
      expect((routine as ts.ConditionalExpression).whenTrue.getText(file)).toBe('admission');
      expect((routine as ts.ConditionalExpression).whenFalse.getText(file)).toBe('undefined');
      expect(nodes(input, ts.isShorthandPropertyAssignment).filter(node => node.name.text === 'routinePayer')).toHaveLength(1);
      const local = domain === 'store_order' ? fn(store, 'prepareStoreOrderPaymentAdmission')
        : domain === 'membership' ? method(membership, 'paymentAdmission') : entry;
      expect(literal(one(nodes(local, ts.isPropertyAssignment).filter(node => node.name.getText() === 'orderDomain')).initializer)).toBe(domain);
    }
    const storeAli = method(store, 'alipayPay'), storeGate = awaited(one(calls(storeAli, 'admitExternalPaymentInitiation')));
    const storeUrl = one(nodes(storeAli, ts.isReturnStatement).filter(node => node.expression && ts.isTemplateExpression(node.expression)));
    before(awaited(one(calls(storeAli, 'signAlipayParams'))), storeGate); before(storeGate, storeUrl);
    before(awaited(one(calls(storeAli, 'assertExternalPaymentReplay'))), storeUrl);
    const memberPay = method(membership, 'payOrder'), memberGate = awaited(one(calls(memberPay, 'admitExternalPaymentInitiation').filter(call =>
      ts.isObjectLiteralExpression(call.arguments[1]!) && literal(property(call.arguments[1] as ts.ObjectLiteralExpression, 'provider').initializer) === 'alipay')));
    before(awaited(one(calls(memberPay, 'this.createAlipayUrl'))), memberGate);
    before(memberGate, one(nodes(memberPay, ts.isReturnStatement).filter(node => node.expression && ts.isObjectLiteralExpression(node.expression)
      && node.expression.properties.some(p => ts.isShorthandPropertyAssignment(p) && p.name.text === 'payUrl'))));

    const publicAdmission = fn(admission, 'admitExternalPaymentInitiation'), run = fn(admission, 'run'), evaluate = fn(admission, 'evaluate');
    const delegate = one(calls(publicAdmission, 'run')); expect(delegate.parent.kind).toBe(ts.SyntaxKind.ReturnStatement);
    expect(delegate.arguments.map(node => node.getText(admission))).toEqual(['container', 'input', 'false']);
    const transaction = awaited(one(calls(run, 'withTx'))); expect(calls(transaction, 'evaluate')).toHaveLength(1);
    awaited(one(calls(transaction, 'evaluate')));
    const registered = awaited(one(calls(evaluate, 'registerPaymentReconciliationTx').filter(initiated)));
    before(awaited(one(calls(evaluate, 'input.admission.lockOrder'))), registered);
    before(awaited(one(calls(evaluate, 'lockPaymentReconciliationRegistrationTx'))), registered);
    expect(nodes(admission, ts.isCallExpression).some(call => /^(?:fetch|.*\.(?:callApi|createOrder))$/.test(call.expression.getText(admission)))).toBe(false);
    const provider = method(wechat, 'createOrder'), providerPost = one(calls(provider, 'this.callApi').filter(call => literal(call.arguments[0]!) === 'POST'));
    before(awaited(one(calls(provider, 'params.beforeProviderRequest'))), awaited(providerPost));
    const miniProvider = method(wechat, 'createRoutineOrder'), reserve = fn(mini, 'reserveRoutinePayment');
    before(awaited(one(calls(miniProvider, 'reserveRoutinePayment'))), awaited(one(calls(miniProvider, 'this.callApi'))));
    const miniRegistration = awaited(one(calls(reserve, 'registerPaymentReconciliationTx').filter(initiated)));
    before(awaited(one(calls(reserve, 'input.admission.lockOrder'))), miniRegistration);
    expect(one(calls(reserve, 'withRoutinePaymentPublicSource')).parent.kind).toBe(ts.SyntaxKind.ReturnStatement);
  });

  it("wires callback evidence, provider queries, cron recovery and guarded admin decisions", () => {
    const callback = readFileSync("src/services/payment/PaymentCallbackEventService.ts", "utf8");
    const reconciliation = readFileSync(
      "src/services/payment/PaymentReconciliationService.ts",
      "utf8",
    ).replace(/\r\n/g, "\n");
    const wechat = readFileSync("src/services/wechat/WechatPayService.ts", "utf8");
    const alipay = readFileSync("src/services/payment/AlipayTradeQueryService.ts", "utf8");
    const entry = readFileSync("src/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const persistence = readFileSync('src/services/payment/PaymentCallbackPersistence.ts', 'utf8');
    expect(persistence).toContain("registerPaymentReconciliationTx");
    expect(callback).toContain('persistVerifiedPaymentCallbackTx(tx, callback)');
    expect(callback).toContain("resolvePaymentReconciliationFromCallbackTx");
    expect(reconciliation).toContain("Provider I/O is deliberately outside every PostgreSQL transaction");
    expect(reconciliation).toContain('.for("update", {\n        skipLocked: true,');
    expect(wechat).toContain("/v3/pay/transactions/out-trade-no/");
    expect(alipay).toContain('method: "alipay.trade.query"');
    expect(entry).toContain('action: "dispatchPaymentReconciliation"');
    expect(entry).toContain("consumePaymentReconciliationMessage");
    expect(adminRoutes).toContain('"/order/payment-reconciliation"');
    expect(adminRoutes).toContain('"/order/payment-reconciliation/:id/decision"');
  });

  it("keeps the production-engine audit isolated, gated and bound to the exact Hyperdrive", () => {
    const worker = readFileSync(
      "test/integration/PaymentReconciliationAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/payment-reconciliation-audit.wrangler.jsonc",
      "utf8",
    );
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(worker).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(worker).toContain("AUDIT_MIGRATE_TOKEN_SHA256");
    expect(worker).toContain("AUDIT_ISOLATED_TOKEN_SHA256");
    expect(worker).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(worker).toContain("DROP SCHEMA IF EXISTS");
    expect(worker).toContain("temporary_schema_removed");
    expect(worker).toContain("provider_success_settles_once");
    expect(worker).toContain("repeated_aged_not_found_is_no_payment");
    expect(worker).toContain("manual_actions_are_immutable_and_idempotent");
    expect(worker).toContain("callback_resolves_same_case");
  });
});
