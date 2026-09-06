import assert from "node:assert/strict";
import { catalogKinds, compareCatalogs, readCatalog, type CatalogQuery } from "../../scripts/data-migration/postgres-catalog-audit";
import { assertAllTablesAligned, TABLE_CATALOG_COUNT } from "../../scripts/data-migration/table-catalog-contracts";

/** Only called on an identity-checked, self-created empty test DB (or local memory). */
export async function verifyTableCatalogGate(db: { exec: (statement: string) => Promise<unknown>; query: CatalogQuery }) {
  const read = () => readCatalog(db.query);
  const empty = await read();
  assert.ok(catalogKinds.every(kind => empty[kind].length === 0), "Table gate probe requires an empty public catalog");
  const create = Array.from({ length: TABLE_CATALOG_COUNT }, (_, i) =>
    `CREATE TABLE public.table_gate_${String(i).padStart(3, "0")} (id integer, alternate integer)${i === 0 ? " PARTITION BY RANGE (id)" : ""};`);
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL search_path TO pg_catalog, public, pg_temp; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='2s'");
    await db.exec(create.join("\n"));
    assertAllTablesAligned(await read(), await read());
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
  const original = await read();
  const identical = compareCatalogs(original, original);
  const cases = [
    { name: "rls-enabled", sql: "ALTER TABLE public.table_gate_003 ENABLE ROW LEVEL SECURITY", fields: ["rowSecurity"] },
    { name: "rls-forced", sql: "ALTER TABLE public.table_gate_003 FORCE ROW LEVEL SECURITY", fields: ["forceRowSecurity"] },
    { name: "persistence", sql: "ALTER TABLE public.table_gate_003 SET UNLOGGED", fields: ["persistence"] },
    { name: "kind", sql: "DROP TABLE public.table_gate_001; CREATE TABLE public.table_gate_001 (id integer, alternate integer) PARTITION BY RANGE (id)", fields: ["kind", "partitionKey"] },
    { name: "partition-key", sql: "DROP TABLE public.table_gate_000; CREATE TABLE public.table_gate_000 (id integer, alternate integer) PARTITION BY RANGE (alternate)", fields: ["partitionKey"] },
    { name: "partition-member", sql: "ALTER TABLE public.table_gate_000 ATTACH PARTITION public.table_gate_002 FOR VALUES FROM (0) TO (100)", fields: ["partition"] },
    { name: "renamed", sql: "ALTER TABLE public.table_gate_003 RENAME TO table_gate_renamed", fields: null },
    { name: "missing", sql: "DROP TABLE public.table_gate_003", fields: null },
    { name: "extra", sql: "CREATE TABLE public.table_gate_extra (id integer)", fields: null },
  ];
  const refused: string[] = [];
  for (const probe of cases) {
    await db.exec("BEGIN");
    try {
      await db.exec("SET LOCAL search_path TO pg_catalog, public, pg_temp; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");
      await db.exec(probe.sql);
      const changed = await read(), delta = compareCatalogs(original, changed);
      if (probe.fields) {
        // These six real engine changes are invisible to the other four gates.
        assert.deepEqual(delta.tables.changed.map(row => row.fields), [probe.fields]);
        for (const kind of catalogKinds.filter(kind => kind !== "tables")) assert.deepEqual(delta[kind], identical[kind]);
      }
      assert.throws(() => assertAllTablesAligned(original, changed), /Full table catalog differs|Complete table cohort changed/, probe.name);
      assert.throws(() => assertAllTablesAligned(changed, original), /Full table catalog differs|Complete table cohort changed/, `reverse ${probe.name}`);
      refused.push(probe.name);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(compareCatalogs(original, await read()), identical, `rollback ${probe.name}`);
  }
  // The fixed public reader must not select a same-named temporary table.
  await db.exec("BEGIN");
  try {
    await db.exec("CREATE TEMP TABLE table_gate_003 (other text)");
    assertAllTablesAligned(original, await read());
  } finally { await db.exec("ROLLBACK"); }
  assert.deepEqual(compareCatalogs(original, await read()), identical);
  return {
    fixtureTables: TABLE_CATALOG_COUNT, engineDriftRefusals: refused,
    bothComparisonDirectionsRefused: true, tableOnlyChangesInvisibleToOtherCategories: 6,
    allFiveCategoriesRestoredAfterEachRollback: true, temporaryShadowIgnored: true,
    scope: "Self-created fixture metadata only; no policy authorization or production equivalence claim",
  };
}
