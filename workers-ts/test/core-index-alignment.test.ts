import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { CORE_INDEX_ALIGNMENT_SQL } from "../src/migrations/coreIndexAlignment";
import { userRecharge } from "../src/models/schema/user_center";

type IndexDecision = {
  key: string; table: string; name: string; columns: string[]; unique: boolean;
  source: string; sourceLine: number; sourceSql: string;
  decision: "restore-canonical-index" | "retain-existing-alias"; exactCandidates: string[];
};
const manifest = JSON.parse(readFileSync("audit/core-index-reconciliation.json", "utf8")) as { entries: IndexDecision[] };
const restore = manifest.entries.filter((entry) => entry.decision === "restore-canonical-index");
const aliases = manifest.entries.filter((entry) => entry.decision === "retain-existing-alias");
const initialFiles = readdirSync("migrations").filter((name) => /^000[0-6]_.*\.sql$/.test(name)).sort();
const ident = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const rows = async (db: PGlite, query: string) => (await db.query(query)).rows;
type IndexRow = { relname: string; indexrelid: number; definition: string };
const expectedDefinitions = new WeakMap<PGlite, Map<string, string>>();
const indexes = async (db: PGlite) => (await db.query<IndexRow>(`SELECT c.relname,i.indexrelid,pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=current_schema() ORDER BY c.relname`)).rows;

async function fixture(schema = "public") {
  const db = new PGlite();
  try {
    if (schema !== "public") await db.exec(`CREATE SCHEMA ${ident(schema)}; SET search_path TO ${ident(schema)},pg_temp`);
    for (const file of initialFiles) await db.exec(readFileSync(`migrations/${file}`, "utf8"));
    expectedDefinitions.set(db, new Map((await indexes(db)).map((row) => [row.relname, row.definition])));
    // Reproduce the verified embedded gap on actual legacy table definitions.
    // These operations are confined to this newly-created in-memory database.
    for (const entry of restore) await db.exec(`DROP INDEX ${ident(schema)}.${ident(entry.name)}`);
    for (const entry of aliases) {
      await db.exec(`ALTER INDEX ${ident(schema)}.${ident(entry.name)} RENAME TO ${ident(entry.exactCandidates[0].split(".")[1])}`);
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}

async function rejectedUpgrade(db: PGlite, message: string | RegExp) {
  const before = await indexes(db);
  await db.exec("BEGIN");
  try { await expect(db.exec(CORE_INDEX_ALIGNMENT_SQL)).rejects.toThrow(message); }
  finally { await db.exec("ROLLBACK"); }
  expect(await indexes(db)).toEqual(before);
}

describe("DB-009D2 restore canonical initial indexes without destructive reconciliation", () => {
  it("accounts for all 52 initial index gaps and registers the exact SQL mirror", () => {
    const baseline = JSON.parse(readFileSync("audit/orm-ddl-catalog-baseline.json", "utf8"));
    const sources = initialFiles.map((file) => readFileSync(`migrations/${file}`, "utf8")).join("\n");
    const sourceNames = new Set([...sources.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)"/g)].map((match) => match[1]));
    const expectedKeys = baseline.records.filter((record: { comparison: string; category: string; change: string; value: { key: string; name: string } }) =>
      record.comparison === "externalVsEmbedded" && record.category === "indexes" && record.change === "referenceOnly" && sourceNames.has(record.value.name))
      .map((record: { value: { key: string } }) => record.value.key).sort();
    expect(manifest.entries.map((entry) => entry.key).sort()).toEqual(expectedKeys);
    expect(new Set(expectedKeys).size).toBe(52);
    expect(restore).toHaveLength(47);
    expect(restore.filter((entry) => entry.unique).map((entry) => entry.key)).toEqual(["user_recharge.ur_order_id_idx"]);
    expect(aliases).toHaveLength(5);
    for (const entry of manifest.entries) {
      expect(readFileSync(entry.source, "utf8").split(/\r?\n/)[entry.sourceLine - 1].trim()).toBe(entry.sourceSql);
      expect(entry.key).toBe(`${entry.table}.${entry.name}`);
      if (entry.decision === "restore-canonical-index") {
        expect(CORE_INDEX_ALIGNMENT_SQL).toContain(`('${entry.table}', '${entry.name}', ARRAY[${entry.columns.map((column) => `'${column}'`).join(", ")}]::text[], ${entry.unique})`);
      } else expect(CORE_INDEX_ALIGNMENT_SQL).not.toContain(`'${entry.name}'`);
    }
    expect(readFileSync("migrations/0135_core_index_alignment.sql", "utf8").trim()).toBe(CORE_INDEX_ALIGNMENT_SQL.trim());
    expect(CORE_INDEX_ALIGNMENT_SQL).not.toMatch(/\b(?:DROP|DELETE|UPDATE|TRUNCATE)\b/);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service).toContain("this.migration_0141()");
    expect(service).toContain("return CORE_INDEX_ALIGNMENT_SQL");
  });

  it("restores 47 exact indexes, preserves existing objects and rows, and is idempotent", async () => {
    const db = await fixture();
    try {
      await db.exec(`INSERT INTO "user" (account,phone) VALUES ('fixture-user','fixture-phone');
        INSERT INTO user_recharge(order_id,uid,price) VALUES ('czFixtureOrder',1,12.34)`);
      const before = await indexes(db);
      const data = await rows(db, "SELECT order_id,uid,price FROM user_recharge ORDER BY id");
      const users = await rows(db, 'SELECT * FROM "user" ORDER BY uid');
      await db.exec(CORE_INDEX_ALIGNMENT_SQL);
      const after = await indexes(db);
      expect(after).toHaveLength(before.length + 47);
      for (const row of before) expect(after).toContainEqual(row);
      for (const entry of restore) {
        expect(after.find((row) => row.relname === entry.name)?.definition).toBe(expectedDefinitions.get(db)!.get(entry.name));
      }
      for (const entry of aliases) expect(after.some((row) => row.relname === entry.name)).toBe(false);
      await expect(db.exec("INSERT INTO user_recharge(order_id) VALUES ('czFixtureOrder')")).rejects.toMatchObject({ code: "23505" });
      expect(await rows(db, "SELECT order_id,uid,price FROM user_recharge ORDER BY id")).toEqual(data);
      expect(await rows(db, 'SELECT * FROM "user" ORDER BY uid')).toEqual(users);
      await db.exec(CORE_INDEX_ALIGNMENT_SQL);
      expect(await indexes(db)).toEqual(after);
    } finally { await db.close(); }
  }, 30_000);

  it("refuses existing duplicate recharge IDs atomically without changing either row", async () => {
    const db = await fixture();
    try {
      await db.exec("INSERT INTO user_recharge(order_id,uid,price) VALUES ('czDuplicate',1,10),('czDuplicate',2,20)");
      const data = await rows(db, "SELECT id,order_id,uid,price FROM user_recharge ORDER BY id");
      await rejectedUpgrade(db, /unique index|duplicated|duplicate/i);
      expect(await rows(db, "SELECT id,order_id,uid,price FROM user_recharge ORDER BY id")).toEqual(data);
    } finally { await db.close(); }
  }, 30_000);

  it.each([
    'CREATE INDEX ur_order_id_idx ON user_recharge(order_id)',
    'CREATE UNIQUE INDEX ur_order_id_idx ON user_recharge(order_id) WHERE paid=0',
    'CREATE UNIQUE INDEX ur_order_id_idx ON user_recharge(order_id DESC)',
    'CREATE UNIQUE INDEX ur_order_id_idx ON user_recharge(order_id) INCLUDE(uid)',
    'CREATE UNIQUE INDEX ur_order_id_idx ON user_recharge(order_id) NULLS NOT DISTINCT',
    'CREATE UNIQUE INDEX ur_order_id_idx ON "user"(phone)',
    'ALTER TABLE user_recharge ADD CONSTRAINT ur_order_id_idx UNIQUE(order_id)',
    'CREATE TABLE ur_order_id_idx(id integer)',
  ])("refuses conflicting index shapes and rolls back preceding creates: %s", async (conflict) => {
    const db = await fixture();
    try { await db.exec(conflict); await rejectedUpgrade(db, "0135 index definition drift"); }
    finally { await db.close(); }
  }, 30_000);

  it("keeps a pre-existing referenced unique index, FK binding and pg_depend edges unchanged", async () => {
    const db = await fixture();
    try {
      await db.exec(`CREATE UNIQUE INDEX ur_order_id_idx ON user_recharge(order_id);
        CREATE TABLE recharge_child(order_id varchar(32) REFERENCES user_recharge(order_id));
        INSERT INTO user_recharge(order_id) VALUES ('czReferenced');
        INSERT INTO recharge_child VALUES ('czReferenced')`);
      const dependencies = () => rows(db, `SELECT classid::regclass::text,objid,objsubid,refclassid::regclass::text,refobjid,refobjsubid,deptype
        FROM pg_depend WHERE (classid='pg_class'::regclass AND objid='ur_order_id_idx'::regclass)
          OR (refclassid='pg_class'::regclass AND refobjid='ur_order_id_idx'::regclass)
        ORDER BY classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype`);
      const binding = () => rows(db, "SELECT conname,conindid FROM pg_constraint WHERE conrelid='recharge_child'::regclass");
      const before = { dependencies: await dependencies(), binding: await binding() };
      await db.exec(CORE_INDEX_ALIGNMENT_SQL);
      expect({ dependencies: await dependencies(), binding: await binding() }).toEqual(before);
      await expect(db.exec("INSERT INTO recharge_child VALUES ('czMissing')")).rejects.toMatchObject({ code: "23503" });
    } finally { await db.close(); }
  }, 30_000);

  it("uses the captured quoted schema instead of temp-table shadows", async () => {
    const db = await fixture("core proof");
    try {
      await db.exec("CREATE TEMP TABLE user_recharge (unrelated integer)");
      await db.exec(CORE_INDEX_ALIGNMENT_SQL);
      expect(await rows(db, `SELECT count(*)::integer AS count FROM pg_indexes
        WHERE schemaname='core proof' AND indexname='ur_order_id_idx'`)).toEqual([{ count: 1 }]);
      expect(await rows(db, "SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid='pg_temp.user_recharge'::regclass AND attnum>0")).toEqual([{ count: 1 }]);
    } finally { await db.close(); }
  }, 30_000);

  it("declares the same recharge uniqueness in ORM while retaining pre-upgrade ambiguity guards", () => {
    const config = getTableConfig(userRecharge).indexes.find((index) => index.config.name === "ur_order_id_idx")!.config;
    expect(config.unique).toBe(true);
    expect(config.columns.map((column) => "name" in column ? column.name : null)).toEqual(["order_id"]);
    expect(config.where).toBeUndefined();
    expect(readFileSync("src/services/payment/RechargePaymentService.ts", "utf8")).toContain('if (orders.length !== 1) throw new ValidateException("充值订单号存在重复，请联系管理员处理")');
  });
});
