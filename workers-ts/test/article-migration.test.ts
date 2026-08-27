import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("article migration compatibility", () => {
  it("migrates article metadata, taxonomy, and one-to-one body content explicitly", () => {
    const byTable = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));
    expect(byTable.get("system_article")).toMatchObject({
      sourceTable: "article",
      columnConversions: {
        cid: "numeric_string_to_integer",
        visit: "numeric_string_to_integer",
        add_time: "numeric_string_to_integer",
      },
    });
    expect(byTable.get("article_category")?.columnConversions).toEqual({
      add_time: "numeric_string_to_integer",
    });
    expect(byTable.get("article_content")?.key).toEqual(["nid"]);
  });

  it("falls back to imported bodies and mirrors new-system edits atomically", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    expect(controller).toContain('LEFT JOIN "article_content" ac ON ac.nid = sa.id');
    expect(controller).toContain("COALESCE(NULLIF(sa.content, ''), ac.content, '') AS content");
    expect(controller).toContain('INSERT INTO "article_content" ("nid", "content")');
    expect(controller).toContain('ON CONFLICT ("nid") DO UPDATE SET "content" = EXCLUDED."content"');
  });
});
