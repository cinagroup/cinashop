/** Offline test-service audit. Never consumes production DATABASE_URL/Hyperdrive. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Container } from "../src/lib/di";
import { catalogKinds, classifyMissingIndexes, compareCatalogs, readCatalog, summarizeCatalogDiff, type Catalog, type CatalogRow } from "./data-migration/postgres-catalog-audit";

const root = resolve(import.meta.dirname, "..");

export function validateTestTarget(raw: string | undefined): URL {
  if (!raw) throw new Error("Set TEST_FINANCE_POSTGRES_URL to the dedicated loopback PostgreSQL 16 test service; production is forbidden");
  let target: URL;
  try { target = new URL(raw); } catch { throw new Error("Invalid test-service URL (value redacted)"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname)
    || target.pathname !== "/cinashop_finance_test" || target.username !== "finance_test" || target.search || target.hash) {
    throw new Error("Catalog audit requires the dedicated loopback finance_test/cinashop_finance_test service; production is forbidden");
  }
  return target;
}

export async function auditOrmDdl(raw = process.env.TEST_FINANCE_POSTGRES_URL) {
  const target = validateTestTarget(raw);
  const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10, connection: { statement_timeout: 30_000, lock_timeout: 3_000 } };
  const control = postgres(target.href, options);
  const created: string[] = [];
  const catalogs: Record<string, Catalog> = {};
  const paths: Array<{ path: string; steps: number }> = [];
  try {
    const [identity] = await control`SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS version`;
    if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
      throw new Error("Unexpected catalog audit service identity/version; no databases created");
    }
    // Load Drizzle's CLI/toolchain only inside the validated audit operation,
    // never while importing the URL validator into a unit-test process.
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const { MigrationService } = await import("../src/services/MigrationService");
    const models = await import("../src/models/schema");
    const migrationNames = (await readdir(resolve(root, "migrations"))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const migrationSources = await Promise.all(migrationNames.map((name) => readFile(resolve(root, "migrations", name), "utf8")));
    const inputDigest = createHash("sha256");
    migrationNames.forEach((name, index) => inputDigest.update(name).update(migrationSources[index]));
    const snapshot = generateDrizzleJson(models);
    const generated = await generateMigration(generateDrizzleJson({}), snapshot);
    for (const path of ["external", "embedded", "orm"] as const) {
      const name = `orm_audit_${path}_${randomUUID().replaceAll("-", "")}`;
      if (!/^orm_audit_(external|embedded|orm)_[a-f0-9]{32}$/.test(name)) throw new Error("Invalid isolated database name");
      await control.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created.push(name);
      const isolated = new URL(target.href);
      isolated.pathname = `/${name}`;
      const client = postgres(isolated.href, options);
      try {
        const [actual] = await client`SELECT current_database() AS database, current_user AS role`;
        if (actual.database !== name || actual.role !== "finance_test") throw new Error("Isolated catalog database identity mismatch");
        let steps = 0;
        if (path === "external") {
          for (let index = 0; index < migrationNames.length; index++) {
            try { await client.begin(async (tx) => { await tx.unsafe("SET LOCAL search_path TO public, pg_temp"); await tx.unsafe(migrationSources[index]); }); }
            catch (error) { throw new Error(`External path failed at ${migrationNames[index]}: ${error instanceof Error ? error.message : "SQL failure"}`); }
            steps++;
          }
        } else if (path === "embedded") {
          const service = new MigrationService({ db: drizzle(client) } as unknown as Container);
          const result = await service.runAll();
          if (result.errors.length || result.executed.some((step) => step.includes("skipped"))) {
            throw new Error(`Embedded path incomplete: ${JSON.stringify(result)}`);
          }
          steps = result.executed.length;
        } else {
          await client.unsafe(generated.join("\n"));
          steps = generated.length;
        }
        catalogs[path] = await readCatalog(async (query) => Array.from(await client.unsafe(query)) as CatalogRow[]);
        paths.push({ path, steps });
      } finally { await client.end({ timeout: 5 }); }
    }
    const externalVsEmbedded = compareCatalogs(catalogs.external, catalogs.embedded);
    const externalVsOrm = compareCatalogs(catalogs.external, catalogs.orm);
    return {
      scope: "Fresh isolated PostgreSQL 16 catalogs: tables, columns (type/default/nullability/identity/generated/collation), constraints, indexes, sequences. Canonical expression differences are review candidates, not proof of behavioral inequivalence. Does not inspect production rows, privileges, functions, triggers, policies or views.",
      serverVersionNum: Number(identity.version),
      externalInputSha256: inputDigest.digest("hex"),
      generatedSqlSha256: createHash("sha256").update(generated.join("\n")).digest("hex"),
      paths,
      counts: Object.fromEntries(Object.entries(catalogs).map(([path, catalog]) => [path, Object.fromEntries(catalogKinds.map((kind) => [kind, catalog[kind].length]))])),
      summary: { externalVsEmbedded: summarizeCatalogDiff(externalVsEmbedded), externalVsOrm: summarizeCatalogDiff(externalVsOrm) },
      missingIndexEvidence: {
        externalVsEmbedded: classifyMissingIndexes(catalogs.external, catalogs.embedded),
        externalVsOrm: classifyMissingIndexes(catalogs.external, catalogs.orm),
      },
      externalVsEmbedded, externalVsOrm,
    };
  } finally {
    // Only exact names recorded after our successful CREATE DATABASE are eligible.
    // Never FORCE-disconnect other sessions, and never drop the control database.
    const cleanupErrors: Error[] = [];
    try {
      for (const name of created.reverse()) {
        try {
          if (!/^orm_audit_(external|embedded|orm)_[a-f0-9]{32}$/.test(name)) throw new Error("Unsafe cleanup target");
          await control.unsafe(`DROP DATABASE "${name}"`);
          const remains = await control`SELECT datname FROM pg_database WHERE datname=${name}`;
          if (remains.length) throw new Error("Isolated database cleanup was not confirmed");
        } catch (error) { cleanupErrors.push(new Error(`Cleanup failed for ${name}`, { cause: error })); }
      }
    } finally { await control.end({ timeout: 5 }); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Catalog audit cleanup incomplete");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  auditOrmDdl().then((report) => {
    // One independently parseable record per catalog difference, suitable for CI logs.
    const { externalVsEmbedded, externalVsOrm, ...metadata } = report;
    console.log(`ORM_DDL_AUDIT ${JSON.stringify({ kind: "summary", ...metadata, cleanupConfirmed: true, mode: "inventory; differences remain open until individually reviewed" })}`);
    for (const [comparison, diff] of Object.entries({ externalVsEmbedded, externalVsOrm })) {
      for (const category of catalogKinds) for (const [change, values] of Object.entries(diff[category])) {
        for (const value of values) console.log(`ORM_DDL_AUDIT ${JSON.stringify({ comparison, category, change, value })}`);
      }
    }
  }).catch((error) => { console.error(error instanceof Error ? error.message : "Catalog audit failed"); process.exitCode = 1; });
}
