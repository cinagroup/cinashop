import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { REPOSITORY_COLUMN_WIDTH_ALIGNMENT_SQL as migration } from "../src/migrations/repositoryColumnWidthAlignment";

const fixture = `
 CREATE TABLE "user"(add_ip varchar(16) NOT NULL DEFAULT '',last_ip varchar(16) NOT NULL DEFAULT '');
 CREATE TABLE store_order(user_ip varchar(16) NOT NULL DEFAULT '');
 CREATE TABLE store_product_category(pic varchar(128) NOT NULL DEFAULT '');
 CREATE INDEX user_add_ip_fixture ON "user"(add_ip);
 INSERT INTO "user" VALUES ('127.0.0.1','127.0.0.2');
 INSERT INTO store_order VALUES ('127.0.0.3');
 INSERT INTO store_product_category VALUES ('original.png');
`;
async function apply(db: PGlite) {
  await db.exec("BEGIN");
  try { await db.exec(migration); await db.exec("COMMIT"); }
  catch (error) { await db.exec("ROLLBACK"); throw error; }
}
async function shape(db: PGlite) {
  return (await db.query(`SELECT table_name,column_name,character_maximum_length,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`)).rows;
}

describe("DB-009 column width alignment", () => {
  it("uses exact external/embedded SQL and registers the new embedded migration", () => {
    expect(readFileSync("migrations/0134_repository_column_width_alignment.sql", "utf8").trim()).toBe(migration.trim());
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service).toContain("this.migration_0138()");
    expect(service).toContain("return REPOSITORY_COLUMN_WIDTH_ALIGNMENT_SQL");
  });

  it("widens known legacy columns without changing existing rows, defaults or indexes and is rerunnable", async () => {
    const db = new PGlite();
    try {
      await db.exec(fixture);
      const indexes = (await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public'")).rows;
      const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
      await expect(db.query('INSERT INTO "user"(add_ip,last_ip) VALUES ($1,$1)', [ipv6])).rejects.toMatchObject({ code: "22001" });
      await expect(db.query("INSERT INTO store_product_category(pic) VALUES ($1)", ["x".repeat(200)])).rejects.toMatchObject({ code: "22001" });
      await apply(db);
      const after = await shape(db);
      expect(after.map((row) => (row as { character_maximum_length: number }).character_maximum_length)).toEqual([45,512,45,45]);
      expect(after.every((row) => (row as { is_nullable: string; column_default: string }).is_nullable === "NO" && (row as { column_default: string }).column_default === "''::character varying")).toBe(true);
      expect((await db.query('SELECT * FROM "user"')).rows).toEqual([{ add_ip: "127.0.0.1", last_ip: "127.0.0.2" }]);
      expect((await db.query("SELECT * FROM store_order")).rows).toEqual([{ user_ip: "127.0.0.3" }]);
      expect((await db.query("SELECT * FROM store_product_category")).rows).toEqual([{ pic: "original.png" }]);
      expect((await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public'")).rows).toEqual(indexes);
      await db.query('INSERT INTO "user"(add_ip,last_ip) VALUES ($1,$1)', [ipv6]);
      await db.query("INSERT INTO store_order(user_ip) VALUES ($1)", [ipv6]);
      await db.query("INSERT INTO store_product_category(pic) VALUES ($1)", ["x".repeat(512)]);
      await apply(db);
      expect(await shape(db)).toEqual(after);
      expect((await db.query("SELECT length(pic) AS length FROM store_product_category ORDER BY length(pic)")).rows).toEqual([{ length: 12 }, { length: 512 }]);
    } finally { await db.close(); }
  });

  it.each(["wider", "nullable", "missing"])("refuses %s drift and rolls back earlier width changes", async (variant) => {
    const db = new PGlite();
    try {
      await db.exec(fixture);
      if (variant === "wider") {
        await db.exec("ALTER TABLE store_product_category ALTER COLUMN pic TYPE varchar(1024)");
        await db.query("INSERT INTO store_product_category(pic) VALUES ($1)", ["z".repeat(600)]);
      } else if (variant === "nullable") await db.exec("ALTER TABLE store_product_category ALTER COLUMN pic DROP NOT NULL");
      else await db.exec("ALTER TABLE store_product_category DROP COLUMN pic");
      const before = await shape(db);
      await expect(apply(db)).rejects.toThrow("refuses unknown shape store_product_category.pic");
      expect(await shape(db)).toEqual(before);
      if (variant === "wider") expect((await db.query("SELECT max(length(pic)) AS length FROM store_product_category")).rows).toEqual([{ length: 600 }]);
    } finally { await db.close(); }
  });
});
