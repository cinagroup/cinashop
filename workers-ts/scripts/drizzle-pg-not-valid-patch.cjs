// DB-009E2A: reversible, PostgreSQL-only edits to the checksum-pinned bundles.
// This is not an upstream-version compatibility shim. The caller verifies the
// complete original bundle and the complete reconstructed patched bundle.
function edits(filename) {
  const n = filename === "bin.cjs" ? 2 : 3;
  const check = filename === "bin.cjs" ? "check2" : "check";
  const introspector = filename === "bin.cjs" ? "fromDatabase2" : "fromDatabase";
  const rules = [];
  const add = (start, end, before, after) => rules.push({ start, end, before, after });
  const squash = (before, after) => add("PgSquasher = {", "squashPgScheme =", before, after);
  add(`fk${n} = objectType({`, "}).strict();", "onDelete: stringType().optional()",
    "onDelete: stringType().optional(),\n      notValid: literalType(true).optional()");
  add(`checkConstraint${n} = objectType({`, "}).strict();", "value: stringType()",
    "value: stringType(),\n      notValid: literalType(true).optional()");
  squash("PgSquasher = {", `PgSquasher = {
      notValidMetadata: (value) => {
        if (value === void 0) return {};
        if (value !== true) throw new Error("DB-009E2A: notValid must be true or absent");
        return { notValid: true };
      },`);
  // NUL cannot occur in a PostgreSQL identifier. Only marked constraints use
  // this versioned JSON transport; ordinary upstream squashing is unchanged.
  // JSON preserves semicolons inside CHECK expressions and quoted identifiers.
  for (const [kind, variable, validator] of [["FK", "fk5", `fk${n}`], ["Check", check, `checkConstraint${n}`]]) {
    const marker = "\\u0000cinashop-pg-not-valid-v1:";
    const start = `squash${kind}: (${variable}) => {`;
    const value = kind === "FK" ? `{ ...${variable}, schemaTo: ${variable}.schemaTo || "public" }` : variable;
    squash(start, `${start}
        if (${variable}.notValid === true) return "${marker}" + JSON.stringify(${validator}.parse(${value}));`);
    const decode = `unsquash${kind}: (input) => {`;
    squash(decode, `${decode}
        if (input.startsWith("${marker}")) {
          const value = ${validator}.parse(JSON.parse(input.slice("${marker}".length)));
          if (value.notValid !== true) throw new Error("DB-009E2A: invalid NOT VALID transport");
          return value;
        }`);
  }
  // The schemaTo field distinguishes this PostgreSQL return from other dialects.
  add("generatePgSnapshot =", `${introspector} =`, `            schemaTo,
            columnsFrom,
            columnsTo,
            onDelete,
            onUpdate
          };`, `            schemaTo,
            columnsFrom,
            columnsTo,
            onDelete,
            onUpdate,
            ...PgSquasher.notValidMetadata(fk5.notValid)
          };`);
  add("generatePgSnapshot =", `${introspector} =`, `value: dialect6.sqlToQuery(${check}.value).sql`,
    `value: dialect6.sqlToQuery(${check}.value).sql,\n            ...PgSquasher.notValidMetadata(${check}.notValid)`);
  const tableStart = "PgCreateTableConvertor = class";
  const tableEnd = "MySqlCreateTableConvertor = class";
  add(tableStart, tableEnd, '        if (typeof checkConstraints !== "undefined" && checkConstraints.length > 0) {',
    '        const notValidChecks = [];\n        if (typeof checkConstraints !== "undefined" && checkConstraints.length > 0) {');
  add(tableStart, tableEnd, `            statement += ",\\n";
            const unsquashedCheck = PgSquasher.unsquashCheck(checkConstraint5);`,
    `            const unsquashedCheck = PgSquasher.unsquashCheck(checkConstraint5);
            if (unsquashedCheck.notValid) {
              notValidChecks.push(new PgAlterTableAddCheckConstraintConvertor().convert({
                type: "create_check_constraint", tableName, schema: schema6, data: checkConstraint5
              }));
              continue;
            }
            statement += ",\\n";`);
  add(tableStart, tableEnd, "return [statement, ...policies", "return [statement, ...notValidChecks, ...policies");
  add("PgAlterTableAddCheckConstraintConvertor = class", "PgAlterTableDeleteCheckConstraintConvertor = class",
    'CHECK (${unsquashed.value});', 'CHECK (${unsquashed.value})${unsquashed.notValid ? " NOT VALID" : ""};');
  add("PgCreateForeignKeyConvertor = class", "LibSQLCreateForeignKeyConvertor = class",
    "          schemaTo\n        } = PgSquasher.unsquashFK", "          schemaTo,\n          notValid\n        } = PgSquasher.unsquashFK");
  add("PgCreateForeignKeyConvertor = class", "LibSQLCreateForeignKeyConvertor = class",
    "${onDeleteStatement}${onUpdateStatement};", '${onDeleteStatement}${onUpdateStatement}${notValid ? " NOT VALID" : ""};');
  // This legacy converter has unrelated cross-schema reference defects. Do not
  // let it silently emit a validated replacement for an explicitly marked FK.
  // The tested snapshot differ uses separate delete_reference/create_reference.
  add("PgAlterForeignKeyConvertor = class", "PgDeleteForeignKeyConvertor = class",
    "        const oldFk = PgSquasher.unsquashFK(statement.oldFkey);",
    `        const oldFk = PgSquasher.unsquashFK(statement.oldFkey);
        if (oldFk.notValid || newFk.notValid) throw new Error("DB-009E2A: NOT VALID alter_reference requires a reviewed migration");`);
  // Pull's TypeScript printer cannot express the extension. Fail closed in the
  // common introspector, including push, rather than lose validation metadata.
  // This query is read-only and schema/table-filtered; no DDL is proposed first.
  const tableMap = '      const all = allTables.filter((it) => it.type === "table").map((row) => {';
  add(`${introspector} = async`, "const tableResponse = await getColumnsInfoQuery", tableMap,
    `      for (const row of allTables) {
        if (row.type !== "table" || !tablesFilter(row.table_name)) continue;
        const unvalidated = await db.query(
              \`SELECT con.conname FROM pg_catalog.pg_constraint con
                JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
                JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
                WHERE ns.nspname = '\${row.table_schema.replace(/'/g, "''")}'
                  AND rel.relname = '\${row.table_name.replace(/'/g, "''")}'
                  AND con.contype IN ('c', 'f') AND NOT con.convalidated\`
        );
        if (unvalidated.length) {
          const message = "DB-009E2A: NOT VALID introspection is unsupported; use reviewed generate/migrate, not push/pull";
          console.error(message);
          throw new Error(message);
        }
      }
${tableMap}`);
  return rules;
}

function rewrite(source, rules, reverse = false) {
  for (const rule of reverse ? [...rules].reverse() : rules) {
    const begin = source.indexOf(rule.start);
    const end = source.indexOf(rule.end, begin + rule.start.length);
    if (begin < 0 || end < 0 || source.indexOf(rule.start, begin + rule.start.length) >= 0)
      throw new Error(`DB-009E2A: ambiguous patch scope ${rule.start}`);
    const from = reverse ? rule.after : rule.before;
    const to = reverse ? rule.before : rule.after;
    const scope = source.slice(begin, end);
    if (scope.split(from).length !== 2) throw new Error(`DB-009E2A: patch context drift in ${rule.start}`);
    source = source.slice(0, begin) + scope.replace(from, to) + source.slice(end);
  }
  return source;
}

module.exports = { edits, rewrite };
