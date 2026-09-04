import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  storeProductAttrValue,
  storeProductSkuRetirementLog,
} from "@/models/schema";
import {
  parseProductSkuRetirementInput,
  supplierProductSkuScope,
} from "@/services/product/ProductSkuRetirementService";
import { completeCartesianDimensions } from "@/services/product/ProductSkuEditorService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";
import { PRODUCT_SKU_RETIREMENT_SQL } from "@/migrations/productSkuRetirement";
import { MigrationService } from "@/services/MigrationService";

describe("controlled product SKU retirement", () => {
  it("normalizes a bounded deterministic SKU set and requires a reason", () => {
    expect(parseProductSkuRetirementInput({
      product_id: "8",
      sku_ids: [19, "17", 19],
      reason: "停止旧颜色销售",
    })).toEqual({ productId: 8, skuIds: [17, 19], reason: "停止旧颜色销售" });
    expect(() => parseProductSkuRetirementInput({ product_id: 8, sku_ids: [1], reason: "x" }))
      .toThrow("请填写2至255字的操作原因");
    expect(() => parseProductSkuRetirementInput({
      product_id: 8,
      sku_ids: Array.from({ length: 51 }, (_, index) => index + 1),
      reason: "批量退役",
    })).toThrow("单次最多操作50个SKU");
  });

  it("derives a bounded Supplier owner scope instead of accepting tenant identity from the body", () => {
    expect(supplierProductSkuScope(72)).toEqual({
      ownerType: 2,
      relationId: 72,
      surface: "supplier",
    });
    expect(() => supplierProductSkuScope(0)).toThrow("供应商身份无效");
    expect(() => supplierProductSkuScope(Number.NaN)).toThrow("供应商身份无效");
  });

  it("accepts only complete remaining or restored SKU combinations", () => {
    const dimensions = [
      { attrName: "颜色", attrValues: "米白,藏青,沙色" },
      { attrName: "尺码", attrValues: "S,M" },
    ];
    expect(completeCartesianDimensions([
      { suk: "藏青,S" }, { suk: "藏青,M" },
    ], dimensions, 1)).toEqual([
      { value: "颜色", detail: ["藏青"] },
      { value: "尺码", detail: ["S", "M"] },
    ]);
    expect(() => completeCartesianDimensions([
      { suk: "米白,S" }, { suk: "米白,M" }, { suk: "藏青,S" },
    ], dimensions, 1)).toThrow("必须保持完整笛卡尔组合");
    expect(completeCartesianDimensions([
      { suk: "米白,S" }, { suk: "米白,M" },
      { suk: "藏青,S" }, { suk: "藏青,M" },
      { suk: "沙色,S" }, { suk: "沙色,M" },
    ], dimensions, 1)[0]?.detail).toEqual(["米白", "藏青", "沙色"]);
  });

  it("ships target-only state and append-only evidence columns", () => {
    const sku = getTableConfig(storeProductAttrValue);
    expect(sku.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "is_retired", "retired_at", "retired_by", "retire_reason",
    ]));
    const log = getTableConfig(storeProductSkuRetirementLog);
    expect(log.name).toBe("store_product_sku_retirement_log");
    expect(log.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "product_id", "sku_id", "unique_snapshot", "suk_snapshot", "action",
      "reason", "actor_id", "dependency_snapshot", "add_time",
    ]));
  });

  it("adds a database guard against retired identity mutation, deletion, and stock consumption", () => {
    const migration = readFileSync("migrations/0126_product_sku_retirement.sql", "utf8");
    expect(migration.trim()).toBe(PRODUCT_SKU_RETIREMENT_SQL.trim());
    expect(new MigrationService({} as never).productSkuRetirementMigrationSqlForVerification().trim())
      .toBe(migration.trim());
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "guard_retired_product_sku"');
    expect(migration).toContain("retired product SKU cannot be deleted");
    expect(migration).toContain("retired product SKU identity is immutable");
    expect(migration).toContain("retired product SKU stock cannot be consumed");
    expect(migration).toContain('OLD."is_retired" = 1 OR NEW."is_retired" = 1');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "store_product_attr_value"');
  });

  it("audits every blocking live reference while preserving history references", () => {
    const service = readFileSync("src/services/product/ProductSkuRetirementService.ts", "utf8");
    for (const table of [
      "storeCart", "storeOrder", "store_seckill", "store_bargain", "store_combination", "store_integral",
      "store_discounts_products", "store_newcomer", "storePromotions", "storePromotionsAuxiliary",
      "luckPrize", "storeBranchProductAttrValue",
    ]) expect(service).toContain(table);
    for (const history of [
      "storeOrderCartInfo", "storeProductReply", "storeProductStockRecord", "storeProductVirtual",
    ]) expect(service).toContain(history);
    expect(service).toContain("await rebuildActiveProductSkuState(tx, product, now)");
    expect(service).toContain("PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE");
    expect(service).toContain("商品SKU退役日志数据库回读校验失败");
    expect(service).toContain('["未支付订单", snapshot.open_orders]');
  });

  it("keeps retired SKUs out of customer and checkout DAO reads", () => {
    const dao = readFileSync("src/dao/product/StoreProductAttrValueDao.ts", "utf8");
    const cart = readFileSync("src/services/order/StoreCartService.ts", "utf8");
    const product = readFileSync("src/services/product/StoreProductService.ts", "utf8");
    const out = readFileSync("src/services/out/OutProductService.ts", "utf8");
    const cancel = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    expect((dao.match(/isRetired/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(cart).toContain("eq(storeProductAttrValue.isRetired, 0)");
    expect(product).toContain("eq(storeProductAttrValue.isRetired, 0)");
    expect((out.match(/eq\(storeProductAttrValue\.isRetired, 0\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(1);
    expect(cancel).toContain("const baseSkuRetired = skuRestored[0]?.isRetired === 1");
    expect(refund).toContain("baseSkuRetired = baseSkuRows[0].isRetired === 1");
  });

  it("exposes only bounded ACL-protected Admin actions and a verified UI", () => {
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/product.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductForm.vue", "utf8");
    expect(routes).toContain('post("/product/sku/retire", adminAuth, AdminCrud.adminProductSkuRetire)');
    expect(routes).toContain('post("/product/sku/restore", adminAuth, AdminCrud.adminProductSkuRestore)');
    expect(controller.match(/readBoundedJsonObject\(c\.req\.raw, 8 \* 1024\)/g)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(requiredAdminPermission("POST", "/adminapi/product/sku/retire")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/adminapi/product/sku/restore")).toBe("product.manage");
    expect(api).toContain('request.post("/product/sku/retire"');
    expect(api).toContain('request.post("/product/sku/restore"');
    expect(page).toContain("if (!result.verified)");
    expect(page).toContain("退役选中历史SKU");
    expect(page).toContain("恢复选中SKU");
  });

  it("extends the same stable lifecycle to the authenticated Supplier owner without delete-reinsert", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    const controller = readFileSync("src/controllers/supplier/SupplierController.ts", "utf8");
    const retirement = readFileSync("src/services/product/ProductSkuRetirementService.ts", "utf8");
    const supplierProducts = readFileSync(
      "src/services/supplier/SupplierProductManagementService.ts",
      "utf8",
    );
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    const page = readFileSync("../view/supplier-ts/src/pages/ProductForm.vue", "utf8");

    expect(routes).toContain('post("/product/product/sku/retire", SupplierController.retireProductSkus)');
    expect(routes).toContain('post("/product/product/sku/restore", SupplierController.restoreProductSkus)');
    expect(routes.indexOf('"/product/product/sku/retire"')).toBeLessThan(
      routes.lastIndexOf('"/product/product/:id"'),
    );
    expect(requiredSupplierPermissions("POST", "/supplierapi/product/product/sku/retire"))
      .toEqual(["supplier.product.manage"]);
    expect(requiredSupplierPermissions("POST", "/supplierapi/product/product/sku/restore"))
      .toEqual(["supplier.product.manage"]);
    expect(controller).toContain("supplierProductSkuScope(supplierId)");
    expect(controller.match(/readSkuLifecycleBody\(c\)/g)?.length).toBe(2);
    expect(retirement).toContain("eq(storeProduct.type, scope.ownerType)");
    expect(retirement).toContain("eq(storeProduct.relationId, scope.relationId)");
    expect(retirement).toContain("商品不存在或不属于当前供应商");
    expect(retirement).toContain("product.productType !== CARD_PRODUCT_TYPE");
    expect(retirement).toContain("当前阶段仅支持实物或卡密商品SKU退役");
    expect(retirement).toContain("/supplierapi/product/product/sku/${action}");
    expect(supplierProducts).toContain("await replaceProductSkuEditor(tx");
    expect(supplierProducts).toContain("loadProductSkuEditor(this.container.db");
    expect(supplierProducts).not.toContain("tx.delete(storeProductAttrValue)");
    expect(supplierProducts).not.toContain("商品存在受控退役SKU");
    expect(api).toContain('url: "/product/product/sku/retire"');
    expect(api).toContain('url: "/product/product/sku/restore"');
    expect(page).toContain('auth.can("supplier.product.manage")');
    expect(page).toContain("退役选中历史SKU");
    expect(page).toContain("恢复选中SKU");
    expect(page).toContain("if (!result.verified)");
  });

  it("keeps the production audit and migration bounded, authenticated, idempotent, and self-cleaning", () => {
    const worker = readFileSync(
      "test/integration/ProductSkuRetirementProductionAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/product-sku-retirement-production-audit.wrangler.jsonc",
      "utf8",
    );
    const auditRunner = readFileSync(
      "scripts/run-product-sku-retirement-production-audit.ps1",
      "utf8",
    );
    const migrationRunner = readFileSync(
      "scripts/run-product-sku-retirement-production-migration.ps1",
      "utf8",
    );

    expect(worker).toContain('request.method === "GET" && path === "/audit"');
    expect(worker).toContain('request.method === "POST" && path === "/migrate"');
    expect(worker).toContain("crypto.subtle.timingSafeEqual");
    expect(worker).toContain('client.begin("read only"');
    expect(worker).toContain("SET LOCAL lock_timeout = '2s'");
    expect(worker).toContain("SET LOCAL statement_timeout = '15s'");
    expect(worker).toContain("pg_advisory_xact_lock(770426, 126)");
    expect(worker).toContain('LOCK TABLE "store_product_attr_value" IN ACCESS EXCLUSIVE MODE');
    expect(worker.indexOf("LOCK TABLE")).toBeLessThan(worker.indexOf("WITH base AS"));
    expect(worker.match(/tx\.unsafe\(PRODUCT_SKU_RETIREMENT_SQL\)/g)).toHaveLength(2);
    expect(worker).toContain("SKU migration found a partial pre-existing object set");
    expect(worker).toContain("businessRowsUnchanged");
    expect(worker).toContain("idempotentSecondPass");
    expect(worker).toContain("product_owner_distribution: productOwnerDistribution");
    expect(worker).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(worker).not.toMatch(/\bUPDATE\s+store_product_attr_value\s+SET\b/i);
    expect(worker).not.toMatch(/\bDELETE\s+FROM\b/i);

    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
    expect(auditRunner).toContain("Invoke-RestMethod -Method Get");
    expect(migrationRunner).toContain("Invoke-RestMethod -Method Post");
    expect(migrationRunner.match(/Invoke-RestMethod -Method Post/g)).toHaveLength(1);
    expect(migrationRunner.indexOf("Invoke-RestMethod -Method Get"))
      .toBeLessThan(migrationRunner.indexOf("Invoke-RestMethod -Method Post"));
    for (const runner of [auditRunner, migrationRunner]) {
      expect(runner).toContain("} finally {");
      expect(runner).toContain("wrangler delete");
      expect(runner).toContain("url_returns_404");
      expect(runner).toContain("AUDIT_TOKEN_SHA256:$taskTokenHash");
      expect(runner).toContain("for ($taskAttempt = 1; $taskAttempt -le 5");
    }
  });

  it("runs the real Supplier lifecycle in a production isolated schema without public drift", () => {
    const scenario = readFileSync(
      "test/integration/SupplierProductSkuLifecyclePostgresScenario.ts",
      "utf8",
    );
    const worker = readFileSync(
      "test/integration/SupplierProductSkuLifecycleAuditWorker.ts",
      "utf8",
    );
    const config = readFileSync(
      "test/integration/supplier-product-sku-lifecycle-audit.wrangler.jsonc",
      "utf8",
    );
    const runner = readFileSync(
      "scripts/run-supplier-product-sku-lifecycle-production-audit.ps1",
      "utf8",
    );
    for (const assertion of [
      "stable_identity_after_edit",
      "missing_active_rejected",
      "retirement_verified",
      "save_with_retired_row_succeeded",
      "ordinary_restore_rejected",
      "cross_tenant_rejected",
      "open_cart_blocked",
      "restore_verified",
      "supplier_stock_scope_verified",
      "public_state_unchanged",
    ]) expect(scenario).toContain(assertion);
    expect(scenario).toContain("searchPath: schema");
    expect(scenario).toContain("withIsolatedContainer");
    expect(scenario).not.toContain("await isolated.insert");
    expect(scenario).toContain("DROP SCHEMA IF EXISTS");
    expect(scenario).toContain("FINGERPRINT_TABLES = TABLES");
    expect(worker).toContain("crypto.subtle.timingSafeEqual");
    expect(worker).toContain("runSupplierProductSkuLifecyclePostgresScenario");
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(config).toContain('"global_fetch_strictly_public"');
    expect(runner.match(/Invoke-RestMethod -Method Post/g)).toHaveLength(1);
    expect(runner).toContain("} finally {");
    expect(runner).toContain("wrangler delete");
    expect(runner).toContain("url_returns_404");
    expect(runner).toContain("cleanup did not converge");
    expect(runner).not.toContain("RandomNumberGenerator]::Fill");
    expect(runner).not.toContain("SHA256]::HashData");
  });
});
