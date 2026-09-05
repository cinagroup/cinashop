import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCreateTables } from "../scripts/data-migration/schema-audit";

interface RouteAuthoritySnapshot {
  version: number;
  files: Record<string, { lineCount: number; sha256: string }>;
  surfaces: Record<string, unknown[]>;
}

const routeSnapshot = JSON.parse(
  readFileSync("audit/legacy-route-authority.json", "utf8"),
) as RouteAuthoritySnapshot;
const schemaSnapshot = readFileSync("audit/legacy-schema-authority.sql", "utf8");

describe("versioned legacy authority snapshots", () => {
  it("keeps the complete route authority and evidence digests in the repository", () => {
    expect(routeSnapshot.version).toBe(1);
    expect(Object.keys(routeSnapshot.surfaces).sort()).toEqual([
      "admin",
      "api",
      "erp",
      "kefu",
      "out",
      "supplier",
    ]);
    expect(Object.values(routeSnapshot.surfaces).reduce((sum, routes) => sum + routes.length, 0))
      .toBe(1_904);
    expect(Object.keys(routeSnapshot.files)).toHaveLength(26);
    expect(Object.keys(routeSnapshot.files)).toEqual(expect.arrayContaining([
      "cinashop-php/app/controller/api/v1/PublicController.php",
      "cinashop-php/app/services/system/config/SystemConfigServices.php",
      "cinashop-php/view/uniapp/App.vue",
    ]));
    for (const file of Object.values(routeSnapshot.files)) {
      expect(file.lineCount).toBeGreaterThan(0);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("keeps all 201 legacy table column and primary-key shapes in the repository", () => {
    expect(schemaSnapshot).toContain(
      "-- Source SHA-256: 0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a",
    );
    expect(parseCreateTables(schemaSnapshot, "mysql").size).toBe(201);
  });

  it("matches the reviewed local PHP evidence whenever that source tree is available", () => {
    const phpRoot = resolve("..", "..", "cinashop-php");
    if (!existsSync(resolve(phpRoot, "route", "api.php"))) return;

    for (const [reference, authority] of Object.entries(routeSnapshot.files)) {
      const source = readFileSync(
        resolve(phpRoot, reference.slice("cinashop-php/".length)),
        "utf8",
      );
      expect(source.split("\n")).toHaveLength(authority.lineCount);
      expect(createHash("sha256").update(source).digest("hex")).toBe(authority.sha256);
    }

    const sourceSchema = readFileSync(resolve(phpRoot, "public", "install", "crmeb.sql"), "utf8");
    const sourceSchemaDigest = createHash("sha256").update(sourceSchema).digest("hex");
    expect(schemaSnapshot).toContain(`-- Source SHA-256: ${sourceSchemaDigest}`);
  });
});
