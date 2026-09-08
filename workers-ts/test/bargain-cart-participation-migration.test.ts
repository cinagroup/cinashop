import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Container } from "../src/lib/di";
import { storeCart } from "../src/models/schema/order";
import { MigrationService } from "../src/services/MigrationService";
import { BARGAIN_CART_PARTICIPATION_SQL } from "../src/migrations/bargainCartParticipation";
import { runBargainCartParticipation } from "../src/migrations/runBargainCartParticipation";
import { financePostgres } from "./helpers/financePostgres";
import { sequenceRunnerDatabase } from "./helpers/kefuSequenceRunnerDatabase";
import { outcome, waitForFinanceBlock, withFinancePeers } from "./helpers/financePeers";

const external = readFileSync("migrations/0149_bargain_cart_participation.sql", "utf8");
const dialect = new PgDialect();
type Root = Parameters<typeof runBargainCartParticipation>[0];
function messages(error: unknown): string {
  return error instanceof Error ? error.message + (error.cause ? " " + messages(error.cause) : "") : String(error);
}

describe("0149 durable bargain cart binding schema", () => {
  let f: Awaited<ReturnType<typeof financePostgres>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });
  async function fixture() {
    f = await financePostgres([storeCart]);
    // Reproduce the actual pre-upgrade model, including nonempty legacy carts.
    await f.exec("ALTER TABLE store_cart DROP COLUMN bargain_user_id");
    await f.exec("INSERT INTO store_cart(uid,type,activity_id,cart_num) VALUES (1,2,40,1),(2,0,0,3)");
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) p(n)`);
    return { ...f, schema: identity.schema };
  }
  async function rows() {
    if (!f) throw new Error("Missing fixture");
    return f.db.select({ data: sql<unknown>`to_jsonb(c)` }).from(sql`store_cart c`).orderBy(sql`id`);
  }
  async function catalog(db = f?.db) {
    if (!db) throw new Error("Missing fixture");
    return db.select({ table: sql<string>`c.relname`, oid: sql<string>`c.oid::text`, file: sql<string>`c.relfilenode::text`,
      columns: sql<unknown>`(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid,'null',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid),'generated',a.attgenerated,'identity',a.attidentity) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)`,
      checks: sql<unknown>`(SELECT jsonb_agg(jsonb_build_object('oid',k.oid,'name',k.conname,'definition',pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'local',k.conislocal,'inherit',k.connoinherit) ORDER BY k.conname)
        FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='c')` })
      .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`)
      .where(sql`n.nspname=current_schema() AND c.relname='store_cart'`);
  }
  it("uses identical external and actual embedded SQL and registers the standalone runner", () => {
    const embedded = new MigrationService({} as Container).bargainCartParticipationMigrationSqlForVerification();
    expect(external.trim()).toBe(BARGAIN_CART_PARTICIPATION_SQL.trim());
    expect(embedded.trim()).toBe(external.trim());
    expect(external).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|nextval|setval)\b/i);
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    expect(service).toContain("await runBargainCartParticipation(this.container.db)");
    expect(service).toContain("executed.push(\"0155\")");
  });
  it("preserves every old row with binding zero and does not rewrite the heap or advance the sequence", async () => {
    const { db, schema } = await fixture();
    const before = await rows(), physical = await catalog();
    const sequence = () => db.select({ value: sql<string>`last_value::text`, called: sql<boolean>`is_called` }).from(sql`store_cart_id_seq`);
    const originalSequence = await sequence();
    await runBargainCartParticipation(db, schema);
    expect(await rows()).toEqual(before.map(row => ({ data: { ...(row.data as object), bargain_user_id: 0 } })));
    expect((await catalog())[0].file).toBe(physical[0].file);
    expect(await sequence()).toEqual(originalSequence);
    const installed = await catalog();
    await runBargainCartParticipation(db, schema);
    await db.transaction(tx => tx.execute(sql.raw(external)));
    expect(await catalog()).toEqual(installed);
    await db.insert(storeCart).values({ uid: 3, type: 2, bargainUserId: 23 });
    await db.insert(storeCart).values({ uid: 3, type: 2 });
    for (const values of [{ type: 0, bargainUserId: 23 }, { type: 2, bargainUserId: -1 }, { type: 1, bargainUserId: 23 }])
      await expect(db.insert(storeCart).values(values)).rejects.toThrow();
  });
  it.each([
    "bigint NOT NULL DEFAULT 0", "integer DEFAULT 0", "integer NOT NULL", "integer NOT NULL DEFAULT 1",
    "integer NOT NULL DEFAULT (0+0)", "integer GENERATED ALWAYS AS (uid) STORED NOT NULL",
    "integer GENERATED ALWAYS AS IDENTITY", "text NOT NULL DEFAULT '0'",
  ])("rejects existing column drift without replacing it: %s", async shape => {
    const { db, schema, exec } = await fixture();
    if (shape === "integer NOT NULL") await exec("TRUNCATE store_cart");
    await exec(`ALTER TABLE store_cart ADD COLUMN bargain_user_id ${shape}`);
    const before = await catalog(), data = await rows();
    const result = await outcome(runBargainCartParticipation(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0149 bargain binding column drift");
    expect(await catalog()).toEqual(before);
    expect(await rows()).toEqual(data);
  });
  it.each([
    "CHECK (bargain_user_id >= 0)",
    "CHECK (bargain_user_id >= 0 AND (type = 2 OR bargain_user_id = 0)) NOT VALID",
    "CHECK (bargain_user_id >= 0 AND (type = 2 OR bargain_user_id = 0)) NO INHERIT",
    "CHECK (bargain_user_id >= 0 AND (type = 2 OR bargain_user_id = 0) AND uid > 0)",
    "UNIQUE(bargain_user_id,uid)",
  ])("rejects same-name constraint drift: %s", async shape => {
    const { db, schema, exec } = await fixture();
    await exec(`ALTER TABLE store_cart ADD COLUMN bargain_user_id integer NOT NULL DEFAULT 0;
      ALTER TABLE store_cart ADD CONSTRAINT sc_bargain_participation_ck ${shape}`);
    const before = await catalog(), data = await rows(), result = await outcome(runBargainCartParticipation(db, schema));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.error)).toContain("0149 bargain binding constraint drift");
    expect(await catalog()).toEqual(before);
    expect(await rows()).toEqual(data);
  });
  it.each([
    "ALTER TABLE store_cart ALTER COLUMN type TYPE integer",
    "ALTER TABLE store_cart ALTER COLUMN type DROP NOT NULL",
    "CREATE TABLE cart_child() INHERITS(store_cart)",
    "ALTER TABLE store_cart SET UNLOGGED",
  ])("rejects unsupported target shape and rolls back additions: %s", async ddl => {
    const { db, schema, exec } = await fixture();
    await exec(ddl);
    const before = await catalog();
    await expect(runBargainCartParticipation(db, schema)).rejects.toThrow();
    expect(await catalog()).toEqual(before);
  });
  it("rolls back a failed existing-data CHECK validation without altering business rows", async () => {
    const { db, schema, exec } = await fixture();
    await exec("ALTER TABLE store_cart ADD COLUMN bargain_user_id integer NOT NULL DEFAULT 0; UPDATE store_cart SET bargain_user_id=-1 WHERE id=1");
    const before = await catalog(), data = await rows();
    await expect(runBargainCartParticipation(db, schema)).rejects.toThrow();
    expect(await catalog()).toEqual(before);
    expect(await rows()).toEqual(data);
  });
  it("ignores temporary shadows and rolls back the complete addition on caller failure", async () => {
    const { db, schema } = await fixture();
    const before = await catalog(), data = await rows(), failure = new Error("fixture rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql`CREATE TEMP TABLE store_cart(id integer) ON COMMIT DROP`);
      await tx.execute(sql.raw(external));
      const [installed] = await tx.select({ binding: sql<number>`bargain_user_id` }).from(sql`${sql.identifier(schema)}.store_cart`).limit(1);
      expect(installed.binding).toBe(0);
      throw failure;
    })).rejects.toBe(failure);
    expect(await catalog()).toEqual(before);
    expect(await rows()).toEqual(data);
  });
  it("rejects missing/unsafe schemas and nested transactions", async () => {
    const { db } = await fixture();
    for (const schema of ["", "pg_catalog", "information_schema", "pg_temp", "public,pg_temp", 'public"', "x".repeat(64)])
      await expect(runBargainCartParticipation(db, schema)).rejects.toThrow("Invalid bargain cart binding schema");
    await expect(runBargainCartParticipation(db, "missing_cart_binding_schema")).rejects.toThrow();
    await db.transaction(async tx => {
      await expect(runBargainCartParticipation({ transaction: tx.transaction.bind(tx) })).rejects.toThrow("root database");
    });
  });
  it("upgrades an empty second schema without touching the original schema", async () => {
    const { db, schema } = await fixture();
    const second = `cart_scope_${crypto.randomUUID().replaceAll("-", "")}`, before = await catalog(), data = await rows();
    const sequence = () => db.select({ value: sql<string>`last_value::text`, called: sql<boolean>`is_called` }).from(sql`store_cart_id_seq`);
    const beforeSequence = await sequence();
    const failure = new Error("owned schema rollback");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(second)}`);
      await tx.execute(sql`CREATE TABLE ${sql.identifier(second)}.store_cart (LIKE ${sql.identifier(schema)}.store_cart INCLUDING DEFAULTS)`);
      await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(second)}, ${sql.identifier(schema)}, pg_temp`);
      await tx.execute(sql.raw(external));
      expect(await tx.select().from(storeCart)).toEqual([]);
      const [scope] = await tx.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) p(n)`);
      expect(scope.schema).toBe(second);
      // LIKE INCLUDING DEFAULTS shares the source sequence; use an explicit ID.
      const [bound] = await tx.insert(storeCart).values({ id: 99, type: 2, bargainUserId: 99 }).returning();
      expect(bound.bargainUserId).toBe(99);
      throw failure;
    })).rejects.toBe(failure);
    expect(await catalog()).toEqual(before);
    expect(await rows()).toEqual(data);
    expect(await sequence()).toEqual(beforeSequence);
  });
  it.each(["external", "embedded"] as const)("upgrades the exact historical %s cart table DDL", async path => {
    const owned = await sequenceRunnerDatabase();
    try {
      const service = new MigrationService({} as Container);
      const source = path === "external" ? readFileSync("migrations/0002_order.sql", "utf8")
        : (service as unknown as { migration_0002(): string }).migration_0002();
      const matches = [...source.matchAll(/CREATE TABLE IF NOT EXISTS "store_cart" \([\s\S]*?\n\);/g)];
      expect(matches).toHaveLength(1);
      await owned.exec(matches[0][0]);
      await owned.exec("INSERT INTO store_cart(uid,type,activity_id) VALUES(1,2,40),(2,0,0)");
      const old = await owned.query("SELECT to_jsonb(c) AS data FROM store_cart c ORDER BY id");
      await runBargainCartParticipation(owned.db);
      const upgraded = await owned.query("SELECT to_jsonb(c) AS data FROM store_cart c ORDER BY id");
      expect(upgraded.rows).toEqual(old.rows.map(row => ({ data: { ...(row as { data: object }).data, bargain_user_id: 0 } })));
      const installed = await catalog(owned.db);
      await runBargainCartParticipation(owned.db);
      expect(await catalog(owned.db)).toEqual(installed);
    } finally { await owned.close(); }
  });
  it.each([[0,0,"30000","5000"],[120000,12000,"30000","5000"],[15000,3000,"15000","3000"]])(
    "bounds timeouts before DDL and restores session settings: %i/%i", async (statement, idle, expectedStatement, expectedIdle) => {
      const { db, schema, exec } = await fixture();
      await exec(`SET statement_timeout='${statement}ms'; SET idle_in_transaction_session_timeout='${idle}ms'`);
      let observed = false;
      const settings = (client: Pick<typeof db, "select">) => client.select({
        statement: sql<string>`(SELECT setting FROM pg_settings WHERE name='statement_timeout')`,
        idle: sql<string>`(SELECT setting FROM pg_settings WHERE name='idle_in_transaction_session_timeout')`,
        isolation: sql<string>`current_setting('transaction_isolation')`,
      }).from(sql`(values (1)) p(n)`);
      const wrapped: Root = { $client: db.$client, transaction: (callback, config) => db.transaction(async tx => {
        const proxy = new Proxy(tx, { get(target, key, receiver) {
          if (key === "execute") return async (query: SQL) => {
            if (dialect.sqlToQuery(query).sql === BARGAIN_CART_PARTICIPATION_SQL) {
              expect(await settings(tx)).toEqual([{ statement: expectedStatement, idle: expectedIdle, isolation: "read committed" }]);
              observed = true;
            }
            return tx.execute(query);
          };
          return Reflect.get(target, key, receiver);
        } });
        return callback(proxy);
      }, config) };
      await runBargainCartParticipation(wrapped, schema);
      expect(observed).toBe(true);
      expect(await settings(db)).toEqual([{ statement: String(statement), idle: String(idle), isolation: "read committed" }]);
    });
  // Full history has PG16-specific catalog guards (before this migration).
  // PGlite 18 has NOT NULL constraint rows and cannot prove that history.
  for (const path of ["external", "embedded", "orm"] as const) {
    it.skipIf(path !== "orm" && !process.env.TEST_FINANCE_POSTGRES_URL)(`accepts actual complete ${path} construction and repeated upgrade`, async () => {
      const owned = await sequenceRunnerDatabase();
      try {
        if (path === "external") {
          for (const file of readdirSync("migrations").filter(name => /^\d{4}.*\.sql$/.test(name)).sort())
            await owned.exec(`BEGIN; SET LOCAL search_path TO public,pg_temp; SET LOCAL statement_timeout='30s';\n${readFileSync(`migrations/${file}`, "utf8")}\nCOMMIT;`);
        } else if (path === "embedded") {
          const result = await new MigrationService({ db: owned.db } as Container).runAll();
          expect(result.errors.map(error => error.slice(0, 160))).toEqual([]);
          expect(result.executed.filter(step => step.includes("skipped"))).toEqual([]);
          expect(result.executed).toContain("0155");
        } else {
          const api = await import("drizzle-kit/api"), models = await import("../src/models/schema");
          await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join("\n"));
        }
        const before = await catalog(owned.db);
        await runBargainCartParticipation(owned.db);
        await runBargainCartParticipation(owned.db);
        expect(await catalog(owned.db)).toEqual(before);
        await owned.db.insert(storeCart).values({ uid: 5, type: 2, bargainUserId: 71 });
        await expect(owned.db.insert(storeCart).values({ uid: 5, type: 0, bargainUserId: 71 })).rejects.toThrow();
      } finally { await owned.close(); }
    }, 120000);
  }
  it("refuses enabled database-wide DDL hooks even on the no-op path", async () => {
    const owned = await sequenceRunnerDatabase();
    try {
      await owned.exec("CREATE TABLE store_cart(id serial PRIMARY KEY,type smallint NOT NULL DEFAULT 0)");
      await runBargainCartParticipation(owned.db);
      await owned.exec(`CREATE FUNCTION public.cart_binding_hook() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$;
        CREATE EVENT TRIGGER cart_binding_hook ON ddl_command_end EXECUTE FUNCTION public.cart_binding_hook()`);
      const before = await catalog(owned.db), result = await outcome(runBargainCartParticipation(owned.db));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(messages(result.error)).toContain("0149 enabled DDL event triggers");
      expect(await catalog(owned.db)).toEqual(before);
    } finally { await owned.close(); }
  });
  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).each([
    { statement: "10s", code: "55P03" }, { statement: "500ms", code: "57014" },
  ])("PG16 bounds a verified conflicting reader under $statement", async ({ statement, code }) => {
    const { db, schema } = await fixture();
    await withFinancePeers(db, async ([reader, upgrader, observer]) => {
      const before = await catalog(), data = await rows();
      await upgrader.exec(`SET statement_timeout='${statement}'`);
      await reader.exec("BEGIN");
      try {
        await reader.exec("SELECT id FROM store_cart");
        const pending = outcome(runBargainCartParticipation(upgrader.db, schema));
        await waitForFinanceBlock(observer.db, upgrader.pid, reader.pid);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ cause: { code } });
        expect(await catalog()).toEqual(before);
        expect(await rows()).toEqual(data);
      } finally { await reader.exec("ROLLBACK"); }
      await runBargainCartParticipation(upgrader.db, schema);
      expect((await db.select().from(storeCart)).every(row => row.bargainUserId === 0)).toBe(true);
    });
  }, 20000);
});
