const assert = require("node:assert/strict");
const { PgDialect, pgSchema, pgSequence, serial, integer } = require("drizzle-orm/pg-core");
const { withSequenceState } = require("tsx/cjs/api").require("../../src/models/pgSequenceState.ts", __filename);
const schema = require("./sequenceStateSchema.cjs");
const persist = value => JSON.parse(JSON.stringify(value));
const q = value => '"' + value.replace(/"/g, '""') + '"';
module.exports = async ({ api, db, format }) => {
  const empty = persist(api.generateDrizzleJson({}));
  const baseline = persist(api.generateDrizzleJson(schema("baseline")));
  const target = persist(api.generateDrizzleJson(schema()));
  const initial = await api.generateMigration(empty, target);
  const upgrade = await api.generateMigration(baseline, target);
  const keys = Object.keys(target.sequences).sort();
  assert.equal(keys.length, 4);
  assert.equal(initial.filter(s => s.startsWith("CREATE SEQUENCE ")).length, 4);
  assert.equal(initial.filter(s => / OWNED BY /.test(s)).length, 4);
  assert.equal(upgrade.filter(s => / OWNED BY /.test(s)).length, 4);
  for (const [key, seq] of Object.entries(target.sequences)) {
    assert.ok(seq.cinashopSequence);
    const create = initial.findIndex(s => s.startsWith("CREATE SEQUENCE " + q(seq.schema) + "." + q(seq.name)));
    assert.ok(create >= 0);
    const owner = seq.cinashopSequence.ownedBy;
    if (owner) {
      const table = initial.findIndex(s => s.startsWith("CREATE TABLE " + (owner.schema === "public" ? "" : q(owner.schema) + ".") + q(owner.table)));
      const own = initial.findIndex(s => s.includes(q(seq.name) + " OWNED BY "));
      assert.ok(table > create && own > table, key + " must bind after its table exists");
    }
  }
  assert.ok(initial.some(s => /AS smallint.*MAXVALUE 32767/.test(s)));
  assert.ok(initial.some(s => /AS integer.*MAXVALUE 2147483647/.test(s)));
  assert.ok(initial.some(s => /START WITH 9007199254740993/.test(s)));
  assert.ok(initial.some(s => /"quoted""sequence;"/.test(s)));
  assert.ok(initial.every(s => !/RESTART|setval|DROP SEQUENCE/.test(s)));
  assert.deepEqual(await api.generateMigration(target, persist(api.generateDrizzleJson(schema(), target.id))), []);
  let unsafeNumericInputsRefused = 0;
  for (const field of ["increment", "minValue", "maxValue", "startWith", "cache"]) {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity]) {
      const invalid = withSequenceState(pgSequence("seq_invalid", { [field]: value }), { dataType: "bigint", ownedBy: null });
      assert.throws(() => api.generateDrizzleJson({ invalid }), /unsafe sequence numeric input/);
      unsafeNumericInputsRefused++;
    }
  }
  const smallKey = "public.seq_small";
  let malformedRefusals = 0;
  for (const patch of [
    s => { s.cinashopSequence = null; }, s => { s.cinashopSequence.dataType = "numeric"; },
    s => { s.cinashopSequence.ownedBy = {}; }, s => { s.cinashopSequence.ownedBy.schema = "wrong"; },
    s => { s.cinashopSequence.ownedBy.table = "absent"; }, s => { s.cinashopSequence.ownedBy.column = "absent"; },
    s => { s.cinashopSequence.ownedBy.extra = true; }, s => { s.extra = true; },
    s => { s.maxValue = "32768"; }, s => { s.minValue = "-32769"; }, s => { s.increment = "0"; },
    s => { s.cache = "0"; }, s => { s.startWith = "32768"; }, s => { s.cycle = "false"; },
    s => { s.minValue = s.maxValue; }, s => { s.increment = "1; SELECT 1"; },
    s => { s.name = "\0bad"; }, s => { s.name = "x".repeat(64); }, s => { s.name = "wrong_key"; },
  ]) {
    const malformed = persist(target); patch(malformed.sequences[smallKey]);
    await assert.rejects(api.generateMigration(empty, malformed)); malformedRefusals++;
  }
  for (const change of [
    s => { delete s.sequences[smallKey].cinashopSequence; },
    s => { delete s.sequences[smallKey]; },
    s => { s.sequences["public.renamed"] = { ...s.sequences[smallKey], name: "renamed" }; delete s.sequences[smallKey]; },
  ]) {
    const drift = persist(target); change(drift);
    await assert.rejects(api.generateMigration(target, drift), /DB-009E5/); malformedRefusals++;
  }
  const catalog = async () => (await db.query("SELECT n.nspname AS schema,c.relname AS name,c.oid::text,c.relfilenode::text," +
    "s.seqtypid::regtype::text AS type,s.seqstart::text AS start,s.seqmin::text AS min,s.seqmax::text AS max," +
    "s.seqincrement::text AS increment,s.seqcache::text AS cache,s.seqcycle AS cycle," +
    "d.deptype,CASE WHEN d.objid IS NULL THEN NULL ELSE tn.nspname||'.'||t.relname||'.'||a.attname END AS owned_by," +
    "obj_description(c.oid,'pg_class') AS comment FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace " +
    "LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN('a','i') " +
    "LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid " +
    "WHERE n.nspname IN ('public','seq_tenant') ORDER BY n.nspname,c.relname")).rows;
  const states = async () => Object.fromEntries(await Promise.all(Object.values(baseline.sequences).map(async s =>
    [s.schema + "." + s.name, (await db.query("SELECT last_value::text,is_called FROM " + q(s.schema) + "." + q(s.name))).rows[0]])));
  await db.exec("BEGIN"); await db.exec(initial.join("\n"));
  const fresh = await catalog();
  const shape = rows => rows.map(({ oid, relfilenode, comment, ...r }) => r);
  assert.deepEqual(fresh.map(r => r.type).sort(), ["bigint", "integer", "integer", "smallint"]);
  assert.equal(fresh.filter(r => r.deptype === "a").length, 3);
  await db.exec("ROLLBACK");
  const descending = withSequenceState(pgSequence("seq_descending", { increment: -1 }), { dataType: "smallint", ownedBy: null });
  const descendingSql = await api.generateMigration(empty, persist(api.generateDrizzleJson({ descending })));
  assert.ok(descendingSql.some(s => /AS smallint INCREMENT BY -1 MINVALUE -32768 MAXVALUE -1 START WITH -1/.test(s)));
  await db.exec("BEGIN"); await db.exec(descendingSql.join("\n"));
  assert.deepEqual((await db.query("SELECT nextval('public.seq_descending')::text AS first,nextval('public.seq_descending')::text AS second")).rows, [{ first: "-1", second: "-2" }]);
  await db.exec("ROLLBACK");
  await db.exec((await api.generateMigration(empty, baseline)).join("\n"));
  await db.exec("COMMENT ON SEQUENCE public.seq_small IS 'preserve 注释'; INSERT INTO seq_small_owner(memo) VALUES('old'),('old2'); INSERT INTO seq_tenant.seq_int_owner(memo) VALUES('old'); INSERT INTO seq_big_owner DEFAULT VALUES");
  const old = await catalog(), oldStates = await states();
  await db.exec("BEGIN"); await db.exec(upgrade.join("\n"));
  assert.deepEqual(shape(await catalog()), shape(fresh));
  assert.deepEqual(await states(), oldStates);
  for (const row of old) {
    const after = (await catalog()).find(r => r.schema === row.schema && r.name === row.name);
    assert.equal(after.oid, row.oid); assert.equal(after.comment, row.comment);
  }
  await db.exec("ROLLBACK"); assert.deepEqual(await catalog(), old); assert.deepEqual(await states(), oldStates);
  await db.exec("BEGIN"); await db.exec(upgrade.join("\n")); await db.exec("COMMIT");
  const aligned = await catalog(); assert.deepEqual(shape(aligned), shape(fresh)); assert.deepEqual(await states(), oldStates);
  assert.deepEqual((await db.query("SELECT uid FROM seq_small_owner ORDER BY uid")).rows, [{ uid: 10 }, { uid: 11 }]);
  assert.deepEqual((await db.query("INSERT INTO seq_small_owner(memo) VALUES('new') RETURNING uid")).rows, [{ uid: 12 }]);
  assert.deepEqual((await db.query("INSERT INTO seq_big_owner DEFAULT VALUES RETURNING uid::text")).rows, [{ uid: "9007199254740994" }]);
  // Explicit NONE must remove an existing automatic ownership, not be silently omitted.
  const detached = persist(target); detached.sequences[smallKey].cinashopSequence.ownedBy = null;
  const detach = await api.generateMigration(target, detached);
  assert.ok(detach.some(s => s.endsWith(" OWNED BY NONE;")));
  await db.exec("BEGIN"); await db.exec(detach.join("\n")); assert.equal((await catalog()).find(r => r.name === "seq_small").owned_by, null); await db.exec("ROLLBACK");
  assert.deepEqual(await catalog(), aligned);
  // Changing NO CYCLE must be explicit even when false, unlike the upstream omission.
  const cycling = persist(target); cycling.sequences[smallKey].cycle = true;
  await db.exec("BEGIN"); await db.exec((await api.generateMigration(target, cycling)).join("\n"));
  assert.equal((await catalog()).find(r => r.name === "seq_small").cycle, true);
  await db.exec((await api.generateMigration(cycling, target)).join("\n")); assert.equal((await catalog()).find(r => r.name === "seq_small").cycle, false);
  await db.exec("ROLLBACK");
  await db.exec("BEGIN; ALTER TABLE seq_small_owner DROP COLUMN uid;");
  assert.equal((await db.query("SELECT to_regclass('public.seq_small') IS NULL AS absent")).rows[0].absent, true);
  await db.exec("ROLLBACK"); assert.deepEqual(await catalog(), aligned);
  // This consumes a value even after ROLLBACK; do not assert transactionally gapless IDs.
  const prior = (await states())[smallKey]; await db.exec("BEGIN");
  const consumed = (await db.query("SELECT nextval('public.seq_small')::text AS value")).rows[0].value;
  await db.exec("ROLLBACK"); assert.equal((await states())[smallKey].last_value, consumed); assert.notEqual(consumed, prior.last_value);
  await db.exec("SELECT setval('public.seq_small',32767,true)");
  await assert.rejects(db.exec("SELECT nextval('public.seq_small')"), { code: "2200H" });
  const queries = [], diagnostics = [], dialect = new PgDialect(), exit = process.exit, error = console.error;
  try {
    process.exit = code => { assert.equal(code, 1); throw new Error("expected sequence introspection exit"); };
    console.error = (...args) => diagnostics.push(args.join(" "));
    await assert.rejects(api.pushSchema(schema(), { execute: async query => {
      const text = dialect.sqlToQuery(query).sql; assert.match(text, /^\s*(SELECT|WITH)\b/i); queries.push(text);
      return db.query(text);
    } }, ["public", "seq_tenant"]), /expected sequence introspection exit/);
  } finally { process.exit = exit; console.error = error; }
  assert.ok(diagnostics.some(s => s.includes("custom sequence introspection is unsupported")));
  assert.ok(queries.some(s => s.includes("seqtypid::regtype")));
  assert.deepEqual(await catalog(), aligned);
  // The read-only refusal must not accidentally disable ordinary upstream introspection.
  const plain = pgSchema("seq_plain");
  const ordinary = plain.table("ordinary", { id: serial().primaryKey(), identity: integer().generatedAlwaysAsIdentity() });
  const free = plain.sequence("free", { startWith: 3, increment: 2, cycle: true });
  const ordinaryModels = { plain, ordinary, free };
  await db.exec((await api.generateMigration(empty, api.generateDrizzleJson(ordinaryModels))).join("\n"));
  const supportedQueries = [];
  const supported = await api.pushSchema(ordinaryModels, { execute: async query => {
    const text = dialect.sqlToQuery(query).sql; assert.match(text, /^\s*(SELECT|WITH)\b/i); supportedQueries.push(text);
    return db.query(text);
  } }, ["seq_plain"]);
  assert.deepEqual(supported.statementsToExecute, []);
  assert.ok(supportedQueries.some(s => s.includes("seqtypid::regtype")));
  console.log("DB-009E5 " + format + ": sequence generation/state/ownership/rollback verified");
  return { initialStatements: initial.length, upgradeStatements: upgrade.length, sequences: keys,
    malformedRefusals, unsafeNumericInputsRefused, snapshotRoundTrip: true, freshUpgradeCatalogMatched: true, counterPreservedByAlter: true,
    originalOidsCommentsRowsPreserved: true, ddlRollbackConfirmed: true, ownershipDeletionRollbackConfirmed: true,
    detachAndNoCycleConfirmed: true, descendingTypedDefaultsConfirmed: true, bigIntegerExact: true, nextvalNotRolledBack: true, exhaustionCode: "2200H",
    introspectionRefusedReadOnly: true, ordinarySerialIdentityAndUnownedBigintIntrospectionPreserved: true };
};
