import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { readInstalledPublicCatalog, compareInstalledPublicCatalogs } from '../scripts/data-migration/installed-public-catalog';
import { auditInstalledPublicConstruction, INSTALLED_CONSTRUCTION_PROFILE as profile } from '../scripts/installed-construction-audit';
import type { CatalogRow } from '../scripts/data-migration/postgres-catalog-audit';

type Fixture = Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>;
const read = (f: Fixture) => f.db.$client.begin('isolation level repeatable read read only', async tx =>
  readInstalledPublicCatalog(async query => Array.from(await tx.unsafe(query)) as CatalogRow[]));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual extended public installation observations on owned PG16', () => {
  it('detects physical columns, full routines, trigger state, views, policies and real role/ACL changes', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      if (!f.withRuntimeRole) throw Error('Actual separate LOGIN required');
      await f.withRuntimeRole(async peer => {
        await f.exec(`CREATE TABLE public.installed_catalog_probe(id serial PRIMARY KEY,removed text,label text);
          CREATE FUNCTION public.installed_catalog_touch() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN NEW.label := NEW.label; RETURN NEW; END $$;
          CREATE TRIGGER installed_catalog_touch BEFORE INSERT ON public.installed_catalog_probe
            FOR EACH ROW WHEN (NEW.id>0) EXECUTE FUNCTION public.installed_catalog_touch();
          CREATE VIEW public.installed_catalog_view WITH(security_barrier=true) AS
            SELECT id,label FROM public.installed_catalog_probe;
          ALTER TABLE public.installed_catalog_probe ENABLE ROW LEVEL SECURITY;
          CREATE POLICY installed_catalog_policy ON public.installed_catalog_probe
            TO "${peer.role}" USING(id>0) WITH CHECK(id>0);
          GRANT SELECT ON public.installed_catalog_probe TO "${peer.role}";`);
        try {
          const before = await read(f);
          expect(before.scope.fullInstallationEquivalence).toBe(false);
          expect(before.scope.effectivePrivilegesProven).toBe(false);
          expect(before.extensions.columnAttributes.filter(row => row.relation === 'public.installed_catalog_probe')
            .map(row => [row.name, row.ordinal, row.dropped])).toEqual([
            ['id', 1, false], ['removed', 2, false], ['label', 3, false],
          ]);
          expect(before.extensions.routines.find(row => row.key === 'public.installed_catalog_touch()')?.source).toContain('NEW.label := NEW.label');
          await f.exec(`ALTER TABLE public.installed_catalog_probe DROP COLUMN removed;
            ALTER TABLE public.installed_catalog_probe ADD COLUMN removed text;
            CREATE OR REPLACE FUNCTION public.installed_catalog_touch() RETURNS trigger LANGUAGE plpgsql
              SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
              BEGIN NEW.label := upper(NEW.label); RETURN NEW; END $$;
            ALTER FUNCTION public.installed_catalog_touch() OWNER TO "${peer.role}";
            ALTER TABLE public.installed_catalog_probe ENABLE REPLICA TRIGGER installed_catalog_touch;
            CREATE OR REPLACE VIEW public.installed_catalog_view AS
              SELECT id,upper(label) AS label FROM public.installed_catalog_probe;
            ALTER VIEW public.installed_catalog_view SET(security_invoker=true);
            ALTER POLICY installed_catalog_policy ON public.installed_catalog_probe USING(id>1) WITH CHECK(id>1);
            GRANT UPDATE(label) ON public.installed_catalog_probe TO "${peer.role}";
            ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${peer.role}";
            ALTER ROLE "${peer.role}" INHERIT CONNECTION LIMIT 3;
            GRANT "${f.pricingOwner}" TO "${peer.role}";`);
          const after = await read(f), diff = compareInstalledPublicCatalogs(before, after);
          for (const value of Object.values(diff.base)) expect(value).toMatchObject({ referenceOnly: [], candidateOnly: [], changed: [] });
          for (const kind of ['columnAttributes', 'relationAttributes', 'routines', 'triggers', 'views', 'policies', 'objectOwners', 'acls', 'roles'] as const)
            expect(diff.extensions[kind].changed.length, kind).toBeGreaterThan(0);
          expect(diff.extensions.defaultAcls.candidateOnly.length).toBeGreaterThan(0);
          expect(diff.extensions.roleMemberships.candidateOnly.length).toBeGreaterThan(0);
          expect(after.extensions.triggers.find(row => row.name === 'installed_catalog_touch')?.enabled).toBe('R');
          expect(after.extensions.routines.find(row => row.key === 'public.installed_catalog_touch()'))
            .toMatchObject({ owner: peer.role, securityDefiner: true });
          expect(JSON.stringify(after.extensions.roles)).not.toContain('rolpassword');
          await f.exec('CREATE DOMAIN public.installed_catalog_unknown AS text');
          const unsupported = await read(f);
          expect(unsupported.scope.unsupportedObjectsPresent).toBe(true);
          expect(unsupported.extensions.unsupportedObjects.some(row => String(row.name).includes('installed_catalog_unknown'))).toBe(true);
          expect(unsupported.scope.fullInstallationEquivalence).toBe(false);
        } finally {
          await f.exec(`ALTER FUNCTION public.installed_catalog_touch() OWNER TO finance_test;
            DROP POLICY installed_catalog_policy ON public.installed_catalog_probe;
            REVOKE "${f.pricingOwner}" FROM "${peer.role}";
            ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM "${peer.role}";`);
        }
      });
    } finally { await f.close(); }
  }, 120000);

  it('retains a membership grantor without importing its unrelated global default privileges', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      if (!f.withRuntimeRole) throw Error('Actual separate LOGIN required');
      await f.withRuntimeRole(async peer => {
        const orphan = 'cinashop_runtime_' + randomUUID().replaceAll('-', '');
        const dbOwner = 'cinashop_runtime_' + randomUUID().replaceAll('-', '');
        expect(orphan).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
        expect(dbOwner).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
        const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
        const [identity] = await f.db.$client<{ database: string; owner: string }[]>`
          SELECT current_database() AS database,pg_get_userbyid(datdba) AS owner
          FROM pg_database WHERE datname=current_database()`;
        expect(identity!.database).toMatch(/^cinashop_kefu_runner_[a-f0-9]{32}$/);
        expect(identity!.owner).toBe('finance_test');
        let createdOwner = false, createdOrphan = false, ownerChanged = false;
        let grantor: string | undefined;
        try {
          await f.exec(`CREATE ROLE "${dbOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOREPLICATION NOBYPASSRLS`);
          createdOwner = true;
          await f.exec(`ALTER DATABASE ${quote(identity!.database)} OWNER TO "${dbOwner}"`);
          ownerChanged = true;
          await f.exec(`GRANT "${f.pricingOwner}" TO "${peer.role}"`);
          // Discover the actual bootstrap grantor. Local and CI names differ.
          // The owned database has a separate owner so either name is outside
          // the public owner/member closure and remains an observation only.
          const grants = await f.db.$client.unsafe<{ grantor: string }[]>(`SELECT pg_get_userbyid(grantor) AS grantor FROM pg_auth_members
            WHERE roleid='${f.pricingOwner}'::regrole AND member='${peer.role}'::regrole`);
          expect(grants).toHaveLength(1);
          expect(typeof grants[0]?.grantor).toBe('string');
          grantor = grants[0]!.grantor;
          const before = await read(f);
          expect(before.extensions.roles.some(row => row.name === grantor)).toBe(true);
          expect(before.extensions.objectOwners.some(row => row.owner === grantor)).toBe(false);
          expect(before.extensions.objectOwners).toEqual([
            { key: 'schema:public', name: 'public', kind: 'schema', owner: 'pg_database_owner' },
          ]);
          await f.exec(`CREATE ROLE "${orphan}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOREPLICATION NOBYPASSRLS`);
          createdOrphan = true;
          await f.exec(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(grantor)} GRANT SELECT ON TABLES TO "${orphan}"`);
          const actual = await f.db.$client`SELECT d.oid FROM pg_default_acl d
            CROSS JOIN LATERAL aclexplode(d.defaclacl) a
            WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=${grantor}) AND d.defaclnamespace=0
              AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=${orphan}) AND a.privilege_type='SELECT'`;
          expect(actual).toHaveLength(1);
          const after = await read(f);
          expect(after.extensions.roles.some(row => row.name === grantor)).toBe(true);
          expect(after.extensions.roles.some(row => row.name === orphan)).toBe(false);
          expect(after.extensions.defaultAcls.some(row => row.owner === grantor && row.namespace === null)).toBe(false);
          expect(after.identities.some(row => row.kind === 'defaultAcl' && row.name === grantor)).toBe(false);
          // The excluded ACL has not changed any observation in the stated scope.
          expect(compareInstalledPublicCatalogs(before, after).equal).toBe(true);
        } finally {
          const errors: unknown[] = [];
          const attempt = async (statement: string) => { try { await f.exec(statement); } catch (error) { errors.push(error); } };
          if (createdOrphan && grantor) await attempt(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(grantor)} REVOKE SELECT ON TABLES FROM "${orphan}"`);
          await attempt(`REVOKE "${f.pricingOwner}" FROM "${peer.role}"`);
          if (ownerChanged) await attempt(`ALTER DATABASE ${quote(identity!.database)} OWNER TO finance_test`);
          if (createdOrphan) await attempt(`DROP ROLE "${orphan}"`);
          if (createdOwner) await attempt(`DROP ROLE "${dbOwner}"`);
          if (errors.length) throw new AggregateError(errors, 'Owned grantor-scope probe cleanup failed');
          const remaining = await f.db.$client`SELECT rolname FROM pg_roles WHERE rolname=ANY(${[orphan, dbOwner]}::text[])`;
          expect(remaining).toHaveLength(0);
          const [restored] = await f.db.$client`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()`;
          expect(restored!.owner).toBe('finance_test');
        }
      });
    } finally { await f.close(); }
  }, 120000);

  it('actually constructs both complete paths and preserves raw differences before verified owned cleanup', async () => {
    const report = await auditInstalledPublicConstruction(process.env.TEST_FINANCE_POSTGRES_URL, profile);
    expect(report.paths.map(path => [path.path, path.bareTables, path.tables, path.executed.length]))
      .toEqual([['external', 287, 287, 182], ['embedded', 283, 287, 185]]);
    expect(report.inputSnapshotUnchanged).toBe(true);
    expect(report.cleanupConfirmed).toBe(true); expect(report.cleanup).toHaveLength(2);
    expect(report.diagnosticCompleted).toBe(true); expect(report.observedCatalogsEqual).toBe(false);
    expect(report.wholeInstalledCatalogEquivalent).toBe(false);
    expect(report.runtimeCommissioned).toBe(false); expect(report.wholeMigrationReady).toBe(false);
    for (const value of Object.values(report.differences.base)) expect(value).toMatchObject({ referenceOnly: [], candidateOnly: [], changed: [] });
    expect(report.differences.extensions.routines.changed.length
      + report.differences.extensions.objectOwners.changed.length
      + report.differences.extensions.roles.referenceOnly.length).toBeGreaterThan(0);
    for (const catalog of Object.values(report.catalogs)) {
      expect(catalog.base.tables).toHaveLength(287);
      expect(catalog.extensions.routines.length).toBeGreaterThan(0);
      expect(catalog.extensions.triggers.some(row => row.internal === true)).toBe(true);
      expect(catalog.scope.fullInstallationEquivalence).toBe(false);
    }
    console.info('INSTALLED_PUBLIC_CATALOG_API ' + JSON.stringify({ engineVersion: report.engineVersion,
      summary: report.summary, cleanupConfirmed: report.cleanupConfirmed, inputSnapshotUnchanged: report.inputSnapshotUnchanged }));
  }, 180000);

  it('executes the real explicit CLI, prints actual catalogs and exits nonzero for unnormalized drift', () => {
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/installed-construction-audit.ts',
      '--profile', profile, '--json'], { cwd: resolve(import.meta.dirname, '..'), env: process.env,
      encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ profile, diagnosticCompleted: true, inputSnapshotUnchanged: true,
      cleanupConfirmed: true, observedCatalogsEqual: false, wholeInstalledCatalogEquivalent: false,
      roleNamesAndRoutineBodiesNormalized: false, runtimeCommissioned: false, wholeMigrationReady: false });
    expect(report.paths.map((path: { tables: number }) => path.tables)).toEqual([287, 287]);
    expect(report.cleanup).toHaveLength(2);
    expect(report.catalogs.external.base.tables).toHaveLength(287);
    expect(report.catalogs.embedded.base.tables).toHaveLength(287);
    console.info('INSTALLED_PUBLIC_CATALOG_CLI ' + JSON.stringify({ engineVersion: report.engineVersion,
      summary: report.summary, stdoutBytes: new TextEncoder().encode(result.stdout).length,
      cleanupConfirmed: report.cleanupConfirmed, inputSnapshotUnchanged: report.inputSnapshotUnchanged }));
  }, 120000);
});
