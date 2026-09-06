// Independent full-schema CHECK/FK upgrade. Never extends the six-stage index child.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { readCatalog, compareCatalogs } = require("tsx/cjs/api").require("../../scripts/data-migration/postgres-catalog-audit.ts", __filename);
const { assertMissingConstraintContracts } = require("tsx/cjs/api").require("../../scripts/data-migration/missing-constraint-contracts.ts", __filename);
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");
const f = require("./missingConstraintFixtures.cjs");
const root = join(__dirname, "../..");
const manifest = JSON.parse(readFileSync(join(root, "audit/orm-missing-constraint-reconciliation.json"), "utf8"));
const sql = readFileSync(join(root, "migrations/0142_missing_constraint_alignment.sql"), "utf8");
const entries = manifest.entries, names = entries.map(e => e.key);
const q = f.quote;
const field = e => e.catalog.type === "f" ? "foreignKeys" : "checkConstraints";
const code = e => e.catalog.type === "f" ? "23503" : "23514";
const restored = catalog => ({ ...catalog, constraints: [...catalog.constraints, ...entries.map(e => e.catalog)]
  .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) });

async function auditMissingConstraints({ api, models, format, database }) {
  const started = Date.now();
  const progress = stage => console.log(`DB-009E2B ${format} ${stage}: ${Date.now() - started}ms`);
  const snapshot = api.generateDrizzleJson(models), old = structuredClone(snapshot);
  for (const e of entries) {
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot.tables["public." + e.catalog.table][field(e)][e.catalog.name])), e.snapshot);
    delete old.tables["public." + e.catalog.table][field(e)][e.catalog.name];
  }
  assert.deepEqual(Object.keys(f.invalid).sort(), entries.map(e => e.catalog.name).sort());
  const target = api.generateDrizzleJson(models, old.id);
  const generated = await api.generateMigration(old, target);
  assert.equal(generated.length, 41);
  for (const e of entries) {
    const matches = generated.filter(statement => statement.startsWith(`ALTER TABLE ${q(e.catalog.table)} ADD CONSTRAINT ${q(e.catalog.name)} `));
    assert.equal(matches.length, 1, e.key);
    assert.equal(matches[0].includes(" NOT VALID"), !e.catalog.validated, e.key);
  }
  const initial = await api.generateMigration(api.generateDrizzleJson({}), old);
  const db = database ?? new PGlite();
  const read = () => readCatalog(async query => (await db.query(query)).rows);
  const rowTables = [...new Set([...Object.keys(f.fixtures), "store_order_cart_info", "work_client_current", "work_contact_action_outbox"])].sort();
  const rows = async () => (await db.query(rowTables.map(table =>
    `SELECT '${table}' AS source,to_jsonb(t) AS row FROM public.${q(table)} t`).join(" UNION ALL ") + " ORDER BY source,row")).rows;
  const capture = async () => ({
    classIds: (await db.query("SELECT 'pg_constraint'::regclass::oid AS constraints,'pg_trigger'::regclass::oid AS triggers")).rows[0],
    catalog: await read(),
    objects: (await db.query("SELECT c.oid,c.relname,c.relkind,c.relfilenode FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    constraints: (await db.query("SELECT c.oid,t.relname||'.'||c.conname AS key,to_jsonb(c) AS metadata FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY c.oid")).rows,
    triggers: (await db.query("SELECT t.oid,to_jsonb(t) AS metadata,c.relname||'.'||k.conname AS key FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE n.nspname='public' ORDER BY t.oid")).rows,
    dependencies: (await db.query(`SELECT d.*,d.objid::text AS object_id FROM pg_depend d
      WHERE (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
      OR (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'))
      OR (d.classid='pg_trigger'::regclass AND d.objid IN (SELECT t.oid FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))
      ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`)).rows,
    rows: await rows(),
  });
  const expectAligned = (after, before) => {
    assert.deepEqual(after.catalog, restored(before.catalog));
    assertMissingConstraintContracts(after.catalog, manifest);
    assert.deepEqual(after.objects, before.objects, "No table/index/sequence/view/file replacement");
    assert.deepEqual(after.rows, before.rows, "No existing-row changes");
    const addedIds = new Set(after.constraints.filter(row => names.includes(row.key)).map(row => String(row.oid)));
    assert.equal(addedIds.size, 41);
    assert.deepEqual(after.constraints.filter(row => !addedIds.has(String(row.oid))), before.constraints, "Existing constraint OIDs/metadata");
    const addedTriggers = new Set(after.triggers.filter(row => addedIds.has(String(row.metadata.tgconstraint))).map(row => String(row.oid)));
    assert.equal(addedTriggers.size, 8);
    assert.deepEqual(after.triggers.filter(row => !addedTriggers.has(String(row.oid))), before.triggers, "Existing FK/user triggers");
    // Object OIDs alone aren't globally unique across catalogs: pair with classid.
    assert.deepEqual(after.classIds, before.classIds);
    const constraintClass = String(after.classIds.constraints), triggerClass = String(after.classIds.triggers);
    assert.ok(constraintClass && triggerClass && constraintClass !== triggerClass);
    assert.deepEqual(after.dependencies.filter(d => !(String(d.classid) === constraintClass && addedIds.has(String(d.objid)))
      && !(String(d.classid) === triggerClass && addedTriggers.has(String(d.objid)))), before.dependencies, "Non-target dependencies");
  };
  const savepoint = async operation => {
    await db.exec("SAVEPOINT constraint_probe");
    try { return await operation(); }
    finally { await db.exec("ROLLBACK TO SAVEPOINT constraint_probe; RELEASE SAVEPOINT constraint_probe"); }
  };
  const rejectWrite = (e, statement) => assert.rejects(db.exec(statement), error => matchesDatabaseError(error, code(e), e.catalog.name));
  const rejectionCases = [], oldRowsRejected = [], notValidRowsPreserved = [];
  try {
    await db.exec(initial.join("\n"));
    const initialState = await capture();
    await db.exec("BEGIN");
    try {
      await f.seed(db);
      // Real view/trigger/FK dependencies prevent destructive drop/recreate strategies.
      await db.exec(`CREATE VIEW constraint_agent_view AS SELECT id,one_brokerage FROM agent_level;
        CREATE VIEW constraint_event_view AS SELECT id,payload FROM work_callback_event;
        CREATE TABLE constraint_agent_child(parent_id integer REFERENCES agent_level(id));
        INSERT INTO constraint_agent_child VALUES(2010000001);
        CREATE FUNCTION constraint_row_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
        CREATE TRIGGER constraint_row_probe BEFORE UPDATE ON agent_level FOR EACH ROW EXECUTE FUNCTION constraint_row_probe()`);
      const fixture = await capture();
      for (const e of entries.filter(e => e.catalog.validated)) {
        await savepoint(async () => {
          await db.exec(f.update(e.catalog.table, f.invalid[e.catalog.name]));
          await rejectWrite(e, sql); // Fully validated additions must scan and reject the bad old row.
          oldRowsRejected.push(e.key);
        });
        assert.deepEqual(await capture(), fixture, e.key + " old-row rejection rollback");
      }
      for (const e of entries.filter(e => !e.catalog.validated)) {
        await savepoint(async () => {
          await db.exec(f.update(e.catalog.table, f.invalid[e.catalog.name]));
          const badOldRows = await capture();
          await db.exec(sql);
          expectAligned(await capture(), badOldRows);
          const beforeWrite = await capture();
          await savepoint(() => rejectWrite(e, f.update(e.catalog.table, f.invalid[e.catalog.name])));
          await savepoint(() => rejectWrite(e, f.insert(e.catalog.table, { ...f.newRow(e.catalog.table), ...f.invalid[e.catalog.name] })));
          await savepoint(() => rejectWrite(e, `ALTER TABLE ${q(e.catalog.table)} VALIDATE CONSTRAINT ${q(e.catalog.name)}`));
          assert.deepEqual(await capture(), beforeWrite);
          notValidRowsPreserved.push(e.key);
        });
        assert.deepEqual(await capture(), fixture);
      }
      progress("33 validated / 8 NOT VALID old-row probes");
      const rejectDrift = async (name, setup) => {
        await savepoint(async () => {
          await db.exec(setup);
          await assert.rejects(db.exec(sql), error => (assert.equal(error.code, "P0001"), assert.match(error.message, /0142/), true));
        });
        assert.deepEqual(await capture(), fixture, name + " refusal rollback");
        rejectionCases.push(name);
      };
      // Every restored name must reject an unexpected definition; never drop/overwrite it.
      for (const e of entries) await rejectDrift("definition:" + e.key,
        `ALTER TABLE ${q(e.catalog.table)} ADD CONSTRAINT ${q(e.catalog.name)} CHECK (true)`);
      for (const [name, setup] of [
        ["column-type", "ALTER TABLE agent_level ALTER COLUMN two_brokerage TYPE integer"],
        ["nullable", "ALTER TABLE agent_level ALTER COLUMN two_brokerage DROP NOT NULL"],
        ["missing-column", "ALTER TABLE agent_level RENAME COLUMN two_brokerage TO old_value"],
        ["missing-table", "ALTER TABLE system_menus RENAME TO old_menus"],
        ["missing-schema", "SET LOCAL search_path TO missing_constraint_schema"],
        ["collation", 'ALTER TABLE work_callback_watermark ALTER COLUMN event_key TYPE varchar(64) COLLATE "C"'],
        ["generated", "ALTER TABLE system_menus DROP COLUMN auth_type; ALTER TABLE system_menus ADD COLUMN auth_type smallint GENERATED ALWAYS AS (0) STORED NOT NULL"],
        ["inherited", "CREATE TABLE constraint_child() INHERITS(system_menus)"],
        ["unlogged", "ALTER TABLE system_menus SET UNLOGGED"],
        ["parent-key-name", "ALTER TABLE store_order_cart_info RENAME CONSTRAINT store_order_cart_info_pkey TO unreviewed_key"],
        ["equivalent-alias", "ALTER TABLE agent_level ADD CONSTRAINT unreviewed_alias " + entries[0].sources[0].sql.replace(/^CONSTRAINT\s+"[^"]+"\s+/, "")],
      ]) await rejectDrift(name, setup);
      for (const e of entries) {
        const proposal = generated.find(statement => statement.startsWith(`ALTER TABLE ${q(e.catalog.table)} ADD CONSTRAINT ${q(e.catalog.name)} `));
        const changed = e.catalog.validated ? proposal.replace(/;$/, " NOT VALID;") : proposal.replace(" NOT VALID", "");
        await rejectDrift("validation:" + e.key, changed);
      }
      for (const e of entries.filter(e => e.catalog.type === "f")) {
        const proposal = generated.find(statement => statement.startsWith(`ALTER TABLE ${q(e.catalog.table)} ADD CONSTRAINT ${q(e.catalog.name)} `));
        await rejectDrift("disabled-triggers:" + e.key, proposal + ` ALTER TABLE ${q(e.catalog.table)} DISABLE TRIGGER ALL`);
        await rejectDrift("deferred:" + e.key, proposal + ` ALTER TABLE ${q(e.catalog.table)} ALTER CONSTRAINT ${q(e.catalog.name)} DEFERRABLE INITIALLY DEFERRED`);
        const wrongParent = proposal.replace(`"public".${q(e.reference.table)}`, '"public"."agent_level"');
        assert.notEqual(wrongParent, proposal);
        await rejectDrift("wrong-parent:" + e.key, wrongParent);
      }
      progress("all metadata drift refusals");
      const add = "EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I ADD CONSTRAINT %I %s',target_schema,target.\"table\",target.name,target.ddl);";
      assert.ok(sql.includes(add));
      await savepoint(() => assert.rejects(db.exec(sql.replace(add, () => add + "\n PERFORM 1/0;")), { code: "22012" }));
      assert.deepEqual(await capture(), fixture);
      await savepoint(async () => {
        await db.exec(generated.join("\n"));
        expectAligned(await capture(), fixture);
      });
      assert.deepEqual(await capture(), fixture);
      await db.exec(sql);
      expectAligned(await capture(), fixture);
      const aligned = await capture();
      await db.exec(sql);
      assert.deepEqual(await capture(), aligned, "No-op includes all constraint and trigger OIDs");
      for (const e of entries) {
        await savepoint(() => rejectWrite(e, f.update(e.catalog.table, f.invalid[e.catalog.name])));
        await savepoint(() => rejectWrite(e, f.insert(e.catalog.table, { ...f.newRow(e.catalog.table), ...f.invalid[e.catalog.name] })));
      }
      for (const [name, values] of f.edgeCases) {
        const e = entries.find(e => e.catalog.name === name);
        await savepoint(() => rejectWrite(e, f.update(e.catalog.table, values)));
      }
      await savepoint(async () => {
        await db.exec(f.update("agent_level", { one_brokerage: "0", two_brokerage: "1000" }));
        await db.exec(f.update("work_contact_action_audit", { operation: "'RETRY_WITH_RISK'", risk_accepted: "true", provider_reference_hash: "NULL" }));
        await db.exec(f.update("work_callback_event", { payload: "'{\"nested\":[null,1]}'::jsonb" }));
        await db.exec(f.insert("store_product_reply", { ...f.newRow("store_product_reply"), order_cart_info_id: "NULL" }));
        await db.exec(f.update("store_product_reply", { order_cart_info_id: "NULL" }));
      });
      await savepoint(() => rejectWrite(entries.find(e => e.catalog.name === "spr_order_cart_info_fk"),
        "DELETE FROM store_order_cart_info WHERE id=2010000001"));
      await savepoint(() => rejectWrite(entries.find(e => e.catalog.name === "spr_order_cart_info_fk"),
        "UPDATE store_order_cart_info SET id=2010000999 WHERE id=2010000001"));
      await savepoint(async () => {
        // The second parent is not referenced by the existing RESTRICT action FK.
        await db.exec(f.insert("work_callback_outbox", f.newRow("work_callback_outbox")));
        await db.exec("DELETE FROM work_callback_event WHERE id=2010000002");
        assert.equal((await db.query("SELECT count(*)::integer AS n FROM work_callback_outbox WHERE event_id=2010000002")).rows[0].n, 0);
      });
      assert.deepEqual(await capture(), aligned);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    await db.exec("BEGIN");
    try {
      await db.exec(generated[0]);
      await db.exec("CREATE TEMP TABLE system_menus(id integer); SET LOCAL search_path TO public,pg_temp");
      await db.exec(sql);
      expectAligned(await capture(), initialState);
      assert.equal((await db.query("SELECT to_regclass('pg_temp.system_menus') IS NOT NULL AS kept")).rows[0].kept, true);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    await db.exec("BEGIN");
    try {
      await db.exec("CREATE SCHEMA constraint_scope");
      const guard = JSON.parse(sql.split("$constraint_data$")[1]);
      for (const table of [...new Set(guard.columns.map(c => c.table))]) {
        await db.exec(`CREATE TABLE constraint_scope.${q(table)} (LIKE public.${q(table)} INCLUDING ALL)`);
      }
      // Shadowing built-ins in the target schema must not affect CHECK creation.
      await db.exec("CREATE FUNCTION constraint_scope.jsonb_typeof(jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT 'broken'::text$$");
      await db.exec("CREATE TEMP TABLE system_menus(id integer)");
      // LIKE INCLUDING DEFAULTS itself adds cross-schema sequence dependencies.
      // Preserve those fixture dependencies too; they are not migration effects.
      const scopedFixture = await capture();
      await db.exec("SET LOCAL search_path TO constraint_scope,pg_temp,public,pg_catalog");
      assert.equal((await db.query("SELECT jsonb_typeof('{}'::jsonb) AS value")).rows[0].value, "broken");
      await db.exec(sql);
      assert.equal((await db.query("SHOW search_path")).rows[0].search_path, "constraint_scope, pg_temp, public, pg_catalog");
      await db.exec("SET LOCAL search_path TO pg_catalog,constraint_scope,pg_temp,public");
      const scoped = await readCatalog(async query => (await db.query(query.replaceAll("n.nspname='public'", "n.nspname='constraint_scope'"))).rows);
      assertMissingConstraintContracts(scoped, manifest);
      assert.deepEqual((await db.query(`SELECT n.nspname AS schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_namespace own ON own.oid=c.connamespace
        WHERE own.nspname='constraint_scope' AND c.contype='f' ORDER BY c.conname`)).rows,
        [{ schema: "constraint_scope" }, { schema: "constraint_scope" }]);
      await db.exec("SET LOCAL search_path TO constraint_scope,pg_temp,public,pg_catalog");
      await db.exec(sql);
      await db.exec("SET LOCAL search_path TO public,pg_temp");
      assert.deepEqual(await capture(), scopedFixture);
    } finally { await db.exec("ROLLBACK"); }
    assert.deepEqual(await capture(), initialState);
    const committedNotValid = await require("./committedNotValidConstraintAudit.cjs")({ db, sql, entries });
    assert.deepEqual(await capture(), initialState, "Committed-row fixture cleanup must preserve the full original public state");
    progress("8 committed old rows / new references / unchanged orphan distinction");
    await db.exec("BEGIN");
    try { await db.exec(sql); await db.exec("COMMIT"); }
    catch (error) { await db.exec("ROLLBACK"); throw error; }
    expectAligned(await capture(), initialState);
    const after = await capture();
    await db.exec(sql);
    assert.deepEqual(await capture(), after);
    assert.deepEqual(await api.generateMigration(target, api.generateDrizzleJson(models, target.id)), []);
    const diff = compareCatalogs(initialState.catalog, after.catalog);
    for (const [kind, changes] of Object.entries(diff)) for (const [change, rows] of Object.entries(changes)) {
      if (kind === "constraints" && change === "candidateOnly") assert.deepEqual(rows, entries.map(e => e.catalog));
      else assert.deepEqual(rows, []);
    }
    console.log(`DB-009E2B ${format}: 41 constraints, ${oldRowsRejected.length} invalid-old-row refusals, ${notValidRowsPreserved.length} NOT VALID contracts, ${rejectionCases.length} drift refusals; writes/dependencies/rollback/no-op/schema isolation passed`);
    return { initialStatements: initial.length, guardedStatements: 1, generatedConstraintStatements: generated.length, constraintsAdded: names,
      oldRowsRejected, notValidRowsPreserved, committedNotValid, rejectionCases, invalidInsertAndUpdateContracts: 41, edgeCaseRejections: f.edgeCases.length,
      nonTargetOidsFilesRowsAndDependenciesPreserved: true, generatedProposalMatchesGuardedResult: true, failureRollbackConfirmed: true,
      noOpIncludesConstraintAndTriggerOids: true, fkNullNoActionAndCascadeConfirmed: true, mixedStateAndTempIsolationConfirmed: true,
      nonPublicSchemaAndBuiltInIsolationConfirmed: true };
  } finally { if (!database) await db.close(); }
}
module.exports = auditMissingConstraints;
