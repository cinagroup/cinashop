import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ADMIN_ARTICLE_INDEX_SQL } from "../src/migrations/adminArticleIndexes";
import { SYSTEM_FORM_REFERENCE_INDEX_SQL } from "../src/migrations/systemFormReferenceIndexes";

describe("DB-009 missing embedded Admin indexes", () => {
  it("registers both exact external index migrations in the real Worker migration list", () => {
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(readFileSync("migrations/0127_admin_article_indexes.sql", "utf8").trim()).toBe(ADMIN_ARTICLE_INDEX_SQL.trim());
    expect(readFileSync("migrations/0128_system_form_reference_indexes.sql", "utf8").trim()).toBe(SYSTEM_FORM_REFERENCE_INDEX_SQL.trim());
    for (const step of ["0139", "0140"]) expect(service).toContain(`this.migration_${step}()`);
    expect(service).toContain("return ADMIN_ARTICLE_INDEX_SQL");
    expect(service).toContain("return SYSTEM_FORM_REFERENCE_INDEX_SQL");
  });

  it("creates all nine indexes with their order and partial predicates, without duplicates on rerun", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE system_article(id integer,cid integer,is_del integer,sort integer);
        CREATE TABLE article_category(id integer,is_del integer,sort integer);
        CREATE TABLE store_product(id integer,type integer,relation_id integer,is_del integer,system_form_id integer);
      `);
      for (const name of ["store_seckill", "store_combination", "store_bargain", "store_integral"]) {
        await db.exec(`CREATE TABLE ${name}(system_form_id integer,is_del integer,status integer)`);
      }
      const read = async () => (await db.query<{ indexname: string; indexdef: string }>("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname")).rows;
      expect(await read()).toEqual([]);
      await db.exec(ADMIN_ARTICLE_INDEX_SQL);
      await db.exec(SYSTEM_FORM_REFERENCE_INDEX_SQL);
      const indexes = await read();
      expect(indexes).toHaveLength(9);
      expect(indexes.filter((row) => row.indexname.endsWith("system_form_active"))).toHaveLength(5);
      for (const row of indexes.filter((entry) => entry.indexname.endsWith("system_form_active"))) expect(row.indexdef).toContain("WHERE (system_form_id > 0)");
      expect(indexes.find((row) => row.indexname === "sa_admin_active_sort")?.indexdef).toContain("(is_del, sort DESC, id DESC)");
      expect(indexes.find((row) => row.indexname === "sp_platform_article_options")?.indexdef).toContain("(type, relation_id, is_del, id DESC)");
      await db.exec(ADMIN_ARTICLE_INDEX_SQL);
      await db.exec(SYSTEM_FORM_REFERENCE_INDEX_SQL);
      expect(await read()).toEqual(indexes);
    } finally { await db.close(); }
  });
});
