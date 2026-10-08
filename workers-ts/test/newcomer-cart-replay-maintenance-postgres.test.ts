import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbFromConnectionString } from '../src/lib/di';
import { storeCart } from '../src/models/schema';
import {
  applyNewcomerCartReplayMaintenance, inspectNewcomerCartReplayMaintenance,
  inspectNewcomerCartReplayPostflight, inspectNewcomerCartReplayRuntimeLogin,
  newcomerCartReplayInstallSqlSha256, type NewcomerCartReplayMaintenanceTarget,
} from '../src/migrations/newcomerCartAddReplayMaintenance';
import { financePostgres, validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))(
  'FE-003D fixed maintenance entry on native PostgreSQL 16', () => {
    it('checks exact owner and real restricted LOGINs, installs once, and independently verifies an empty receipt', async () => {
      const f = await financePostgres([storeCart], { namespace: 'public' });
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const app = `ncar_app_${suffix}`;
      const admin = `ncar_admin_${suffix}`;
      const password = crypto.randomUUID();
      let createdApp = false;
      let createdAdmin = false;
      let appDb: ReturnType<typeof createDbFromConnectionString> | undefined;
      let adminDb: ReturnType<typeof createDbFromConnectionString> | undefined;
      try {
        const [identity] = await f.db.execute<{ database: string; role: string }>(sql`
          SELECT current_database() AS database,current_user AS role`);
        const target: NewcomerCartReplayMaintenanceTarget = {
          database: identity.database, maintenance: identity.role, app, admin,
        };
        await f.db.execute(sql.raw(`CREATE ROLE ${app} LOGIN PASSWORD '${password}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
        createdApp = true;
        await f.db.execute(sql.raw(`CREATE ROLE ${admin} LOGIN PASSWORD '${password}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
        createdAdmin = true;
        const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
        const loginUrl = (role: string) => {
          const url = new URL(base.href);
          url.pathname = `/${target.database}`;
          url.username = role;
          url.password = password;
          return url.href;
        };
        appDb = createDbFromConnectionString(loginUrl(app), 1, { searchPath: 'public,pg_temp' });
        adminDb = createDbFromConnectionString(loginUrl(admin), 1, { searchPath: 'public,pg_temp' });

        expect(await newcomerCartReplayInstallSqlSha256()).toMatch(/^[0-9a-f]{64}$/);
        expect(await inspectNewcomerCartReplayMaintenance(f.db, target)).toMatchObject({ ready: true });
        expect(await inspectNewcomerCartReplayRuntimeLogin(appDb, target, 'app', false))
          .toMatchObject({ ready: true });
        expect(await inspectNewcomerCartReplayRuntimeLogin(adminDb, target, 'admin', false))
          .toMatchObject({ ready: true });
        // A maintenance connection masquerading as an app login is rejected.
        expect(await inspectNewcomerCartReplayRuntimeLogin(f.db, target, 'app', false))
          .toMatchObject({ ready: false });
        await expect(applyNewcomerCartReplayMaintenance(f.db,
          { ...target, database: 'wrong_database' })).rejects.toThrow();
        expect((await f.db.execute(sql`SELECT to_regclass('public.newcomer_cart_add_replay') AS receipt`))[0])
          .toMatchObject({ receipt: null });

        expect(await applyNewcomerCartReplayMaintenance(f.db, target))
          .toMatchObject({ committed: true });
        expect(await inspectNewcomerCartReplayPostflight(f.db, target))
          .toMatchObject({ ready: true, rows: 0, acl: { exactGrants: true, adminDenied: true } });
        expect(await inspectNewcomerCartReplayRuntimeLogin(appDb, target, 'app', true))
          .toMatchObject({ ready: true, identity: { role: app, session: app, backend: app } });
        expect(await inspectNewcomerCartReplayRuntimeLogin(adminDb, target, 'admin', true))
          .toMatchObject({ ready: true, identity: { role: admin, session: admin, backend: admin } });
        await expect(applyNewcomerCartReplayMaintenance(f.db, target)).rejects.toThrow();
        // Table GRANT alone cannot compensate for lost schema USAGE. Verify
        // the effective real-login boundary rather than checking ACL metadata.
        await f.db.execute(sql`REVOKE USAGE ON SCHEMA public FROM PUBLIC`);
        await f.db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${app},${admin}`));
        expect(await inspectNewcomerCartReplayRuntimeLogin(appDb, target, 'app', true))
          .toMatchObject({ ready: true });
        await f.db.execute(sql.raw(`REVOKE USAGE ON SCHEMA public FROM ${app}`));
        expect(await inspectNewcomerCartReplayRuntimeLogin(appDb, target, 'app', true))
          .toMatchObject({ ready: false, identity: { schemaUsage: false } });
      } finally {
        await appDb?.$client.end({ timeout: 1 });
        await adminDb?.$client.end({ timeout: 1 });
        if (createdApp) await f.db.execute(sql.raw(`DROP OWNED BY ${app}; DROP ROLE ${app}`));
        if (createdAdmin) await f.db.execute(sql.raw(`DROP OWNED BY ${admin}; DROP ROLE ${admin}`));
        await f.close();
      }
    }, 45_000);

    it('rejects default ACL drift before DDL and rogue grants after installation', async () => {
      const f = await financePostgres([storeCart], { namespace: 'public' });
      const suffix = crypto.randomUUID().replaceAll('-', '');
      const app = `ncar_app_${suffix}`;
      const admin = `ncar_admin_${suffix}`;
      const rogue = `ncar_rogue_${suffix}`;
      const createdRoles: string[] = [];
      let defaultGrant = false;
      let customSchema = false;
      try {
        const [identity] = await f.db.execute<{ database: string; role: string }>(sql`
          SELECT current_database() AS database,current_user AS role`);
        const target = { database: identity.database, maintenance: identity.role, app, admin };
        for (const role of [app, admin, rogue]) {
          await f.db.execute(sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD '${crypto.randomUUID()}'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
          createdRoles.push(role);
        }
        await f.db.execute(sql`CREATE SCHEMA pgfoo`);
        customSchema = true;
        await f.db.execute(sql.raw(`GRANT CREATE ON SCHEMA pgfoo TO ${app}`));
        const unexpectedSchema = await inspectNewcomerCartReplayMaintenance(f.db, target);
        expect(unexpectedSchema).toMatchObject({ ready: false });
        expect(unexpectedSchema.roles.find(role => role.name === app)).toMatchObject({ noDdl: false });
        await expect(applyNewcomerCartReplayMaintenance(f.db, target)).rejects.toThrow();
        await f.db.execute(sql.raw(`REVOKE CREATE ON SCHEMA pgfoo FROM ${app}`));
        await f.db.execute(sql`DROP SCHEMA pgfoo`);
        customSchema = false;
        await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
          GRANT SELECT ON TABLES TO ${rogue}`));
        defaultGrant = true;
        expect(await inspectNewcomerCartReplayMaintenance(f.db, target))
          .toMatchObject({ ready: false, root: { relevantDefaultAcls: 1 } });
        await expect(applyNewcomerCartReplayMaintenance(f.db, target)).rejects.toThrow();
        expect((await f.db.execute(sql`SELECT to_regclass('public.newcomer_cart_add_replay') AS receipt`))[0])
          .toMatchObject({ receipt: null });
        await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE SELECT ON TABLES FROM ${rogue}`));
        defaultGrant = false;
        expect(await inspectNewcomerCartReplayMaintenance(f.db, target)).toMatchObject({ ready: true });
        await applyNewcomerCartReplayMaintenance(f.db, target);
        await f.db.execute(sql.raw(`GRANT SELECT ON public.newcomer_cart_add_replay TO ${rogue}`));
        expect(await inspectNewcomerCartReplayPostflight(f.db, target))
          .toMatchObject({ ready: false, acl: { exactGrants: false } });
      } finally {
        if (customSchema) {
          await f.db.execute(sql.raw(`REVOKE CREATE ON SCHEMA pgfoo FROM ${app}`));
          await f.db.execute(sql`DROP SCHEMA pgfoo`);
        }
        if (defaultGrant) await f.db.execute(sql.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
          REVOKE SELECT ON TABLES FROM ${rogue}`));
        for (const role of createdRoles.reverse()) {
          await f.db.execute(sql.raw(`DROP OWNED BY ${role}; DROP ROLE ${role}`));
        }
        await f.close();
      }
    }, 45_000);
  });
