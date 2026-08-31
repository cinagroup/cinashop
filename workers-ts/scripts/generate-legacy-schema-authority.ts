import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCreateTables } from "./data-migration/schema-audit.js";

const sourcePath = resolve(
  process.env.SOURCE_SCHEMA_SQL ??
    resolve(import.meta.dirname, "../../../cinashop-php/public/install/crmeb.sql"),
);
const outputPath = resolve(import.meta.dirname, "../audit/legacy-schema-authority.sql");
const source = readFileSync(sourcePath, "utf8");
const tables = parseCreateTables(source, "mysql");

if (tables.size === 0) throw new Error(`No MySQL tables parsed from ${sourcePath}`);

const quote = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`Unsafe legacy schema identifier: ${value}`);
  }
  return `\`${value}\``;
};

const statements = [...tables.values()]
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((table) => {
    const segments = [...table.columns.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((column) => `  ${quote(column)} TEXT`);
    if (table.primaryKey.length > 0) {
      segments.push(`  PRIMARY KEY (${table.primaryKey.map(quote).join(", ")})`);
    }
    return `CREATE TABLE ${quote(table.name)} (\n${segments.join(",\n")}\n);`;
  });
const digest = createHash("sha256").update(source).digest("hex");
const snapshot = [
  "-- Generated legacy schema authority: column and primary-key shape only.",
  `-- Source SHA-256: ${digest}`,
  `-- Source table count: ${tables.size}`,
  "-- Regenerate only from the reviewed cinashop-php public/install/crmeb.sql authority.",
  "",
  ...statements,
  "",
].join("\n");

writeFileSync(outputPath, snapshot, "utf8");
process.stdout.write(
  `${JSON.stringify({ outputPath, sourceSha256: digest, tableCount: tables.size })}\n`,
);
