/** Offline test-service audit. Never consumes production DATABASE_URL/Hyperdrive. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Container } from "../src/lib/di";
import { extendOrdinaryIndexContracts, assertRetiredIndexesAbsent } from "./data-migration/ordinary-index-contracts";
import { extendIndexNameContracts, assertOldIndexNamesAbsent } from "./data-migration/index-name-contracts";
import { extendConstraintNameContracts, assertConstraintNamesAligned } from "./data-migration/constraint-name-contracts";
import { extendExternalDuplicateContracts, assertAllIndexesAligned } from "./data-migration/external-duplicate-index-contracts";
import { assertColumnDefaultContracts, assertAllColumnsAligned } from "./data-migration/column-default-contracts";
import { assertMissingConstraintContracts } from "./data-migration/missing-constraint-contracts";
import { assertForeignKeyNamesAligned } from "./data-migration/foreign-key-name-contracts";
import { assertIndexContracts, catalogKinds, classifyMissingIndexes, compareCatalogs, readCatalog, summarizeCatalogDiff, type Catalog, type CatalogRow } from "./data-migration/postgres-catalog-audit";

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
  let upgradeVerification;
  let externalDuplicateIndexRetirement;
  let columnDefaultUpgradeVerification;
  let missingConstraintUpgradeVerification;
  let foreignKeyNameUpgradeVerification;
  const columnWriteVerification: Record<string, unknown> = {};
  try {
    const [identity] = await control`SELECT current_database() AS database, current_user AS role, current_setting('server_version_num') AS version`;
    if (identity.database !== "cinashop_finance_test" || identity.role !== "finance_test" || Math.floor(Number(identity.version) / 10_000) !== 16) {
      throw new Error("Unexpected catalog audit service identity/version; no databases created");
    }
    // Load Drizzle's CLI/toolchain only inside the validated audit operation,
    // never while importing the URL validator into a unit-test process.
    const api = await import("drizzle-kit/api");
    const { generateDrizzleJson, generateMigration } = api;
    const { MigrationService } = await import("../src/services/MigrationService");
    const models = await import("../src/models/schema");
    const migrationNames = (await readdir(resolve(root, "migrations"))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const migrationSources = await Promise.all(migrationNames.map((name) => readFile(resolve(root, "migrations", name), "utf8")));
    const inputDigest = createHash("sha256");
    migrationNames.forEach((name, index) => inputDigest.update(name).update(migrationSources[index]));
    const snapshot = generateDrizzleJson(models);
    const generated = await generateMigration(generateDrizzleJson({}), snapshot);
    const auditDefaults = createRequire(import.meta.url)("../test/helpers/columnDefaultAudit.cjs");
    for (const path of ["external", "embedded", "orm", "orm_upgrade", "orm_default_upgrade", "orm_constraints", "orm_fk_names"] as const) {
      const name = `orm_audit_${path}_${randomUUID().replaceAll("-", "")}`;
      if (!/^orm_audit_(external|embedded|orm|orm_upgrade|orm_default_upgrade|orm_constraints|orm_fk_names)_[a-f0-9]{32}$/.test(name) || name.length > 63) throw new Error("Invalid isolated database name");
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
            if (migrationNames[index] === "0140_external_duplicate_index_retirement.sql") {
              // Before the final removal, probe the actual full external-history catalog.
              // The helper commits exactly this migration after all rollback fixtures pass.
              const auditDuplicates = createRequire(import.meta.url)("../test/helpers/externalDuplicateIndexAudit.cjs");
              externalDuplicateIndexRetirement = await auditDuplicates({ format: "pg16", db: {
                exec: (query: string) => client.unsafe(query),
                query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
              }, read: () => readCatalog(async (query) => Array.from(await client.unsafe(query)) as CatalogRow[]) });
              steps++;
              continue;
            }
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
        } else if (path === "orm_fk_names") {
          const auditForeignKeys = createRequire(import.meta.url)("../test/helpers/foreignKeyNameAudit.cjs");
          foreignKeyNameUpgradeVerification = await auditForeignKeys({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = foreignKeyNameUpgradeVerification.initialStatements + foreignKeyNameUpgradeVerification.guardedStatements;
        } else if (path === "orm_constraints") {
          const auditConstraints = createRequire(import.meta.url)("../test/helpers/missingConstraintAudit.cjs");
          missingConstraintUpgradeVerification = await auditConstraints({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = missingConstraintUpgradeVerification.initialStatements + missingConstraintUpgradeVerification.guardedStatements;
        } else if (path === "orm_default_upgrade") {
          // Separate full-schema old-default path; don't extend the bounded six-stage index probe.
          columnDefaultUpgradeVerification = await auditDefaults({ api, models, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = columnDefaultUpgradeVerification.initialStatements + columnDefaultUpgradeVerification.guardedStatements;
        } else if (path === "orm_upgrade") {
          // Same actual generator/rollback/row/OID/FK assertions as the local API probes,
          // but backed by this fresh, identity-checked PostgreSQL 16 database.
          const auditUpgrade = createRequire(import.meta.url)("../test/helpers/drizzleIndexDefinitionAudit.cjs");
          upgradeVerification = await auditUpgrade({ api, models, snapshot, format: "pg16", database: {
            exec: (query: string) => client.unsafe(query),
            query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
          } });
          steps = upgradeVerification.initialStatements + upgradeVerification.upgradeStatements;
        } else {
          await client.unsafe(generated.join("\n"));
          steps = generated.length;
        }
        columnWriteVerification[path] = await auditDefaults.verifyDefaultWrites({
          exec: (query: string) => client.unsafe(query),
          query: async (query: string) => ({ rows: Array.from(await client.unsafe(query)) }),
        });
        catalogs[path] = await readCatalog(async (query) => Array.from(await client.unsafe(query)) as CatalogRow[]);
        paths.push({ path, steps });
      } finally { await client.end({ timeout: 5 }); }
    }
    const externalVsEmbedded = compareCatalogs(catalogs.external, catalogs.embedded);
    const externalVsOrm = compareCatalogs(catalogs.external, catalogs.orm);
    const contractManifests = await Promise.all([
      "orm-query-index-reconciliation.json",
      "orm-index-definition-reconciliation.json",
      "orm-extra-index-reconciliation.json",
      "orm-ordinary-index-reconciliation.json",
      "orm-index-name-reconciliation.json",
      "orm-constraint-name-reconciliation.json",
      "external-duplicate-index-reconciliation.json",
    ].map(async (name) => JSON.parse(await readFile(resolve(root, "audit", name), "utf8"))));
    if (contractManifests.some((manifest) => !Array.isArray(manifest.entries))) throw new Error("Invalid reconciled index manifest");
    const extra = contractManifests[2].entries;
    if (contractManifests[0].entries.length !== 22 || contractManifests[1].entries.length !== 57 || extra.length !== 50
      || extra.some((entry: { decision: string }) => !["restore-missing-legacy-query-index", "review-orm-only"].includes(entry.decision))) {
      throw new Error("Reconciled index cohort changed; explicit review required");
    }
    const restoredLegacy = extra.filter((entry: { decision: string }) => entry.decision === "restore-missing-legacy-query-index");
    if (restoredLegacy.length !== 28) throw new Error("Expected all 28 legacy query index contracts");
    const priorIndexKeys = [...contractManifests[0].entries, ...contractManifests[1].entries, ...restoredLegacy]
      .map((entry: { key: string }) => entry.key);
    const ordinaryContracts = extendOrdinaryIndexContracts(priorIndexKeys, contractManifests[3]);
    const { retiredKeys } = ordinaryContracts;
    const { keys: namedKeys, oldKeys } = extendIndexNameContracts(ordinaryContracts.keys, contractManifests[4]);
    const owningContracts = extendConstraintNameContracts(namedKeys, contractManifests[5]);
    const duplicateContracts = extendExternalDuplicateContracts(owningContracts.keys, contractManifests[6]);
    const requiredIndexKeys = duplicateContracts.keys;
    const defaultManifest = JSON.parse(await readFile(resolve(root, "audit/orm-column-default-reconciliation.json"), "utf8"));
    const missingConstraintManifest = JSON.parse(await readFile(resolve(root, "audit/orm-missing-constraint-reconciliation.json"), "utf8"));
    const foreignKeyNameManifest = JSON.parse(await readFile(resolve(root, "audit/orm-foreign-key-name-reconciliation.json"), "utf8"));
    for (const catalog of Object.values(catalogs)) assertRetiredIndexesAbsent(catalog, retiredKeys);
    for (const catalog of Object.values(catalogs)) assertOldIndexNamesAbsent(catalog, oldKeys);
    for (const catalog of Object.values(catalogs)) assertConstraintNamesAligned(catalogs.external, catalog);
    for (const catalog of Object.values(catalogs)) assertAllIndexesAligned(catalogs.external, catalog);
    for (const catalog of Object.values(catalogs)) {
      assertColumnDefaultContracts(catalog, defaultManifest);
      assertAllColumnsAligned(catalogs.external, catalog);
      assertMissingConstraintContracts(catalog, missingConstraintManifest);
      assertForeignKeyNamesAligned(catalog, foreignKeyNameManifest);
    }
    assertIndexContracts(catalogs.external, catalogs.embedded, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_upgrade, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_default_upgrade, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_constraints, requiredIndexKeys);
    assertIndexContracts(catalogs.external, catalogs.orm_fk_names, requiredIndexKeys);
    const ormVsForeignKeyRenamed = compareCatalogs(catalogs.orm, catalogs.orm_fk_names);
    if (!foreignKeyNameUpgradeVerification || Object.values(ormVsForeignKeyRenamed).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and foreign-key-renamed ORM catalogs differ");
    }
    const ormVsConstraintUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_constraints);
    if (!missingConstraintUpgradeVerification || Object.values(ormVsConstraintUpgraded).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and constraint-upgraded ORM catalogs differ");
    }
    const ormVsUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_upgrade);
    if (!externalDuplicateIndexRetirement) throw new Error("External duplicate retirement verification is missing");
    const ormVsDefaultUpgraded = compareCatalogs(catalogs.orm, catalogs.orm_default_upgrade);
    if (!columnDefaultUpgradeVerification || Object.values(ormVsDefaultUpgraded).some(changes => Object.values(changes).some(rows => rows.length))) {
      throw new Error("Fresh ORM and default-upgraded ORM catalogs differ");
    }
    if (!upgradeVerification || Object.values(ormVsUpgraded).some((changes) => Object.values(changes).some((values) => values.length))) {
      throw new Error("Fresh ORM and upgraded ORM catalogs differ");
    }
    return {
      scope: "Isolated PostgreSQL 16 external SQL, embedded migration, fresh ORM, index-upgraded ORM, default-upgraded ORM, constraint-upgraded ORM and foreign-key-renamed ORM catalogs: tables, columns, constraints, indexes and sequences. Includes six existing index phases, five external duplicate retirements, a separate four-default upgrade, a separate 41-constraint addition preserving eight NOT VALID states and twelve identity-preserving FK renames. Complete index/column categories, the 41 exact constraint contracts and twelve FK names are seven-path gates. All paths verify omitted/DEFAULT/explicit/NULL writes. Upgrade probes verify synthetic rows, OIDs/files/dependencies, drift refusal, rollback, new writes, FK/unique/cascade behavior, idempotence and schema isolation. View/function/trigger probes cover self-created fixtures, not complete schema equivalence for those categories, privileges or policies. No production rows inspected.",
      serverVersionNum: Number(identity.version),
      externalInputSha256: inputDigest.digest("hex"),
      generatedSqlSha256: createHash("sha256").update(generated.join("\n")).digest("hex"),
      paths,
      counts: Object.fromEntries(Object.entries(catalogs).map(([path, catalog]) => [path, Object.fromEntries(catalogKinds.map((kind) => [kind, catalog[kind].length]))])),
      summary: { externalVsEmbedded: summarizeCatalogDiff(externalVsEmbedded), externalVsOrm: summarizeCatalogDiff(externalVsOrm) },
      verifiedIndexContracts: { mode: "exact named definitions; reject drift in every embedded, fresh ORM and upgraded ORM path", keys: requiredIndexKeys },
      retiredIndexContracts: { mode: "reject the two retired physical index names in every compared path", keys: retiredKeys },
      alignedIndexNameContracts: { mode: "exact canonical names in positive contracts; reject all 44 old physical names in every path", oldKeys },
      alignedConstraintNameContracts: { mode: "exact owning primary/unique constraints and indexes; reject all three old names in every path", constraintKeys: owningContracts.constraintKeys, oldKeys: owningContracts.oldKeys },
      fullIndexCatalogContract: { mode: "all seven paths: exact complete index names and definitions; no additions, omissions or aliases waived", count: catalogs.external.indexes.length, retiredExternalKeys: duplicateContracts.retiredKeys },
      fullColumnCatalogContract: { mode: "all seven paths: exact complete columns, types, nullability, defaults, identity, generation and collation", count: catalogs.external.columns.length, defaultKeys: defaultManifest.entries.map((e: { key: string }) => e.key) },
      missingConstraintContracts: { mode: "all seven paths: exact 39 CHECK and 2 FK including eight NOT VALID states; no other constraint differences waived", keys: missingConstraintManifest.entries.map((e: { key: string }) => e.key) },
      foreignKeyNameContracts: { mode: "all seven paths: exact twelve FK catalog rows and no obsolete physical names or duplicate aliases", keys: foreignKeyNameManifest.entries.map((e: { key: string }) => e.key), oldKeys: foreignKeyNameManifest.entries.map((e: { previousKey: string }) => e.previousKey) },
      foreignKeyNameUpgradeVerification: { ...foreignKeyNameUpgradeVerification, freshCatalogMatched: true },
      missingConstraintUpgradeVerification: { ...missingConstraintUpgradeVerification, freshCatalogMatched: true },
      columnDefaultUpgradeVerification: { ...columnDefaultUpgradeVerification, freshCatalogMatched: true },
      columnWriteVerification,
      externalDuplicateIndexRetirement,
      upgradeVerification: { ...upgradeVerification, freshCatalogMatched: true },
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
          if (!/^orm_audit_(external|embedded|orm|orm_upgrade|orm_default_upgrade|orm_constraints|orm_fk_names)_[a-f0-9]{32}$/.test(name) || name.length > 63) throw new Error("Unsafe cleanup target");
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
