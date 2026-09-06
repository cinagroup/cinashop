// Read-only DB-009E3 source preparation: no database, model or migration writes.
// This pre-edit extractor requires the unrenamed inline-reference models. Once
// renamed, use foreign-key-name-alignment.test.ts and the PG16 audit for repeatable
// verification against the frozen source/model/snapshot manifest instead.
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");
const { is } = require("drizzle-orm");
const { PgTable, getTableConfig } = require("drizzle-orm/pg-core");
const api = require("drizzle-kit/api");
const models = require("tsx/cjs/api").require("../src/models/schema/index.ts", __filename);
const root = join(__dirname, "..");
const read = file => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json"));
const verified = JSON.parse(read("../MIGRATION_SCHEMA_AUDIT.json"));
const records = baseline.records.filter(r => r.comparison === "externalVsOrm" && r.category === "constraints");
const find = (change, key) => records.find(r => r.change === change && r.value.key === key)?.value;
const entries = records.filter(r => r.change === "possibleRenames").map(r => ({
  key: r.value.reference, previousKey: r.value.candidate,
  catalog: find("referenceOnly", r.value.reference), previousCatalog: find("candidateOnly", r.value.candidate),
})).filter(e => e.catalog.type === "f");
assert.equal(entries.length, 12);
const snapshot = api.generateDrizzleJson(models);
const declarations = new Map();
for (const name of readdirSync(join(root, "src/models/schema")).filter(n => n.endsWith(".ts"))) {
  const file = "src/models/schema/" + name, source = read(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(parsed) === "pgTable" && ts.isStringLiteral(node.initializer.arguments[0])) {
      const call = node.initializer, table = call.arguments[0].text;
      assert.ok(!declarations.has(table), `Duplicate table declaration: ${table}`);
      declarations.set(table, { file, parsed, call, exportName: node.name.getText(parsed) });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
const fields = table => Object.entries(table).filter(([, c]) => c && typeof c.getSQLType === "function")
  .map(([property, c]) => ({ property, name: c.name, type: c.getSQLType(), notNull: c.notNull }));
const migrationFiles = [...readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort().map(n => "migrations/" + n),
  "src/services/MigrationService.ts", ...readdirSync(join(root, "src/migrations")).filter(n => n.endsWith(".ts")).sort().map(n => "src/migrations/" + n)];
for (const e of entries) {
  assert.deepEqual(e.catalog, { ...e.previousCatalog, key: e.key, name: e.catalog.name });
  const d = declarations.get(e.catalog.table), table = models[d.exportName];
  assert.ok(is(table, PgTable));
  const old = Object.values(snapshot.tables["public." + e.catalog.table].foreignKeys).filter(fk => {
    const prefix = `FOREIGN KEY (${fk.columnsFrom.join(", ")}) REFERENCES ${fk.tableTo}(${fk.columnsTo.join(", ")})`;
    return e.catalog.definition.startsWith(prefix);
  });
  assert.equal(old.length, 1, e.key);
  e.previousSnapshot = JSON.parse(JSON.stringify(old[0]));
  e.snapshot = { ...e.previousSnapshot, name: e.catalog.name };
  const matching = getTableConfig(table).foreignKeys.filter(fk => {
    const ref = fk.reference();
    return ref.columns.map(c => c.name).join() === e.previousSnapshot.columnsFrom.join()
      && getTableConfig(ref.foreignTable).name === e.previousSnapshot.tableTo;
  });
  assert.equal(matching.length, 1, e.key);
  const ref = matching[0].reference();
  e.columns = fields(table).filter(f => e.previousSnapshot.columnsFrom.includes(f.name));
  e.reference = { table: e.previousSnapshot.tableTo, columns: fields(ref.foreignTable).filter(f => e.previousSnapshot.columnsTo.includes(f.name)) };
  assert.equal(e.columns.length, 1);
  const property = d.call.arguments[1].properties.find(p => p.name?.getText(d.parsed) === e.columns[0].property);
  assert.ok(property && ts.isPropertyAssignment(property));
  const previousDeclaration = property.getText(d.parsed);
  const match = previousDeclaration.match(/\s*\.references\(\(\) => ([A-Za-z0-9_]+\.[A-Za-z0-9_]+), \{ onDelete: "(restrict|cascade)" \}\)$/);
  assert.ok(match, `Expected reviewed inline reference: ${e.key}`);
  const extra = d.call.arguments[2];
  assert.ok(ts.isArrowFunction(extra) && ts.isArrayLiteralExpression(extra.body) && extra.parameters.length === 1);
  const parameter = extra.parameters[0].name.getText(d.parsed);
  e.model = { file: d.file, exportName: d.exportName, line: d.parsed.getLineAndCharacterOfPosition(property.getStart(d.parsed)).line + 1,
    previousDeclaration, declaration: previousDeclaration.slice(0, match.index),
    foreignKeyDeclaration: `foreignKey({ name: "${e.catalog.name}", columns: [${parameter}.${e.columns[0].property}], foreignColumns: [${match[1]}] }).onDelete("${match[2]}")`,
    extraConfigStart: extra.body.getStart(d.parsed) + 1,
  };
  e.sources = [];
  for (const file of migrationFiles) {
    const lines = read(file).split("\n");
    const pattern = e.catalog.name === "data_migration_checkpoint_run_id_fkey"
      ? /"run_id" VARCHAR\(64\) NOT NULL REFERENCES "data_migration_run" \("run_id"\) ON DELETE CASCADE/
      : new RegExp(`\\bCONSTRAINT\\s+"?${e.catalog.name}"?\\s+FOREIGN KEY\\b`);
    for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) {
      const count = e.catalog.name === "data_migration_checkpoint_run_id_fkey" ? 1 : 2;
      const sql = lines.slice(i, i + count).join("\n");
      assert.ok(sql.includes("REFERENCES") && sql.includes("ON DELETE"), e.key + " complete source");
      e.sources.push({ file, line: i + 1, lineCount: count, sql });
    }
  }
  assert.ok(e.sources.some(s => s.file.startsWith("migrations/")), e.key + " external source");
  assert.ok(e.sources.some(s => s.file.startsWith("src/")), e.key + " embedded source");
}
console.log(JSON.stringify({ baselineCommit: baseline.commit, sourceCommit: verified.sourceCommit, sourceRunId: verified.runId,
  entries, modelFiles: [...new Set(entries.map(e => e.model.file))].map(file => ({ file, source: read(file) })) }));
