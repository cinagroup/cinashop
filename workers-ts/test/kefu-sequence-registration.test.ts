import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Container } from "../src/lib/di";
import { MigrationService } from "../src/services/MigrationService";
import { KEFU_SEQUENCE_ALIGNMENT_SQL } from "../src/migrations/kefuSequenceAlignment";
import { runKefuSequenceAlignment } from "../src/migrations/runKefuSequenceAlignment";
import { PINK_RECOVERY_INDEX_SQL } from "../src/migrations/pinkRecoveryIndex";
import { runPinkRecoveryIndex } from "../src/migrations/runPinkRecoveryIndex";
import { FOREIGN_KEY_CHILD_INDEX_SQL } from "../src/migrations/foreignKeyChildIndexes";
import { runForeignKeyChildIndexes } from "../src/migrations/runForeignKeyChildIndexes";
import { WORK_CONTACT_CLIENT_INDEX_SQL } from "../src/migrations/workContactClientIndex";
import { runWorkContactClientIndex } from "../src/migrations/runWorkContactClientIndex";
import { BARGAIN_CART_PARTICIPATION_SQL } from "../src/migrations/bargainCartParticipation";
import { runBargainCartParticipation } from "../src/migrations/runBargainCartParticipation";
import { BROKERAGE_PAID_ORDER_FENCE_SQL } from "../src/migrations/brokeragePaidOrderFence";
import { runBrokeragePaidOrderFence } from "../src/migrations/runBrokeragePaidOrderFence";
import { COUPON_PRODUCT_SCOPE_FENCE_SQL } from "../src/migrations/couponProductScopeFence";
import { runCouponProductScopeFence } from "../src/migrations/runCouponProductScopeFence";
import { runShippingLifecycle } from "../src/migrations/runShippingLifecycle";
import { SHIPPING_LIFECYCLE_INSTALLATION_SQL } from "../src/migrations/shippingLifecycleInstallation";
import { runShippingLifecycleIndexes } from '../src/migrations/runShippingLifecycleIndexes';
import { SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL } from '../src/migrations/shippingLifecycleIndexInstallation';
import { runShippingTemplateCreateReplay } from '../src/migrations/runShippingTemplateCreateReplay';
import { SHIPPING_CREATE_REPLAY_INSTALLATION_SQL } from '../src/migrations/shippingTemplateCreateReplayInstallation';
import { runAdminRefundOperation } from '../src/migrations/runAdminRefundOperation';
import { ADMIN_REFUND_OPERATION_INSTALLATION_SQL } from '../src/migrations/adminRefundOperationInstallation';
import { runAdminRefundCreation } from '../src/migrations/runAdminRefundCreation';
import { ADMIN_REFUND_CREATION_INSTALLATION_SQL } from '../src/migrations/adminRefundCreationInstallation';
import { INVOICE_EVIDENCE_INSTALLATION_SQL } from '../src/migrations/invoiceEvidenceInstallation';
import { runInvoiceEvidenceSchema } from '../src/migrations/runInvoiceEvidence';
import { runRefundOrderSplitSchema } from '../src/migrations/runRefundOrderSplit';
import { REFUND_SPLIT_INSTALLATION_SQL } from '../src/migrations/refundOrderSplitInstallation';
import { OFFLINE_INSTALLATION_SQL } from '../src/migrations/offlineOrderInstallation';
import { runOfflineOrderSchema } from '../src/migrations/runOfflineOrder';
import { CHECKOUT_PRICING_LOCK_INSTALLATION_SQL } from '../src/migrations/checkoutPricingLockInstallation';
import { runCheckoutPricingLockSchema } from '../src/migrations/runCheckoutPricingLock';
import { runPresaleDeliveryOutbox } from '../src/migrations/runPresaleDeliveryOutbox';
import { runSupplierRefundLookupIndexes } from '../src/migrations/runSupplierRefundLookupIndexes';
import { SUPPLIER_REFUND_LOOKUP_INDEX_SQL } from '../src/migrations/supplierRefundLookupIndexes';
import { runPurchaseOriginEvidenceSchema } from '../src/migrations/runPurchaseOriginEvidence';
import { PURCHASE_ORIGIN_INSTALLATION_SQL } from '../src/migrations/purchaseOriginEvidenceInstallation';
import { PURCHASE_CANCELLATION_INSTALLATION_SQL } from '../src/migrations/purchaseCancellationEvidenceInstallation';
import { runPurchaseCancellationEvidenceSchema } from '../src/migrations/runPurchaseCancellationEvidence';
import { ASSISTED_ORDER_LIST_INDEX_SQL } from '../src/migrations/assistedOrderListIndex';
import { runAssistedOrderListIndex } from '../src/migrations/runAssistedOrderListIndex';
import { SECKILL_SKU_IDENTITY_FENCE_SQL } from '../src/migrations/seckillSkuIdentityFence';
import { runSeckillSkuIdentityFence } from '../src/migrations/runSeckillSkuIdentityFence';
import { MEMBER_BARCODE_INDEX_SQL } from '../src/migrations/memberBarcodeIndex';
import { runMemberBarcodeIndex } from '../src/migrations/runMemberBarcodeIndex';

// These tests cover orchestration only. The real unmocked runner and fresh
// MigrationService.runAll execute against dedicated PG16 databases in CI.
vi.mock("../src/migrations/runKefuSequenceAlignment", () => ({ runKefuSequenceAlignment: vi.fn() }));
vi.mock("../src/migrations/runPinkRecoveryIndex", () => ({ runPinkRecoveryIndex: vi.fn() }));
vi.mock("../src/migrations/runForeignKeyChildIndexes", () => ({ runForeignKeyChildIndexes: vi.fn() }));
vi.mock("../src/migrations/runWorkContactClientIndex", () => ({ runWorkContactClientIndex: vi.fn() }));
vi.mock("../src/migrations/runBargainCartParticipation", () => ({ runBargainCartParticipation: vi.fn() }));
vi.mock("../src/migrations/runBrokeragePaidOrderFence", () => ({ runBrokeragePaidOrderFence: vi.fn() }));
vi.mock("../src/migrations/runCouponProductScopeFence", () => ({ runCouponProductScopeFence: vi.fn() }));
vi.mock("../src/migrations/runShippingLifecycle", () => ({ runShippingLifecycle: vi.fn() }));
vi.mock('../src/migrations/runShippingLifecycleIndexes', () => ({ runShippingLifecycleIndexes: vi.fn() }));
vi.mock('../src/migrations/runShippingTemplateCreateReplay', () => ({ runShippingTemplateCreateReplay: vi.fn() }));
vi.mock('../src/migrations/runAdminRefundOperation', () => ({ runAdminRefundOperation: vi.fn() }));
vi.mock('../src/migrations/runAdminRefundCreation', () => ({ runAdminRefundCreation: vi.fn() }));
vi.mock('../src/migrations/runInvoiceEvidence', () => ({ runInvoiceEvidenceSchema: vi.fn() }));
vi.mock('../src/migrations/runRefundOrderSplit', () => ({ runRefundOrderSplitSchema: vi.fn() }));
vi.mock('../src/migrations/runOfflineOrder', () => ({ runOfflineOrderSchema: vi.fn() }));
vi.mock('../src/migrations/runCheckoutPricingLock', () => ({ runCheckoutPricingLockSchema: vi.fn() }));
vi.mock('../src/migrations/runPresaleDeliveryOutbox', () => ({ runPresaleDeliveryOutbox: vi.fn() }));
vi.mock('../src/migrations/runSupplierRefundLookupIndexes', () => ({ runSupplierRefundLookupIndexes: vi.fn() }));
vi.mock('../src/migrations/runPurchaseOriginEvidence', () => ({ runPurchaseOriginEvidenceSchema: vi.fn() }));
vi.mock('../src/migrations/runPurchaseCancellationEvidence', () => ({ runPurchaseCancellationEvidenceSchema: vi.fn() }));
vi.mock('../src/migrations/runAssistedOrderListIndex', () => ({ runAssistedOrderListIndex: vi.fn() }));
vi.mock('../src/migrations/runSeckillSkuIdentityFence', () => ({ runSeckillSkuIdentityFence: vi.fn() }));
vi.mock('../src/migrations/runMemberBarcodeIndex', () => ({ runMemberBarcodeIndex: vi.fn() }));
const runner = vi.mocked(runKefuSequenceAlignment);
const pinkRunner = vi.mocked(runPinkRecoveryIndex);
const childRunner = vi.mocked(runForeignKeyChildIndexes);
const contactRunner = vi.mocked(runWorkContactClientIndex);
const bargainRunner = vi.mocked(runBargainCartParticipation);
const paidRunner = vi.mocked(runBrokeragePaidOrderFence);
const couponRunner = vi.mocked(runCouponProductScopeFence);
const shippingRunner = vi.mocked(runShippingLifecycle);
const shippingIndexRunner = vi.mocked(runShippingLifecycleIndexes);
const replayRunner = vi.mocked(runShippingTemplateCreateReplay);
const refundRunner = vi.mocked(runAdminRefundOperation);
const creationRunner = vi.mocked(runAdminRefundCreation);
const invoiceRunner = vi.mocked(runInvoiceEvidenceSchema);
const splitRunner = vi.mocked(runRefundOrderSplitSchema);
const offlineRunner = vi.mocked(runOfflineOrderSchema);
const pricingRunner = vi.mocked(runCheckoutPricingLockSchema);
const presaleRunner = vi.mocked(runPresaleDeliveryOutbox);
const supplierLookupRunner = vi.mocked(runSupplierRefundLookupIndexes);
const originRunner = vi.mocked(runPurchaseOriginEvidenceSchema);
const cancellationRunner = vi.mocked(runPurchaseCancellationEvidenceSchema);
const assistedListRunner = vi.mocked(runAssistedOrderListIndex);
const seckillSkuRunner = vi.mocked(runSeckillSkuIdentityFence);
const memberBarcodeRunner = vi.mocked(runMemberBarcodeIndex);
const dialect = new PgDialect();
const root = resolve(import.meta.dirname, "..");
const names = Array.from({ length: 174 }, (_, i) => String(i).padStart(4, "0"));

function harness(failure?: { index: number; error: unknown }, superseded = false) {
  let depth = 0, index = 0;
  const sqlCalls: Array<{ index: number; sql: string }> = [];
  const transaction = vi.fn(async (callback: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>) => {
    const current = index++;
    depth++;
    try {
      return await callback({ execute: async query => {
        const statement = dialect.sqlToQuery(query).sql;
        sqlCalls.push({ index: current, sql: statement });
        if (statement !== "SET LOCAL search_path TO public, pg_temp" && failure?.index === current) throw failure.error;
        return [{ applied: superseded }];
      } });
    } finally { depth--; }
  });
  // Deliberate orchestration-only double; no driver/client is created. Real
  // database shape and SQL semantics are tested in the existing PG16 paths.
  const container = { db: { transaction, execute: vi.fn(async () => [{ presale_ready: false }]) } } as unknown as Container;
  runner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0151 must receive the root DB outside an outer transaction").toBe(0);
  });
  pinkRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0152 must also receive the root DB outside an outer transaction").toBe(0);
    expect(runner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  childRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0153 must receive the root DB outside an outer transaction").toBe(0);
    expect(pinkRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  contactRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0154 must receive the root DB outside an outer transaction").toBe(0);
    expect(childRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  bargainRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0155 must receive the root DB outside an outer transaction").toBe(0);
    expect(contactRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  paidRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0156 must receive the root DB outside an outer transaction").toBe(0);
    expect(bargainRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  couponRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0157 must receive the root DB outside an outer transaction").toBe(0);
    expect(paidRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  shippingRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, "0158 must receive the root DB outside an outer transaction").toBe(0);
    expect(couponRunner).toHaveBeenCalledExactlyOnceWith(container.db);
    return { applied: true };
  });
  shippingIndexRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, '0159 must receive the root DB').toBe(0);
    expect(shippingRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  replayRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, '0160 must receive the root DB').toBe(0);
    expect(shippingIndexRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  refundRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, '0161 must receive the root DB').toBe(0);
    expect(replayRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  creationRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, '0162 must receive the root DB').toBe(0);
    expect(refundRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  invoiceRunner.mockImplementation(async db => {
    expect(db).toBe(container.db);
    expect(depth, '0163 must receive the root DB').toBe(0);
    expect(creationRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  splitRunner.mockImplementation(async db=>{
    expect(db).toBe(container.db);expect(depth,'0164 must receive the root DB').toBe(0);
    expect(invoiceRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  offlineRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0165 must receive the root DB').toBe(0);
    expect(splitRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  pricingRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0166 must receive the root DB').toBe(0);
    expect(offlineRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  presaleRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0167 must receive the root DB').toBe(0);
    expect(pricingRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  supplierLookupRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0168 must receive the root DB').toBe(0);
    expect(presaleRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  originRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0169 must receive the root DB').toBe(0);
    expect(supplierLookupRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  cancellationRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0170 must receive the root DB').toBe(0);
    expect(originRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  assistedListRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0171 must receive the root DB').toBe(0);
    expect(cancellationRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  seckillSkuRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0172 must receive the root DB').toBe(0);
    expect(assistedListRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  memberBarcodeRunner.mockImplementation(async db => {
    expect(db).toBe(container.db); expect(depth, '0173 must receive the root DB').toBe(0);
    expect(seckillSkuRunner).toHaveBeenCalledExactlyOnceWith(container.db);
  });
  return { service: new MigrationService(container), transaction, sqlCalls, db: container.db };
}

beforeEach(() => {
  runner.mockReset();
  pinkRunner.mockReset();
  childRunner.mockReset();
  contactRunner.mockReset();
  bargainRunner.mockReset();
  paidRunner.mockReset();
  couponRunner.mockReset();
  shippingRunner.mockReset();
  shippingIndexRunner.mockReset();
  replayRunner.mockReset();
  refundRunner.mockReset();
  creationRunner.mockReset();
  invoiceRunner.mockReset();
  splitRunner.mockReset();
  offlineRunner.mockReset();
  pricingRunner.mockReset();
  presaleRunner.mockReset();
  supplierLookupRunner.mockReset();
  originRunner.mockReset();
  cancellationRunner.mockReset();
  assistedListRunner.mockReset();
  seckillSkuRunner.mockReset();
  memberBarcodeRunner.mockReset();
});

describe("embedded 0151 sequence registration", () => {
  it("retains 0151 once, followed by 0152–0173, with the unchanged numeric 0000–0150 registry", () => {
    const source = readFileSync(resolve(root, "src/services/MigrationService.ts"), "utf8");
    const file = ts.createSourceFile("MigrationService.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const service = file.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "MigrationService");
    expect(service && ts.isClassDeclaration(service)).toBe(true);
    if (!service || !ts.isClassDeclaration(service)) throw new Error("MigrationService class missing");
    const runAll = service.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(file) === "runAll");
    if (!runAll || !ts.isMethodDeclaration(runAll)) throw new Error("runAll missing");
    const declarations = runAll.body!.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations);
    const array = declarations.find(d => d.name.getText(file) === "migrations")?.initializer;
    if (!array || !ts.isArrayLiteralExpression(array)) throw new Error("Numbered registry missing");
    expect(array.elements.map(e => e.getText(file))).toEqual(names.map(n => `this.migration_${n}()`));
    const setup = harness();
    expect(setup.service.kefuSequenceAlignmentMigrationSqlForVerification()).toBe(KEFU_SEQUENCE_ALIGNMENT_SQL);
    expect(KEFU_SEQUENCE_ALIGNMENT_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0145_kefu_sequence_alignment.sql"), "utf8").trim());
    expect(setup.service.bargainCartParticipationMigrationSqlForVerification()).toBe(BARGAIN_CART_PARTICIPATION_SQL);
    expect(BARGAIN_CART_PARTICIPATION_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0149_bargain_cart_participation.sql"), "utf8").trim());
    expect(setup.service.brokeragePaidOrderFenceMigrationSqlForVerification()).toBe(BROKERAGE_PAID_ORDER_FENCE_SQL);
    expect(BROKERAGE_PAID_ORDER_FENCE_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0150_brokerage_paid_order_fence.sql"), "utf8").trim());
    expect(setup.service.couponProductScopeFenceMigrationSqlForVerification()).toBe(COUPON_PRODUCT_SCOPE_FENCE_SQL);
    expect(COUPON_PRODUCT_SCOPE_FENCE_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0151_coupon_product_scope_fence.sql"), "utf8").trim());
    expect(setup.service.shippingLifecycleMigrationSqlForVerification()).toBe(SHIPPING_LIFECYCLE_INSTALLATION_SQL);
    expect(SHIPPING_LIFECYCLE_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root, "migrations/0152_shipping_lifecycle.sql"), "utf8").trim());
    expect(setup.service.shippingLifecycleIndexMigrationSqlForVerification()).toBe(SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL);
    expect(SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root, 'migrations/0153_shipping_lifecycle_indexes.sql'), 'utf8').trim());
    expect(setup.service.shippingCreateReplayMigrationSqlForVerification()).toBe(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL);
    expect(SHIPPING_CREATE_REPLAY_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root, 'migrations/0154_shipping_template_create_replay.sql'), 'utf8').trim());
    expect(setup.service.adminRefundOperationMigrationSqlForVerification()).toBe(ADMIN_REFUND_OPERATION_INSTALLATION_SQL);
    expect(setup.service.adminRefundCreationMigrationSqlForVerification()).toBe(ADMIN_REFUND_CREATION_INSTALLATION_SQL);
    expect(setup.service.invoiceEvidenceMigrationSqlForVerification()).toBe(INVOICE_EVIDENCE_INSTALLATION_SQL);
    expect(INVOICE_EVIDENCE_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0157_invoice_evidence.sql'),'utf8').trim());
    expect(setup.service.refundOrderSplitMigrationSqlForVerification()).toBe(REFUND_SPLIT_INSTALLATION_SQL);
    expect(setup.service.offlineOrderMigrationSqlForVerification()).toBe(OFFLINE_INSTALLATION_SQL);
    expect(setup.service.checkoutPricingLockMigrationSqlForVerification()).toBe(CHECKOUT_PRICING_LOCK_INSTALLATION_SQL);
    expect(setup.service.supplierRefundLookupIndexesMigrationSqlForVerification()).toBe(SUPPLIER_REFUND_LOOKUP_INDEX_SQL);
    expect(SUPPLIER_REFUND_LOOKUP_INDEX_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0162_supplier_refund_lookup_indexes.sql'),'utf8').trim());
    expect(supplierLookupRunner).not.toHaveBeenCalled();
    expect(setup.service.purchaseOriginEvidenceMigrationSqlForVerification()).toBe(PURCHASE_ORIGIN_INSTALLATION_SQL);
    expect(PURCHASE_ORIGIN_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0163_purchase_origin_evidence.sql'),'utf8').trim());
    expect(originRunner).not.toHaveBeenCalled();
    expect(setup.service.purchaseCancellationEvidenceMigrationSqlForVerification()).toBe(PURCHASE_CANCELLATION_INSTALLATION_SQL);
    expect(PURCHASE_CANCELLATION_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0164_purchase_cancellation_evidence.sql'),'utf8').replace(/\r\n/g,'\n').trim());
    expect(cancellationRunner).not.toHaveBeenCalled();
    expect(setup.service.assistedOrderListIndexMigrationSqlForVerification()).toBe(ASSISTED_ORDER_LIST_INDEX_SQL);
    expect(ASSISTED_ORDER_LIST_INDEX_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0165_assisted_order_list_index.sql'),'utf8').trim());
    expect(assistedListRunner).not.toHaveBeenCalled();
    expect(setup.service.seckillSkuIdentityFenceMigrationSqlForVerification()).toBe(SECKILL_SKU_IDENTITY_FENCE_SQL);
    expect(SECKILL_SKU_IDENTITY_FENCE_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0166_seckill_sku_identity_fence.sql'),'utf8').trim());
    expect(seckillSkuRunner).not.toHaveBeenCalled();
    expect(setup.service.memberBarcodeIndexMigrationSqlForVerification()).toBe(MEMBER_BARCODE_INDEX_SQL);
    expect(MEMBER_BARCODE_INDEX_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0167_member_barcode_index.sql'),'utf8').trim());
    expect(memberBarcodeRunner).not.toHaveBeenCalled();
    expect(CHECKOUT_PRICING_LOCK_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0160_checkout_pricing_lock.sql'),'utf8').trim());
    expect(OFFLINE_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0159_offline_order.sql'),'utf8').trim());
    expect(REFUND_SPLIT_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root,'migrations/0158_refund_order_split.sql'),'utf8').trim());
    expect(ADMIN_REFUND_CREATION_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root, 'migrations/0156_admin_refund_creation.sql'), 'utf8').trim());
    expect(ADMIN_REFUND_OPERATION_INSTALLATION_SQL.trim()).toBe(readFileSync(resolve(root, 'migrations/0155_admin_refund_operation.sql'), 'utf8').trim());
    expect(setup.transaction).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(bargainRunner).not.toHaveBeenCalled();
    expect(paidRunner).not.toHaveBeenCalled();
    expect(couponRunner).not.toHaveBeenCalled();
  });

  it("executes all 174 steps in order and dispatches 0151–0173 to independent root transaction runners", async () => {
    const setup = harness();
    expect(await setup.service.runAll()).toEqual({ executed: names, errors: [] });
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(pinkRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(childRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(contactRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(bargainRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(paidRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(couponRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(shippingRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(shippingIndexRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(replayRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(refundRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(creationRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(invoiceRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(splitRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(offlineRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(pricingRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(presaleRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(supplierLookupRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(originRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(cancellationRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(assistedListRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(seckillSkuRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(memberBarcodeRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.sqlCalls.filter(c => c.sql === "SET LOCAL search_path TO public, pg_temp")).toHaveLength(151);
    expect(setup.sqlCalls.some(c => c.sql === KEFU_SEQUENCE_ALIGNMENT_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === PINK_RECOVERY_INDEX_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === FOREIGN_KEY_CHILD_INDEX_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === WORK_CONTACT_CLIENT_INDEX_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === BARGAIN_CART_PARTICIPATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === BROKERAGE_PAID_ORDER_FENCE_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === COUPON_PRODUCT_SCOPE_FENCE_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === SHIPPING_LIFECYCLE_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === SHIPPING_LIFECYCLE_INDEX_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === SHIPPING_CREATE_REPLAY_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === ADMIN_REFUND_OPERATION_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === ADMIN_REFUND_CREATION_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === INVOICE_EVIDENCE_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === REFUND_SPLIT_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === OFFLINE_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === CHECKOUT_PRICING_LOCK_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === SUPPLIER_REFUND_LOOKUP_INDEX_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === PURCHASE_CANCELLATION_INSTALLATION_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === ASSISTED_ORDER_LIST_INDEX_SQL)).toBe(false);
    expect(setup.sqlCalls.some(c => c.sql === MEMBER_BARCODE_INDEX_SQL)).toBe(false);
  });

  it.each([new Error("already exists"), new Error("sequence drift"), "raw rejection"])(
    "does not skip, retry or record success after the standalone runner fails (%s)", async error => {
      const setup = harness();
      runner.mockRejectedValue(error);
      const result = await setup.service.runAll();
      expect(result.executed).toEqual(names.slice(0, 151));
      expect(result.errors).toEqual([`0151: ${error instanceof Error ? error.message : error}`]);
      expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
      expect(pinkRunner).not.toHaveBeenCalled();
      expect(childRunner).not.toHaveBeenCalled();
      expect(contactRunner).not.toHaveBeenCalled();
      expect(bargainRunner).not.toHaveBeenCalled();
    });

  it.each([115, 150])("never dispatches 0151 after modern step %i fails, including an already-exists error", async index => {
    const setup = harness({ index, error: new Error("already exists") });
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, index), errors: [`${names[index]}: already exists`] });
    expect(setup.transaction).toHaveBeenCalledTimes(index + 1);
    expect(runner).not.toHaveBeenCalled();
    expect(pinkRunner).not.toHaveBeenCalled();
    expect(childRunner).not.toHaveBeenCalled();
    expect(contactRunner).not.toHaveBeenCalled();
    expect(bargainRunner).not.toHaveBeenCalled();
  });

  it.each([new Error("already exists"), new Error("index drift"), "raw rejection"])(
    "fails closed at 0152 without retrying or claiming index migration success (%s)", async error => {
      const setup = harness();
      pinkRunner.mockRejectedValue(error);
      const result = await setup.service.runAll();
      expect(result.executed).toEqual(names.slice(0, 152));
      expect(result.errors).toEqual([`0152: ${error instanceof Error ? error.message : error}`]);
      expect(childRunner).not.toHaveBeenCalled();
      expect(contactRunner).not.toHaveBeenCalled();
      expect(bargainRunner).not.toHaveBeenCalled();
      expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(pinkRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([new Error("already exists"), new Error("index drift"), "raw rejection"])(
    "fails closed at 0153 without retrying or recording success (%s)", async error => {
      const setup = harness();
      childRunner.mockRejectedValue(error);
      const result = await setup.service.runAll();
      expect(result.executed).toEqual(names.slice(0, 153));
      expect(result.errors).toEqual([`0153: ${error instanceof Error ? error.message : error}`]);
      expect(contactRunner).not.toHaveBeenCalled();
      expect(bargainRunner).not.toHaveBeenCalled();
      expect(childRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([new Error("already exists"), new Error("index drift"), "raw rejection"])(
    "fails closed at 0154 without retry or false success (%s)", async error => {
      const setup = harness();
      contactRunner.mockRejectedValue(error);
      expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 154),
        errors: [`0154: ${error instanceof Error ? error.message : error}`] });
      expect(contactRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(bargainRunner).not.toHaveBeenCalled();
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([new Error("already exists"), new Error("binding drift"), "raw rejection"])(
    "fails closed at 0155 without retry, legacy skip or false success (%s)", async error => {
      const setup = harness();
      bargainRunner.mockRejectedValue(error);
      expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 155),
        errors: [`0155: ${error instanceof Error ? error.message : error}`] });
      expect(paidRunner).not.toHaveBeenCalled();
      expect(contactRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(bargainRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([new Error("already exists"), new Error("fence drift"), "raw rejection"])(
    "fails closed at 0156 without retry, legacy skip or false success (%s)", async error => {
      const setup = harness();
      paidRunner.mockRejectedValue(error);
      expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 156),
        errors: [`0156: ${error instanceof Error ? error.message : error}`] });
      expect(paidRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(couponRunner).not.toHaveBeenCalled();
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it.each([new Error("already exists"), new Error("coupon fence drift"), "raw rejection"])(
    "fails closed at 0157 without retry, legacy skip or false success (%s)", async error => {
      const setup = harness();
      couponRunner.mockRejectedValue(error);
      expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 157),
        errors: [`0157: ${error instanceof Error ? error.message : error}`] });
      expect(paidRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(couponRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it("preserves the historical skip behavior without applying it to 0151", async () => {
    const setup = harness({ index: 10, error: new Error("already exists") });
    const expected = [...names]; expected[10] = "0010 (skipped)";
    expect(await setup.service.runAll()).toEqual({ executed: expected, errors: [] });
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
  });

  it.each([new Error("already exists"), new Error("shipping environment drift"), "raw rejection"])(
    "fails closed at 0158 without retry, skip or false success (%s)", async error => {
      const setup = harness();
      shippingRunner.mockRejectedValue(error);
      expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 158),
        errors: [`0158: ${error instanceof Error ? error.message : error}`] });
      expect(shippingRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(couponRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
      expect(setup.transaction).toHaveBeenCalledTimes(151);
    });

  it('does not dispatch 0158 after its predecessor fails', async () => {
    const setup = harness();
    couponRunner.mockRejectedValue(new Error('previous gate failed'));
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,157), errors: ['0157: previous gate failed'] });
    expect(shippingRunner).not.toHaveBeenCalled();
  });

  it.each([new Error('already exists'),new Error('index drift'),'raw rejection'])('fails closed at 0159 (%s)', async error => {
    const setup=harness(); shippingIndexRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,159),errors:[`0159: ${error instanceof Error ? error.message : error}`]});
    expect(shippingIndexRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches index installation after protocol installation fails', async () => {
    const setup=harness(); shippingRunner.mockRejectedValue(new Error('protocol drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,158),errors:['0158: protocol drift']});
    expect(shippingIndexRunner).not.toHaveBeenCalled();
  });

  it.each([new Error('already exists'), new Error('receipt drift'), 'raw rejection'])('fails closed at 0160 (%s)', async error => {
    const setup = harness(); replayRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0, 160), errors: [`0160: ${error instanceof Error ? error.message : error}`] });
    expect(replayRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('does not dispatch receipt installation after indexes fail', async () => {
    const setup = harness(); shippingIndexRunner.mockRejectedValue(new Error('index drift'));
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,159), errors: ['0159: index drift'] });
    expect(replayRunner).not.toHaveBeenCalled();
  });

  it.each([new Error('already exists'), new Error('refund receipt drift'), 'raw rejection'])('fails closed at 0161 (%s)', async error => {
    const setup=harness();refundRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,161),errors:[`0161: ${error instanceof Error ? error.message : error}`]});
    expect(refundRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches refund receipt installation after its predecessor fails', async () => {
    const setup=harness();replayRunner.mockRejectedValue(new Error('previous receipt drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,160),errors:['0160: previous receipt drift']});
    expect(refundRunner).not.toHaveBeenCalled();
  });

  it.each([new Error('already exists'), new Error('creation receipt drift'), 'raw rejection'])('fails closed at 0162 (%s)', async error => {
    const setup=harness();creationRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,162),errors:[`0162: ${error instanceof Error ? error.message : error}`]});
    expect(creationRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches creation installation after its predecessor fails', async () => {
    const setup=harness();refundRunner.mockRejectedValue(new Error('previous refund receipt drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,161),errors:['0161: previous refund receipt drift']});
    expect(creationRunner).not.toHaveBeenCalled();
  });

  it("preserves the 0118→0119 supersession without shifting the 0151 execution identity", async () => {
    const setup = harness(undefined, true), expected = [...names];
    expected[118] = "0118 (superseded by 0119)";
    expect(await setup.service.runAll()).toEqual({ executed: expected, errors: [] });
    expect(setup.sqlCalls.filter(c => c.index === 118)).toHaveLength(2); // SET and marker SELECT; no old DDL.
    expect(runner).toHaveBeenCalledExactlyOnceWith(setup.db);
  });
  it.each([new Error('already exists'),new Error('invoice drift'),'raw rejection'])('fails closed at 0163 (%s)',async error=>{
    const setup=harness(); invoiceRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,163),errors:[`0163: ${error instanceof Error ? error.message : error}`]});
    expect(invoiceRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches invoice installation after its predecessor fails',async()=>{
    const setup=harness();creationRunner.mockRejectedValue(new Error('creation drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,162),errors:['0162: creation drift']});
    expect(invoiceRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'),new Error('refund split drift'),'raw rejection'])('fails closed at 0164 (%s)',async error=>{
    const setup=harness();splitRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,164),errors:[`0164: ${error instanceof Error ? error.message : error}`]});
    expect(splitRunner).toHaveBeenCalledExactlyOnceWith(setup.db);expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches refund split installation after invoice protection fails',async()=>{
    const setup=harness();invoiceRunner.mockRejectedValue(new Error('invoice drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,163),errors:['0163: invoice drift']});
    expect(splitRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'),new Error('offline drift'),'raw rejection'])('fails closed at 0165 (%s)',async error=>{
    const setup=harness(); offlineRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,165),errors:[`0165: ${error instanceof Error ? error.message : error}`]});
    expect(offlineRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches offline installation after refund split protection fails',async()=>{
    const setup=harness(); splitRunner.mockRejectedValue(new Error('split drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,164),errors:['0164: split drift']});
    expect(offlineRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'),new Error('pricing owner missing'),'raw rejection'])('fails closed at 0166 (%s)',async error=>{
    const setup=harness(); pricingRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,166),errors:[`0166: ${error instanceof Error ? error.message : error}`]});
    expect(pricingRunner).toHaveBeenCalledExactlyOnceWith(setup.db);expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
  it('never dispatches pricing installation after offline protection fails',async()=>{
    const setup=harness(); offlineRunner.mockRejectedValue(new Error('offline drift'));
    expect(await setup.service.runAll()).toEqual({executed:names.slice(0,165),errors:['0165: offline drift']});
    expect(pricingRunner).not.toHaveBeenCalled();
  });
  it('fails closed at 0167 without claiming deployment success', async () => {
    const setup = harness(); presaleRunner.mockRejectedValue(Error('event CHECK drift'));
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,167), errors: ['0167: event CHECK drift'] });
    expect(presaleRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(supplierLookupRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('index drift'), 'raw rejection'])('fails closed at 0168 without retry or false success (%s)', async error => {
    const setup = harness(); supplierLookupRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,168), errors: [`0168: ${error instanceof Error ? error.message : error}`] });
    expect(supplierLookupRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(presaleRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(originRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('origin drift'), 'raw rejection'])('fails closed at 0169 without retry or false success (%s)', async error => {
    const setup = harness(); originRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,169), errors: [`0169: ${error instanceof Error ? error.message : error}`] });
    expect(originRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(supplierLookupRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(cancellationRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('cancellation drift'), 'raw rejection'])('fails closed at 0170 without retry or false success (%s)', async error => {
    const setup = harness(); cancellationRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,170), errors: [`0170: ${error instanceof Error ? error.message : error}`] });
    expect(cancellationRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(originRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(assistedListRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('index drift'), 'raw rejection'])('fails closed at 0171 without retry or false success (%s)', async error => {
    const setup = harness(); assistedListRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,171), errors: [`0171: ${error instanceof Error ? error.message : error}`] });
    expect(assistedListRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(cancellationRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(seckillSkuRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('index drift'), 'raw rejection'])('fails closed at 0172 without retry or false success (%s)', async error => {
    const setup = harness(); seckillSkuRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,172), errors: [`0172: ${error instanceof Error ? error.message : error}`] });
    expect(seckillSkuRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(assistedListRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
    expect(memberBarcodeRunner).not.toHaveBeenCalled();
  });
  it.each([new Error('already exists'), new Error('member index drift'), 'raw rejection'])('fails closed at 0173 without retry or false success (%s)', async error => {
    const setup = harness(); memberBarcodeRunner.mockRejectedValue(error);
    expect(await setup.service.runAll()).toEqual({ executed: names.slice(0,173), errors: [`0173: ${error instanceof Error ? error.message : error}`] });
    expect(memberBarcodeRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(seckillSkuRunner).toHaveBeenCalledExactlyOnceWith(setup.db);
    expect(setup.transaction).toHaveBeenCalledTimes(151);
  });
});
