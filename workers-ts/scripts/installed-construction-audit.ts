/** Fresh owned PG16 observations; never accepts a saved report as authority. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { PRICING_OWNER_SETTING } from '../src/migrations/checkoutPricingLockCatalog';
import { SECKILL_TIME_REFERENCE_OWNER_SETTING } from '../src/migrations/seckillTimeReferenceLockCatalog';
import { assertExternalMigrationCohort, assertRegisteredDatabaseCohort, composeExplicitCityCatalog,
  registeredTableNames } from '../test/helpers/registeredCatalogCohort';
import { validateTestTarget } from './orm-ddl-audit';
import { dropOwnedAuditDatabase } from './data-migration/drop-owned-audit-database';
import { readInstalledPublicCatalog, compareInstalledPublicCatalogs, summarizeInstalledPublicCatalogDiff,
  type InstalledPublicCatalog } from './data-migration/installed-public-catalog';
import type { CatalogRow } from './data-migration/postgres-catalog-audit';

export const INSTALLED_CONSTRUCTION_PROFILE = 'pg16-public-external0184-runall0184-city0173-abandon0174-raw-v1';
const root = resolve(import.meta.dirname, '..');
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

export function parseInstalledConstructionArguments(args: readonly string[]): void {
  if (args.length !== 3 || args[0] !== '--profile' || args[1] !== INSTALLED_CONSTRUCTION_PROFILE || args[2] !== '--json')
    throw new Error('Use the exact explicit installed-construction profile followed by --json');
}

/** Owned source files and runtime metadata, not a complete dependency attestation. */
async function inputSnapshot() {
  const files: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of (await readdir(resolve(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Symlink in owned installed-audit source inventory');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && /\.(?:[cm]?js|ts|json|sql)$/.test(entry.name)) files.push(name);
    }
  };
  for (const directory of ['src', 'scripts', 'migrations', 'test/helpers', 'test/fixtures']) await walk(directory);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) files.push(name);
  const rows = [];
  for (const file of files.sort()) {
    assert.ok((await lstat(resolve(root, file))).isFile());
    const bytes = await readFile(resolve(root, file));
    rows.push({ file, bytes: bytes.length, sha256: digest(bytes) });
  }
  const runtime = [];
  for (const name of ['postgres', 'drizzle-orm', 'tsx']) {
    const bytes = await readFile(resolve(root, 'node_modules', name, 'package.json'));
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as { name: string; version: string };
    runtime.push({ name: value.name, version: value.version, metadataSha256: digest(bytes) });
  }
  return { files: rows, sha256: digest(JSON.stringify(rows)), node: { version: process.version,
    executableSha256: digest(await readFile(process.execPath)) }, runtime,
    completeDependencyAttestation: false as const };
}

export async function auditInstalledPublicConstruction(raw: string | undefined, profile: string) {
  assert.equal(profile, INSTALLED_CONSTRUCTION_PROFILE, 'Explicit installed-construction profile required');
  const target = validateTestTarget(raw);
  const inputBefore = await inputSnapshot();
  const options = { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10, onnotice: () => {},
    connection: { statement_timeout: 30_000, lock_timeout: 3_000, search_path: 'public, pg_temp' } };
  const control = postgres(target.href, options);
  const created: string[] = [], roles: string[] = [];
  const clients: ReturnType<typeof postgres>[] = [];
  const paths: Array<{ path: 'external' | 'embedded'; database: string; bareTables: number; tables: number;
    executed: string[]; maintenanceRoles: string[] }> = [];
  const catalogs: Record<string, InstalledPublicCatalog> = {};
  const cleanup: Array<{ database: string; timeoutRecovered: boolean; retried: boolean }> = [];
  let cleanupConfirmed = false;
  try {
    const [identity] = await control`SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS host`;
    assert.ok(identity.database === 'cinashop_finance_test' && identity.role === 'finance_test'
      && Math.floor(Number(identity.version) / 10000) === 16 && ['127.0.0.1', '::1'].includes(String(identity.host)),
    'Unexpected installed-audit test-service identity; no resources created');
    const migrationNames = (await readdir(resolve(root, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    assertExternalMigrationCohort(migrationNames);
    for (const path of ['external', 'embedded'] as const) {
      const name = 'orm_audit_' + path + '_' + randomUUID().replaceAll('-', '');
      assert.match(name, /^orm_audit_(?:external|embedded)_[a-f0-9]{32}$/);
      await control.unsafe('CREATE DATABASE "' + name + '" TEMPLATE template0');
      created.push(name);
      const isolated = new URL(target.href); isolated.pathname = '/' + name;
      const client = postgres(isolated.href, options); clients.push(client);
      const db: DbClient = drizzle(client);
      const [actual] = await client`SELECT current_database() AS database, current_user AS role`;
      assert.ok(actual.database === name && actual.role === 'finance_test', 'Owned installation database identity mismatch');
      const maintenanceRoles: string[] = [];
      for (const setting of [PRICING_OWNER_SETTING, SECKILL_TIME_REFERENCE_OWNER_SETTING]) {
        const role = 'cinashop_runtime_' + randomUUID().replaceAll('-', '');
        assert.match(role, /^cinashop_runtime_[a-f0-9]{32}$/);
        await control.unsafe('CREATE ROLE "' + role + '" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
        roles.push(role); maintenanceRoles.push(role);
        await client`SELECT pg_catalog.set_config(${setting},${role},false)`;
      }
      let executed: string[];
      if (path === 'external') {
        for (const file of migrationNames) await client.begin(async tx => {
          await tx.unsafe('SET LOCAL search_path TO public,pg_temp');
          await tx.unsafe(await readFile(resolve(root, 'migrations', file), 'utf8'));
        });
        executed = [...migrationNames];
      } else {
        const result = await new MigrationService(createContainerFromDb(db)).runAll();
        assert.deepEqual(result, { executed: Array.from({ length: 185 }, (_, index) => String(index).padStart(4, '0')), errors: [] });
        executed = result.executed;
      }
      await assertRegisteredDatabaseCohort(db, path);
      const bareTables = registeredTableNames(path).length;
      await composeExplicitCityCatalog(db, path);
      await assertRegisteredDatabaseCohort(db, 'external');
      paths.push({ path, database: name, bareTables, tables: registeredTableNames('external').length, executed, maintenanceRoles });
    }
    // Both complete constructors are finished before either catalog snapshot.
    for (let index = 0; index < paths.length; index++) {
      const client = clients[index]!;
      catalogs[paths[index]!.path] = await client.begin('isolation level repeatable read read only', async tx =>
        readInstalledPublicCatalog(async query => Array.from(await tx.unsafe(query)) as CatalogRow[]));
    }
    const differences = compareInstalledPublicCatalogs(catalogs.external!, catalogs.embedded!);
    const summary = summarizeInstalledPublicCatalogDiff(differences);
    const observedCatalogsEqual = differences.equal;
    const inputAfter = await inputSnapshot();
    assert.deepEqual(inputAfter, inputBefore, 'Installed audit inputs changed during actual construction');
    // Returning from try still executes and verifies the finally cleanup below.
    return { profile, engineVersion: Number(identity.version), paths, catalogs, differences, summary,
      inputSnapshot: inputBefore, inputSnapshotUnchanged: true,
      diagnosticCompleted: true, observedCatalogsEqual,
      roleNamesAndRoutineBodiesNormalized: false, rawObservationsOnly: true,
      wholeInstalledCatalogEquivalent: false, runtimeCommissioned: false, wholeMigrationReady: false,
      get cleanupConfirmed() { return cleanupConfirmed; }, cleanup };
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const client of clients) {
      try { await client.end({ timeout: 5 }); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      for (const database of [...created].reverse()) {
        try { cleanup.push({ database,
          ...await dropOwnedAuditDatabase((statement, parameters) => control.unsafe(statement, parameters), database, created) }); }
        catch (error) { cleanupErrors.push(error); }
      }
      for (const role of [...roles].reverse()) {
        try {
          assert.match(role, /^cinashop_runtime_[a-f0-9]{32}$/);
          await control.unsafe('DROP ROLE "' + role + '"');
        } catch (error) { cleanupErrors.push(error); }
      }
      if (created.length) assert.equal((await control`SELECT datname FROM pg_database WHERE datname=ANY(${created}::text[])`).length, 0,
        'Owned installation database cleanup unconfirmed');
      if (roles.length) assert.equal((await control`SELECT rolname FROM pg_roles WHERE rolname=ANY(${roles}::text[])`).length, 0,
        'Owned installation role cleanup unconfirmed');
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned installed-audit cleanup did not complete cleanly');
      cleanupConfirmed = true;
    } finally { await control.end({ timeout: 5 }); }
  }
}

export async function installedConstructionMain(args = process.argv.slice(2)): Promise<void> {
  parseInstalledConstructionArguments(args);
  const report = await auditInstalledPublicConstruction(process.env.TEST_FINANCE_POSTGRES_URL, args[1]!);
  process.stdout.write(JSON.stringify(report) + '\n');
  // Even zero observed drift never upgrades the explicit full-installation flags.
  process.exitCode = report.observedCatalogsEqual ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installedConstructionMain().catch(() => { console.error('Installed construction audit failed; inspect owned local diagnostics (connection details redacted)'); process.exitCode = 1; });
}
