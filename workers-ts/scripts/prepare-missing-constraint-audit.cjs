// Read-only DB-009E2B evidence preparation. Output is reviewed before use; this
// script never edits models, migration files, the manifest or a database.
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");
const { is } = require("drizzle-orm");
const { PgTable, getTableConfig } = require("drizzle-orm/pg-core");
const models = require("tsx/cjs/api").require("../src/models/schema/index.ts", __filename);
const root = join(__dirname, "..");
const read = file => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
function constraintClause(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i + 1] === quote) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "-" && source[i + 1] === "-") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "(") depth++;
    if (c === ")" && --depth < 0 || depth === 0 && (c === "," || c === ";")) return source.slice(start, i).trimEnd();
  }
  throw new Error("Unterminated source constraint");
}
const baseline = JSON.parse(read("audit/orm-ddl-catalog-baseline.json"));
const aliases = new Set(baseline.records.filter(r => r.comparison === "externalVsOrm" && r.category === "constraints" && r.change === "possibleRenames").map(r => r.value.reference));
const entries = baseline.records.filter(r => r.comparison === "externalVsOrm" && r.category === "constraints" && r.change === "referenceOnly" && !aliases.has(r.value.key))
  .map(r => ({ key: r.value.key, catalog: r.value }));
if (entries.length !== 41) throw new Error("Expected the exact 41 non-alias constraints");
const declarations = new Map();
for (const name of readdirSync(join(root, "src/models/schema")).filter(n => n.endsWith(".ts"))) {
  const file = "src/models/schema/" + name;
  const source = read(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(parsed) === "pgTable"
      && ts.isStringLiteral(node.initializer.arguments[0])) {
      const call = node.initializer;
      declarations.set(call.arguments[0].text, { file, exportName: node.name.getText(parsed),
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        extraConfig: call.arguments[2]?.getText(parsed) ?? null,
        parameters: call.arguments[2] && ts.isArrowFunction(call.arguments[2]) ? call.arguments[2].parameters.map(p => p.name.getText(parsed)) : [],
        start: call.getStart(parsed), end: call.getEnd(), body: call.getText(parsed) });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
for (const entry of entries) {
  const model = declarations.get(entry.catalog.table);
  if (!model || !is(models[model.exportName], PgTable)) throw new Error(`Missing model ${entry.key}`);
  const table = models[model.exportName];
  const fields = Object.entries(table).filter(([, c]) => c && typeof c.getSQLType === "function" && typeof c.name === "string")
    .map(([property, c]) => ({ property, name: c.name, type: c.getSQLType(), notNull: c.notNull }));
  entry.model = { file: model.file, exportName: model.exportName, parameters: model.parameters, line: model.line };
  const referencedText = entry.catalog.definition.split(" REFERENCES ")[0].replace(/'(?:[^']|'')*'/g, "");
  entry.fields = fields.filter(f => new RegExp(`\\b${f.name}\\b`).test(referencedText));
  entry.indexes = getTableConfig(table).indexes.map(i => ({ name: i.config.name, columns: i.config.columns.map(c => c.name), partial: !!i.config.where }));
  entry.sources = [];
  for (const file of [...readdirSync(join(root, "migrations")).filter(n => n.endsWith(".sql")).sort().map(n => "migrations/" + n),
    "src/services/MigrationService.ts", ...readdirSync(join(root, "src/migrations")).filter(n => n.endsWith(".ts")).sort().map(n => "src/migrations/" + n)]) {
    const source = read(file);
    const regex = new RegExp(`\\bCONSTRAINT\\s+"?${entry.catalog.name}"?\\s+(?:CHECK|FOREIGN KEY)\\s*\\(`, "g");
    for (const match of source.matchAll(regex)) {
      const line = source.slice(0, match.index).split("\n").length;
      entry.sources.push({ file, line, declarationStart: source.split("\n")[line - 1], sql: constraintClause(source, match.index) });
    }
  }
  if (!entry.sources.some(s => s.file.startsWith("migrations/")) || !entry.sources.some(s => s.file.startsWith("src/")))
    throw new Error(`Missing independent migration sources for ${entry.key}`);
}
console.log(JSON.stringify({ sourceCommit: baseline.commit, entries,
  modelDeclarations: [...new Set(entries.map(e => e.catalog.table))].map(name => ({ table: name, ...declarations.get(name) })) }));
