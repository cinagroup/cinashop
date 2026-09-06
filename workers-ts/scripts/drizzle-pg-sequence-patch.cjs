// DB-009E5: reversible PostgreSQL sequence metadata extension for pinned bundles.
// These functions are source templates inserted only into PgSquasher.
function sequenceLimits(type) {
  const limits = { smallint: ["-32768", "32767"], integer: ["-2147483648", "2147483647"],
    bigint: ["-9223372036854775808", "9223372036854775807"] };
  if (!Object.hasOwn(limits, type)) throw new Error("DB-009E5: unsupported sequence type");
  return limits[type];
}
function sequenceIdentifier(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || new TextEncoder().encode(value).length > 63)
    throw new Error("DB-009E5: invalid sequence identifier");
  return '"' + value.replace(/"/g, '""') + '"';
}
function validateSequenceState(sequence) {
  const seq = SEQUENCE_SCHEMA.parse(sequence);
  if (!seq.cinashopSequence) throw new Error("DB-009E5: missing sequence state");
  const state = seq.cinashopSequence;
  const [typeMin, typeMax] = PgSquasher.sequenceLimits(state.dataType).map(BigInt);
  for (const value of [seq.name, seq.schema]) PgSquasher.sequenceIdentifier(value);
  for (const field of ["increment", "minValue", "maxValue", "startWith", "cache"]) {
    if (typeof seq[field] !== "string" || !/^(?:0|-?[1-9][0-9]*)$/.test(seq[field]))
      throw new Error("DB-009E5: sequence numeric metadata must be canonical integers");
  }
  const min = BigInt(seq.minValue), max = BigInt(seq.maxValue), start = BigInt(seq.startWith);
  const increment = BigInt(seq.increment), cache = BigInt(seq.cache);
  if (min < typeMin || max > typeMax || min >= max || start < min || start > max
    || increment === 0n || increment < typeMin || increment > typeMax || cache < 1n
    || cache > 9223372036854775807n || typeof seq.cycle !== "boolean")
    throw new Error("DB-009E5: sequence bounds/state are invalid for the declared type");
  if (state.ownedBy !== null) {
    const owner = state.ownedBy;
    for (const value of [owner.schema, owner.table, owner.column]) PgSquasher.sequenceIdentifier(value);
    if (owner.schema !== seq.schema) throw new Error("DB-009E5: sequence ownership cannot cross schemas");
  }
  return seq;
}
function sequenceSnapshotContract(previous, current) {
  for (const snapshot of [previous, current]) for (const [key, sequence] of Object.entries(snapshot.sequences)) {
    if (sequence.cinashopSequence === void 0) continue;
    const seq = PgSquasher.validateSequenceState(sequence);
    if (key !== seq.schema + "." + seq.name) throw new Error("DB-009E5: sequence snapshot key mismatch");
    const owner = seq.cinashopSequence.ownedBy;
    if (owner && !snapshot.tables[owner.schema + "." + owner.table]?.columns[owner.column])
      throw new Error("DB-009E5: owning column is absent from the snapshot");
  }
  for (const [key, sequence] of Object.entries(previous.sequences)) {
    if (sequence.cinashopSequence && !current.sequences[key]?.cinashopSequence)
      throw new Error("DB-009E5: removing sequence metadata or dropping/moving/renaming a marked sequence requires a reviewed migration");
  }
}
function sequenceSql(statement, operation) {
  const seq = PgSquasher.validateSequenceState({ ...statement.values, name: statement.name, schema: statement.schema || "public" });
  const quote = PgSquasher.sequenceIdentifier;
  const name = quote(seq.schema) + "." + quote(seq.name);
  if (statement.ownershipOnly) {
    const owner = seq.cinashopSequence.ownedBy;
    return "ALTER SEQUENCE " + name + " OWNED BY " +
      (owner ? quote(owner.schema) + "." + quote(owner.table) + "." + quote(owner.column) : "NONE") + ";";
  }
  return operation + " SEQUENCE " + name + " AS " + seq.cinashopSequence.dataType +
    " INCREMENT BY " + seq.increment + " MINVALUE " + seq.minValue + " MAXVALUE " + seq.maxValue +
    " START WITH " + seq.startWith + " CACHE " + seq.cache + (seq.cycle ? " CYCLE;" : " NO CYCLE;");
}
function edits(filename) {
  const schema = filename === "bin.cjs" ? "sequenceSchema" : "sequenceSchema2";
  const introspector = filename === "bin.cjs" ? "fromDatabase2" : "fromDatabase";
  const rules = [];
  const add = (start, end, before, after) => rules.push({ start, end, before, after });
  const squash = (before, after) => add("PgSquasher = {", "squashPgScheme =", before, after);
  add(schema + " = objectType({", "}).strict();", "schema: stringType()", [
    "schema: stringType(),",
    "      cinashopSequence: objectType({",
    '        dataType: enumType(["smallint", "integer", "bigint"]),',
    "        ownedBy: objectType({ schema: stringType(), table: stringType(), column: stringType() }).strict().nullable()",
    "      }).strict().optional()",
  ].join("\n"));
  const functions = { sequenceLimits, sequenceIdentifier, validateSequenceState, sequenceSnapshotContract, sequenceSql };
  const sequenceStart = "      squashSequence: (seq) => {";
  squash(sequenceStart, Object.entries(functions).map(([name, fn]) =>
    "      " + name + ": " + fn.toString().replace("SEQUENCE_SCHEMA", schema) + ",").join("\n") + "\n" + sequenceStart);
  const marker = "\\u0000cinashop-pg-sequence-v1:";
  squash("      squashSequence: (seq) => {", "      squashSequence: (seq) => {\n" +
    '        if (seq.cinashopSequence !== void 0) return "' + marker + '" + JSON.stringify(PgSquasher.validateSequenceState(seq));');
  squash("      unsquashSequence: (seq) => {", "      unsquashSequence: (seq) => {\n" +
    '        if (seq.startsWith("' + marker + '")) return PgSquasher.validateSequenceState(JSON.parse(seq.slice("' + marker + '".length)));');
  add("generatePgSnapshot =", introspector + " =", "      for (const sequence of sequences) {",
    "      for (const sequence of sequences) {\n        const cinashopSequence = sequence.cinashopSequence;\n" +
    '        if (cinashopSequence) for (const key of ["increment", "minValue", "maxValue", "startWith", "cache"]) {\n' +
    '          const value = sequence.seqOptions?.[key];\n' +
    '          if (typeof value === "number" && !Number.isSafeInteger(value))\n' +
    '            throw new Error("DB-009E5: unsafe sequence numeric input; use an exact integer string");\n' +
    '        }\n' +
    '        const sequenceBounds = PgSquasher.sequenceLimits(cinashopSequence?.dataType ?? "bigint");');
  for (const [field, local, original, target] of [
    ["minValue", "_e", '(parseFloat(increment) < 0 ? "-9223372036854775808" : "1")', '(parseFloat(increment) < 0 ? sequenceBounds[0] : "1")'],
    ["maxValue", "_f", '(parseFloat(increment) < 0 ? "-1" : "9223372036854775807")', '(parseFloat(increment) < 0 ? "-1" : sequenceBounds[1])'],
  ]) {
    const access = filename === "bin.cjs" ? "(" + local + " = sequence == null ? void 0 : sequence.seqOptions) == null ? void 0 : " + local + "." + field
      : "sequence?.seqOptions?." + field;
    const prefix = "const " + field + " = stringFromIdentityProperty(" + access + ") ?? ";
    add("generatePgSnapshot =", introspector + " =", prefix + original, prefix + target);
  }
  const cycle = filename === "bin.cjs" ? "cycle: ((_i = sequence.seqOptions) == null ? void 0 : _i.cycle) ?? false" : "cycle: sequence.seqOptions?.cycle ?? false";
  add("generatePgSnapshot =", introspector + " =", cycle,
    cycle + ",\n            ...(cinashopSequence === void 0 ? {} : { cinashopSequence })");
  for (const [start, end, operation, anchor] of [
    ["CreatePgSequenceConvertor = class", "DropPgSequenceConvertor = class", "CREATE", "        const { name, values, schema: schema6 } = st;"],
    ["AlterPgSequenceConvertor = class", "CreateTypeEnumConvertor = class", "ALTER", "        const { name, schema: schema6, values } = st;"],
  ]) add(start, end, anchor, anchor + '\n        if (values.cinashopSequence) return PgSquasher.sequenceSql(st, "' + operation + '");');
  const diffStart = "applyPgSnapshotsDiff = async", diffEnd = "applyMysqlSnapshotsDiff = async";
  add(diffStart, diffEnd, "      const schemasDiff = diffSchemasOrTables(json1.schemas, json2.schemas);",
    "      PgSquasher.sequenceSnapshotContract(prevFull, curFull);\n      const schemasDiff = diffSchemasOrTables(json1.schemas, json2.schemas);");
  add(diffStart, diffEnd, "      jsonStatements.push(...createViews);", [
    "      jsonStatements.push(...createViews);",
    "      // Ownership needs the final table/column names, after table changes.",
    "      jsonStatements.push(...[...createSequences, ...jsonAlterSequences]",
    "        .filter(st => st.values.cinashopSequence)",
    '        .map(st => ({ ...st, type: "alter_sequence", ownershipOnly: true })));',
  ].join("\n"));
  // Preserve standard SERIAL/IDENTITY and ordinary unowned bigint introspection.
  // Refuse custom physical metadata before upstream collapses it into SERIAL.
  // Insert before (not within) the previously frozen NOT VALID guard.
  const anchor = "      for (const row of allTables) {";
  add(introspector + " = async", "const tableResponse = await getColumnsInfoQuery", anchor, [
    "      if (allSequences.length) {",
    "        const sequenceStates = await db.query(",
    "          " + String.fromCharCode(96) + "SELECT ns.nspname AS schema, seq.relname AS name, s.seqtypid::regtype::text AS type,",
    "           s.seqstart::text AS start, s.seqmin::text AS min, s.seqmax::text AS max,",
    "           s.seqincrement::text AS increment, s.seqcache::text AS cache, s.seqcycle AS cycle,",
    "           d.deptype, tbl.relname AS owner_table, a.attname AS owner_column, a.atttypid::regtype::text AS column_type",
    "           FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class seq ON seq.oid=s.seqrelid",
    "           JOIN pg_catalog.pg_namespace ns ON ns.oid=seq.relnamespace",
    "           LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass",
    "             AND d.objid=seq.oid AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')",
    "           LEFT JOIN pg_catalog.pg_class tbl ON tbl.oid=d.refobjid",
    "           LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid",
    "           WHERE ns.nspname IN (\${schemaFilters.map(s => \"'\" + s.replace(/'/g, \"''\") + \"'\").join(',') || \"NULL\"})" + String.fromCharCode(96),
    "        );",
    "        for (const seq of sequenceStates) {",
    '          if (seq.deptype === "i" || (seq.owner_table && !tablesFilter(seq.owner_table))) continue;',
    '          const ordinarySerial = seq.deptype === "a" && seq.name === seq.owner_table + "_" + seq.owner_column + "_seq"',
    '            && seq.type === seq.column_type && seq.start === "1" && seq.min === "1"',
    '            && seq.max === PgSquasher.sequenceLimits(seq.type)[1] && seq.increment === "1" && seq.cache === "1" && seq.cycle === false;',
    '          if (ordinarySerial || (!seq.deptype && seq.type === "bigint")) continue;',
    '          const message = "DB-009E5: custom sequence introspection is unsupported; use reviewed generate/migrate, not push/pull";',
    "          console.error(message); throw new Error(message);",
    "        }",
    "      }",
    anchor,
  ].join("\n"));
  return rules;
}
module.exports = { edits };
