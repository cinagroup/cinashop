// Distinguish committed historical rows from tuples created in the current transaction.
const assert = require("node:assert/strict");
const f = require("./missingConstraintFixtures.cjs");
const { matchesDatabaseError } = require("./constraintNameAudit.cjs");

module.exports = async function auditCommittedNotValid({ db, sql, entries }) {
  const schema = "constraint_committed_rows";
  const pending = entries.filter(e => !e.catalog.validated);
  const shape = JSON.parse(sql.split("$constraint_data$")[1]);
  const samples = pending.map((e, i) => {
    const key = e.catalog.table === "store_product_description" ? "product_id" : "id";
    return { e, key, id: String(2010000200 + i), row: { ...f.fixtures[e.catalog.table], [key]: String(2010000200 + i), ...f.invalid[e.catalog.name] } };
  });
  const readRows = async () => (await db.query([...new Set(pending.map(e => e.catalog.table))].map(table =>
    `SELECT '${table}' AS source,to_jsonb(t) AS row FROM ${f.quote(schema)}.${f.quote(table)} t`).join(" UNION ALL ") + " ORDER BY source,row")).rows;
  let created = false, inTransaction = false;
  const savepoint = async operation => {
    await db.exec("SAVEPOINT committed_row_probe");
    try { return await operation(); }
    finally { await db.exec("ROLLBACK TO SAVEPOINT committed_row_probe; RELEASE SAVEPOINT committed_row_probe"); }
  };
  try {
    // No IF NOT EXISTS: an unexpected pre-existing schema is never adopted/deleted.
    await db.exec(`CREATE SCHEMA ${f.quote(schema)}`);
    created = true;
    await db.exec("BEGIN"); inTransaction = true;
    for (const table of [...new Set(shape.columns.map(c => c.table))]) {
      await db.exec(`CREATE TABLE ${f.quote(schema)}.${f.quote(table)} (LIKE public.${f.quote(table)} INCLUDING ALL)`);
    }
    for (const sample of samples) await db.exec(f.insert(sample.e.catalog.table, sample.row, schema));
    await db.exec("COMMIT"); inTransaction = false;
    const oldRows = await readRows();
    assert.equal(oldRows.length, 8);
    await db.exec("BEGIN"); inTransaction = true;
    await db.exec(`SET LOCAL search_path TO ${f.quote(schema)},pg_temp,public`);
    await db.exec(sql);
    await db.exec("COMMIT"); inTransaction = false;
    assert.deepEqual(await readRows(), oldRows);
    const validation = (await db.query(`SELECT t.relname||'.'||c.conname AS key,c.convalidated AS validated FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${schema}' AND NOT c.convalidated ORDER BY key`)).rows;
    assert.deepEqual(validation, pending.map(e => ({ key: e.key, validated: false })));
    await db.exec("BEGIN"); inTransaction = true;
    for (const sample of samples) {
      const { e, key, id } = sample;
      const invalid = e.catalog.type === "f" ? { order_cart_info_id: "2010000998" } : f.invalid[e.catalog.name];
      const errorCode = e.catalog.type === "f" ? "23503" : "23514";
      const reject = statement => assert.rejects(db.exec(statement), error => matchesDatabaseError(error, errorCode, e.catalog.name));
      const update = `UPDATE ${f.quote(schema)}.${f.quote(e.catalog.table)} SET ${Object.entries(invalid).map(([name, value]) => f.quote(name) + "=" + value)} WHERE ${f.quote(key)}=${id}`;
      await savepoint(() => reject(update));
      await savepoint(() => reject(f.insert(e.catalog.table, { ...f.newRow(e.catalog.table), [key]: String(Number(id) + 100), ...invalid }, schema)));
      await savepoint(() => reject(`ALTER TABLE ${f.quote(schema)}.${f.quote(e.catalog.table)} VALIDATE CONSTRAINT ${f.quote(e.catalog.name)}`));
      await savepoint(() => db.exec(f.insert(e.catalog.table, { ...f.newRow(e.catalog.table), [key]: String(Number(id) + 200),
        ...(e.catalog.type === "f" ? { order_cart_info_id: "NULL" } : {}) }, schema)));
    }
    // PostgreSQL may skip an FK check when its key is unchanged on a committed
    // historical orphan. NOT VALID is not a promise to revalidate every old row.
    await savepoint(() => db.exec(`UPDATE ${f.quote(schema)}.store_product_reply SET is_del=1,order_cart_info_id=order_cart_info_id`));
    assert.deepEqual(await readRows(), oldRows);
    await db.exec("ROLLBACK"); inTransaction = false;
    return { committedOldRowsPreserved: 8, newInvalidInsertsRejected: 8, changedInvalidUpdatesRejected: 8,
      explicitValidationRejected: 8, validNewRowsAccepted: 8, unchangedCommittedOrphanKeyAllowed: true };
  } finally {
    if (inTransaction) await db.exec("ROLLBACK");
    // Fixed name is eligible only after our own successful CREATE in this isolated DB.
    if (created) {
      await db.exec(`DROP SCHEMA ${f.quote(schema)} CASCADE`);
      assert.equal((await db.query(`SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname='${schema}'`)).rows[0].n, 0);
    }
  }
};
