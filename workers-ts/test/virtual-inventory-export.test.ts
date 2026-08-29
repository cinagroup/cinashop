import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIRTUAL_INVENTORY_EXPORT_CONFIRM } from "@/services/product/VirtualProductInventoryService";

describe("virtual-inventory controlled sensitive export", () => {
  it("keeps the physical and embedded migration definitions equivalent", () => {
    const migration = readFileSync("migrations/0081_virtual_inventory_export.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0088\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    const auditWorker = readFileSync(
      "test/integration/VirtualInventoryExportMigrationWorker.ts",
      "utf8",
    );
    const auditSql = auditWorker
      .match(/export const VIRTUAL_INVENTORY_EXPORT_MIGRATION_SQL = `([\s\S]*?)`;/)?.[1]
      ?.trim();
    expect(auditSql).toBe(migration);
    const migrationService = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(migrationService).toContain('SET LOCAL search_path TO public, pg_temp');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "svie_token_hash_uq"');
    expect(migration).toContain("TIMESTAMPTZ");
    expect(migration).not.toContain("card_no");
    expect(migration).not.toContain("card_pwd");
  });

  it("requires explicit confirmation and persists only a ticket digest", () => {
    expect(VIRTUAL_INVENTORY_EXPORT_CONFIRM).toBe("EXPORT_AVAILABLE_VIRTUAL_CARDS");
    const source = readFileSync("src/services/product/VirtualProductInventoryService.ts", "utf8");
    const creation = source.slice(
      source.indexOf("async createExportTicket("),
      source.indexOf("async consumeExportTicket("),
    );
    expect(creation).toContain("body.confirm !== VIRTUAL_INVENTORY_EXPORT_CONFIRM");
    expect(creation).toContain("tokenHash");
    expect(creation).not.toContain("cardPwd: storeProductVirtual.cardPwd");
    expect(creation).not.toContain("card_no: storeProductVirtual.cardNo");
  });

  it("binds one-time consumption to actor, tenant, product and unassigned scope", () => {
    const source = readFileSync("src/services/product/VirtualProductInventoryService.ts", "utf8");
    const consume = source.slice(source.indexOf("async consumeExportTicket("), source.indexOf("async importCards("));
    for (const binding of ["actorType", "actorId", "supplierId", "productId"]) {
      expect(consume).toContain(`systemVirtualInventoryExport.${binding}`);
    }
    expect(consume).toContain('eq(storeProductVirtual.uid, 0)');
    expect(consume).toContain('.for("update")');
    expect(consume).toContain('status: "CONSUMED"');
    expect(consume).toContain("MAX_EXPORT_CARDS + 1");
  });

  it("marks every ticket response as non-cacheable", () => {
    const controller = readFileSync("src/controllers/api/v1/VirtualProductInventoryController.ts", "utf8");
    expect(controller).toContain('"Cache-Control", "private, no-store, max-age=0"');
    expect(controller).toContain('"Referrer-Policy", "no-referrer"');
    expect(controller).toContain('"X-Content-Type-Options", "nosniff"');
  });
});
