import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSchemaAudit,
  comparePostgresDefinitions,
  formatSchemaAuditMarkdown,
} from "./data-migration/schema-audit.js";
import {
  addTableCounts,
  buildTransferPlans,
  copyEligibleTables,
  inspectDatabases,
  openSource,
  openTarget,
  quoteMysqlIdentifier,
  sourceFingerprint,
  validateApplyTarget,
  validateBatchSize,
  verifyEligibleTables,
  type TableTransferPlan,
} from "./data-migration/runner.js";

type Command = "schema-audit" | "plan" | "copy" | "verify";

interface CliOptions {
  command: Command;
  apply: boolean;
  json: boolean;
  batchSize: number;
  tables?: Set<string>;
}

function parseArgs(argv: string[]): CliOptions {
  const forbidden = argv.find((arg) => /(?:url|password|token|secret)/i.test(arg));
  if (forbidden) {
    throw new Error("Connection URLs and secrets must be supplied through environment variables, not CLI arguments");
  }
  const positionals = argv.filter((arg) => !arg.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error(`Unexpected positional arguments: ${positionals.slice(1).join(", ")}`);
  }
  const rawCommand = positionals[0] ?? "schema-audit";
  if (!new Set(["schema-audit", "plan", "copy", "verify"]).has(rawCommand)) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }
  const unknownFlag = argv.find(
    (arg) =>
      arg.startsWith("--") &&
      !["--apply", "--json"].includes(arg) &&
      !arg.startsWith("--batch-size=") &&
      !arg.startsWith("--tables="),
  );
  if (unknownFlag) throw new Error(`Unknown option: ${unknownFlag}`);
  const batchArg = argv.find((arg) => arg.startsWith("--batch-size="));
  const tableArg = argv.find((arg) => arg.startsWith("--tables="));
  const tables = tableArg
    ? new Set(
        tableArg
          .slice("--tables=".length)
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      )
    : undefined;
  if (tables) {
    for (const table of tables) quoteMysqlIdentifier(table);
  }
  const options: CliOptions = {
    command: rawCommand as Command,
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
    batchSize: validateBatchSize(batchArg ? Number(batchArg.slice("--batch-size=".length)) : 250),
    tables,
  };
  if (options.command !== "copy" && options.apply) {
    throw new Error("--apply is only valid with copy");
  }
  if (options.command === "schema-audit" && options.tables) {
    throw new Error("--tables is only valid with plan, copy or verify");
  }
  if (!new Set<Command>(["copy", "verify"]).has(options.command) && batchArg) {
    throw new Error("--batch-size is only valid with copy or verify");
  }
  return options;
}

async function readSchemaFiles(): Promise<{
  sourceSql: string;
  externalTargetSql: string;
  embeddedTargetSql: string;
}> {
  const sourcePath =
    process.env.SOURCE_SCHEMA_SQL ??
    resolve(import.meta.dirname, "../../../cinashop-php/public/install/crmeb.sql");
  const migrationsDirectory =
    process.env.TARGET_MIGRATIONS_DIR ?? resolve(import.meta.dirname, "../migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/i.test(name))
    .sort();
  const externalTargetSql = (
    await Promise.all(
      migrationFiles.map((name) => readFile(resolve(migrationsDirectory, name), "utf8")),
    )
  ).join("\n");
  const embeddedSourcePath =
    process.env.TARGET_EMBEDDED_MIGRATION_SOURCE ??
    resolve(import.meta.dirname, "../src/services/MigrationService.ts");
  const embeddedTargetSql = await readFile(embeddedSourcePath, "utf8");
  return {
    sourceSql: await readFile(sourcePath, "utf8"),
    externalTargetSql,
    embeddedTargetSql,
  };
}

function selectedPlans(plans: TableTransferPlan[], tables?: Set<string>): TableTransferPlan[] {
  if (!tables) return plans;
  const known = new Set(plans.map((plan) => plan.spec.table));
  const unknown = [...tables].filter((table) => !known.has(table));
  if (unknown.length) throw new Error(`Unknown migration tables: ${unknown.join(", ")}`);
  return plans.filter((plan) => tables.has(plan.spec.table));
}

function printPlan(plans: TableTransferPlan[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(plans, null, 2)}\n`);
    return;
  }
  const eligible = plans.filter((plan) => plan.eligible).length;
  console.log(`Migration plan: ${eligible}/${plans.length} table(s) eligible`);
  for (const plan of plans) {
    const counts =
      plan.sourceCount === undefined
        ? ""
        : ` source=${plan.sourceCount} target=${plan.targetCount ?? 0}`;
    console.log(`${plan.eligible ? "READY" : "BLOCKED"} ${plan.spec.table}${counts}`);
    for (const [targetColumn, sourceColumn] of Object.entries(plan.sourceColumnByTarget)) {
      if (targetColumn !== sourceColumn) {
        console.log(`  - map ${sourceColumn} -> ${targetColumn}`);
      }
    }
    for (const blocker of plan.blockers) console.log(`  - ${blocker}`);
    for (const conversion of plan.conversions) {
      console.log(`  - convert ${conversion.column}: ${conversion.kind}`);
    }
    for (const check of plan.integerRangeChecks) {
      console.log(
        `  - target integer range for ${check.column}: ${check.minimum}..${check.maximum}`,
      );
    }
    for (const column of plan.sourceNullabilityChecks) {
      console.log(`  - source NULL check for required target column: ${column}`);
    }
    for (const check of plan.sourceSentinelChecks) {
      console.log(`  - source sentinel check for required target column: ${check.column} (${check.kind})`);
    }
    if (plan.sourceKeyRequiresUniquenessCheck) {
      console.log(
        `  - live source uniqueness ${plan.sourceKeyUniquenessVerified ? "verified" : "not verified"}: ${plan.spec.key.join(", ")}`,
      );
      if ((plan.sourceDuplicateKeyGroups ?? 0) > 0) {
        console.log(
          `  - duplicate key report: groups=${plan.sourceDuplicateKeyGroups} excess_rows=${plan.sourceDuplicateExcessRows ?? 0}`,
        );
      }
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function runDatabaseCommand(options: CliOptions): Promise<void> {
  const sourceUrl = requiredEnvironment("SOURCE_MYSQL_URL");
  const targetUrl = requiredEnvironment("TARGET_POSTGRES_URL");
  const prefix = process.env.SOURCE_MYSQL_PREFIX ?? "eb_";
  quoteMysqlIdentifier(prefix);
  const runId = options.command === "copy"
    ? process.env.MIGRATION_RUN_ID ?? randomUUID()
    : options.command === "verify"
      ? requiredEnvironment("MIGRATION_RUN_ID")
      : undefined;
  if (runId && !/^[A-Za-z0-9._:-]{8,64}$/.test(runId)) {
    throw new Error("MIGRATION_RUN_ID must be 8-64 safe identifier characters");
  }
  if (options.command === "copy") {
    // Validate every write gate before opening either database connection.
    validateApplyTarget(
      targetUrl,
      process.env.MIGRATION_CONFIRM_TARGET,
      process.env.MIGRATION_ALLOW_REMOTE_TARGET === "1",
    );
  }
  const source = await openSource(sourceUrl);
  const target = openTarget(targetUrl);
  let sourceSnapshot = false;
  let targetSnapshot = false;
  try {
    if (options.command === "copy" || options.command === "verify") {
      await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      sourceSnapshot = true;
    }
    if (options.command === "verify") {
      await target`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      targetSnapshot = true;
    }
    const inventory = await inspectDatabases(source, target);
    const allPlans = buildTransferPlans(inventory, prefix);
    const plans = selectedPlans(allPlans, options.tables);
    await addTableCounts(source, target, plans);

    if (options.command === "plan") {
      printPlan(plans, options.json);
      return;
    }

    const blocked = plans.filter((plan) => !plan.eligible);
    if (blocked.length) {
      printPlan(blocked, false);
      throw new Error("Selected tables include blocked migration plans");
    }
    if (options.command === "verify") {
      const report = await verifyEligibleTables(
        source,
        target,
        plans,
        { batchSize: options.batchSize, issueLimit: 20, runId: runId! },
        sourceFingerprint(sourceUrl, prefix),
        prefix,
      );
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        console.log(`Verification run: ${report.runId} (${report.runStatus})`);
        for (const result of report.tables) {
          console.log(
            `${result.status.toUpperCase()} ${result.table}: source=${result.sourceCount} target=${result.targetCount}` +
            ` checked=${result.checkedCount} missing=${result.missingTargetCount}` +
            ` mismatched=${result.mismatchedRowCount} extra=${result.extraTargetCount}` +
            ` checkpoint=${result.checkpointStatus}/${result.checkpointConflictCount}`,
          );
          for (const issue of result.issues) {
            console.log(
              `  - ${issue.kind} key=${issue.key}` +
              (issue.columns.length ? ` columns=${issue.columns.join(",")}` : ""),
            );
          }
        }
      }
      if (!report.passed) throw new Error("Migration verification failed");
    } else {
      console.log(`Migration run: ${runId}`);
      const results = await copyEligibleTables(
        source,
        target,
        plans,
        {
          batchSize: options.batchSize,
          runId: runId!,
          sourcePrefix: prefix,
          selectedTables: options.tables,
        },
        sourceFingerprint(sourceUrl, prefix),
      );
      if (options.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      else {
        for (const result of results) {
          console.log(
            `${result.status.toUpperCase()} ${result.table}: source=${result.sourceCount} inserted=${result.insertedCount} conflicts=${result.conflictCount}`,
          );
        }
      }
    }
    if (targetSnapshot) {
      await target`COMMIT`;
      targetSnapshot = false;
    }
    if (sourceSnapshot) {
      await source.commit();
      sourceSnapshot = false;
    }
  } catch (error) {
    if (targetSnapshot) await target`ROLLBACK`.catch(() => undefined);
    if (sourceSnapshot) await source.rollback().catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end({ timeout: 5 });
  }
}

function redact(message: string): string {
  let output = message;
  for (const name of ["SOURCE_MYSQL_URL", "TARGET_POSTGRES_URL"]) {
    const value = process.env[name];
    if (value) output = output.split(value).join(`[${name}]`);
    try {
      const password = value ? new URL(value).password : "";
      if (password) output = output.split(password).join("[redacted]");
    } catch {
      // Invalid URLs are reported by the URL parser without echoing credentials here.
    }
  }
  return output;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.command === "copy") {
    if (!options.apply) {
      throw new Error("copy is write-capable and requires the explicit --apply flag");
    }
    if (!options.tables?.size) {
      throw new Error("copy requires an explicit --tables=table_a,table_b allowlist");
    }
  }
  if (options.command === "verify" && !options.tables?.size) {
    throw new Error("verify requires an explicit --tables=table_a,table_b allowlist");
  }
  if (options.command === "schema-audit") {
    const { sourceSql, externalTargetSql, embeddedTargetSql } = await readSchemaFiles();
    const report = buildSchemaAudit(
      sourceSql,
      externalTargetSql,
      process.env.SOURCE_MYSQL_PREFIX ?? "eb_",
    );
    const definitionDrift = comparePostgresDefinitions(externalTargetSql, embeddedTargetSql);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ coverage: report, definitionDrift }, null, 2)}\n`);
    } else {
      process.stdout.write(formatSchemaAuditMarkdown(report));
      process.stdout.write("\n## Repository migration definition drift\n\n");
      process.stdout.write(`- External migration tables: ${definitionDrift.externalTableCount}\n`);
      process.stdout.write(`- Worker migration tables: ${definitionDrift.workerTableCount}\n`);
      process.stdout.write(
        `- Tables defined only by the external path: ${definitionDrift.externalOnlyTables.map((table) => `\`${table}\``).join(", ")}\n`,
      );
      process.stdout.write(
        `- Tables defined only by the Worker path: ${definitionDrift.workerOnlyTables.map((table) => `\`${table}\``).join(", ")}\n`,
      );
      process.stdout.write(`- Tables with column/primary-key drift: ${definitionDrift.columnDrift.length}\n`);
      for (const table of definitionDrift.columnDrift) {
        process.stdout.write(
          `  - ${table.table}: external-only [${table.externalOnlyColumns.join(", ")}], Worker-only [${table.workerOnlyColumns.join(", ")}]` +
          `, definition drift [${table.definitionDrift.map((column) => column.column).join(", ")}]` +
          `, PK external [${table.externalPrimaryKey.join(", ")}], Worker [${table.workerPrimaryKey.join(", ")}]\n`,
        );
      }
    }
    if (
      definitionDrift.externalOnlyTables.length ||
      definitionDrift.workerOnlyTables.length ||
      definitionDrift.columnDrift.length
    ) {
      throw new Error("External and Worker migration definitions are not equivalent");
    }
    return;
  }
  await runDatabaseCommand(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration failed: ${redact(message)}`);
    process.exitCode = 1;
  });
}
