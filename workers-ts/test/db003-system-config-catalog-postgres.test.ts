import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemConfig } from "../src/models/schema/system";
import { financePostgres, validateFinanceFixtureUrl } from "./helpers/financePostgres";
import { readSystemConfigCatalog } from "./integration/SystemConfigCatalogRead";

const native = describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));

native("DB-003 read-only system_config catalog on a disposable PG16 database", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let app: ReturnType<typeof postgres>;
  let database = "";
  const appRole = `db003_app_${randomUUID().replaceAll("-", "")}`;
  const noDeleteRole = `db003_no_delete_${randomUUID().replaceAll("-", "")}`;
  const fixturePassword = "db003-local-fixture-only";

  beforeAll(async () => {
    fixture = await financePostgres([systemConfig], { namespace: "public" });
    const rows = await fixture.exec("SELECT current_database() AS name") as Array<{ name: string }>;
    database = rows[0].name;
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    const target = new URL(base.href);
    target.pathname = `/${database}`;
    target.username = appRole;
    target.password = fixturePassword;
    await fixture.exec(`CREATE ROLE "${appRole}" LOGIN PASSWORD '${fixturePassword}'`);
    await fixture.exec(`CREATE ROLE "${noDeleteRole}" LOGIN PASSWORD '${fixturePassword}'`);
    await fixture.exec(`GRANT CONNECT ON DATABASE "${database}" TO "${appRole}"`);
    await fixture.exec(`GRANT USAGE ON SCHEMA public TO "${appRole}"`);
    await fixture.exec(`GRANT SELECT ON public.system_config TO "${appRole}"`);
    app = postgres(target.href, { max: 1, prepare: false });
  }, 60_000);

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    if (fixture) {
      try {
        await fixture.exec(`REVOKE ALL PRIVILEGES ON public.system_config FROM "${appRole}"`);
        await fixture.exec(`REVOKE USAGE ON SCHEMA public FROM "${appRole}"`);
        await fixture.exec(`REVOKE CONNECT ON DATABASE "${database}" FROM "${appRole}"`);
        await fixture.exec(`DROP ROLE "${appRole}"`);
        await fixture.exec(`DROP ROLE "${noDeleteRole}"`);
      } finally { await fixture.close(); }
    }
  }, 60_000);

  async function inspect(expectedDatabase = database, expectedRole = appRole, maintenanceRole = "finance_test") {
    return app.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await tx`SET LOCAL search_path = pg_catalog, pg_temp`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      return readSystemConfigCatalog(
        async (statement, parameters) => {
          const rows = await tx.unsafe(statement, parameters ? [...parameters] : []);
          return rows as Record<string, unknown>[];
        },
        expectedDatabase, expectedRole, maintenanceRole,
      );
    });
  }

  it("accepts the exact 16-column ordinary table without reading a config row", async () => {
    const report = await inspect();
    expect(report.catalogSafe).toBe(true);
    expect(report.columnCount).toBe(16);
    expect(report.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.identityChecks).toEqual(Object.fromEntries(
      Object.keys(report.identityChecks).map((key) => [key, true])));
    expect(report.readyForDml).toBe(false);
    expect(report.originIdentityVerified).toBe(false);
  });

  it("rejects a seventeenth column and a changed default independently", async () => {
    try {
      await fixture.exec("ALTER TABLE public.system_config ADD COLUMN surprise text");
      expect((await inspect()).checks.exactSixteenColumns).toBe(false);
    } finally { await fixture.exec("ALTER TABLE public.system_config DROP COLUMN IF EXISTS surprise"); }
    try {
      await fixture.exec("ALTER TABLE public.system_config ALTER COLUMN status SET DEFAULT 7");
      expect((await inspect()).checks.exactSixteenColumns).toBe(false);
    } finally { await fixture.exec("ALTER TABLE public.system_config ALTER COLUMN status SET DEFAULT 0"); }
  });

  it("rejects RLS and policies", async () => {
    try {
      await fixture.exec("ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY");
      expect((await inspect()).checks.noRowSecurity).toBe(false);
    } finally { await fixture.exec("ALTER TABLE public.system_config DISABLE ROW LEVEL SECURITY"); }
  });

  it("rejects all triggers, including disabled triggers", async () => {
    try {
      await fixture.exec("CREATE FUNCTION db003_fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$");
      await fixture.exec("CREATE TRIGGER db003_fixture_before_delete BEFORE DELETE ON public.system_config FOR EACH ROW EXECUTE FUNCTION db003_fixture_trigger()");
      await fixture.exec("ALTER TABLE public.system_config DISABLE TRIGGER db003_fixture_before_delete");
      expect((await inspect()).checks.noTriggers).toBe(false);
    } finally {
      await fixture.exec("DROP TRIGGER IF EXISTS db003_fixture_before_delete ON public.system_config");
      await fixture.exec("DROP FUNCTION IF EXISTS db003_fixture_trigger()");
    }
  });

  it("rejects a non-_RETURN rewrite rule", async () => {
    try {
      await fixture.exec("CREATE RULE db003_fixture_rule AS ON DELETE TO public.system_config DO INSTEAD NOTHING");
      expect((await inspect()).checks.noRules).toBe(false);
    } finally { await fixture.exec("DROP RULE IF EXISTS db003_fixture_rule ON public.system_config"); }
  });

  it("rejects inheritance and an inbound foreign key", async () => {
    try {
      await fixture.exec("CREATE TABLE db003_fixture_child () INHERITS (public.system_config)");
      expect((await inspect()).checks.noInheritance).toBe(false);
    } finally { await fixture.exec("DROP TABLE IF EXISTS db003_fixture_child"); }
    try {
      await fixture.exec("CREATE TABLE db003_fixture_ref (id integer REFERENCES public.system_config(id))");
      expect((await inspect()).checks.noInboundForeignKeys).toBe(false);
    } finally { await fixture.exec("DROP TABLE IF EXISTS db003_fixture_ref"); }
  });

  it("rejects wrong database or role before querying the catalog", async () => {
    await expect(inspect("wrong_database")).rejects.toThrow("identity failed");
    await expect(inspect(database, "wrong_role")).rejects.toThrow("identity failed");
  });

  it("never treats pg_control_system ACL visibility as physical identity proof", async () => {
    const report = await inspect();
    expect(typeof report.controlSystemAclExecutable).toBe("boolean");
    expect(report.originIdentityVerified).toBe(false);
    expect(report.readyForDml).toBe(false);
  });

  it("rejects missing effective maintenance DELETE privilege", async () => {
    const report = await inspect(database, appRole, noDeleteRole);
    expect(report.checks.maintenanceCatalogDelete).toBe(false);
    expect(report.catalogSafe).toBe(false);
  });
});
