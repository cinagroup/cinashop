import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { createDbFromConnectionString, type DbClient } from '../src/lib/di';
import { inspectUncommissionedRuntimeRoles, provisionRuntimeRoles, type RuntimeRoleNames } from '../src/migrations/provisionRuntimeRoles';

describe('explicit uncommissioned runtime role provisioning PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>, names: RuntimeRoleNames;
  let options: Parameters<typeof provisionRuntimeRoles>[1];
  const clients: DbClient[] = [];
  beforeEach(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Owned native PG16 required');
    f = await sequenceRunnerDatabase();
    names = { app: 'cinashop_runtime_' + randomUUID().replaceAll('-', ''), admin: 'cinashop_runtime_' + randomUUID().replaceAll('-', ''),
      pricingOwner: 'cinashop_runtime_' + randomUUID().replaceAll('-', '') };
    const [identity] = await f.db.execute(sql`SELECT current_database() AS name`);
    options = { expectedDatabase: String(identity.name), expectedMaintenanceRole: 'finance_test', names,
      appPassword: Array.from(randomBytes(32), b => b.toString(16).padStart(2, '0')).join(''),
      adminPassword: Array.from(randomBytes(32), b => b.toString(16).padStart(2, '0')).join('') };
    await f.exec('CREATE TABLE public.role_test_business(id serial PRIMARY KEY, value text); INSERT INTO public.role_test_business(value) VALUES(\'unchanged\')');
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(db => db.$client.end({ timeout: 1 })));
    if (f) {
      for (const name of Object.values(names)) {
        if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(name)) throw Error('Unsafe owned role cleanup');
        const rows = await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${name}`);
        if (rows.length) await f.exec(`DROP OWNED BY "${name}"; DROP ROLE "${name}"`);
      }
      await f.close();
    }
  }, 30000);
  const runtime = async (name: string, password: string) => {
    const url = new URL(process.env.TEST_FINANCE_POSTGRES_URL!);
    url.pathname = '/' + options.expectedDatabase; url.username = name; url.password = password;
    const db = createDbFromConnectionString(url.href, 1); clients.push(db); return db;
  };
  it('creates two independently authenticated restricted LOGINs and a NOLOGIN owner without business grants', async () => {
    expect((await inspectUncommissionedRuntimeRoles(f.db, names)).roles).toEqual([]);
    const before = await f.exec('SELECT * FROM public.role_test_business');
    expect(await provisionRuntimeRoles(f.db, options)).toMatchObject({ created: true, commissioned: false, roles: expect.any(Array) });
    expect((await inspectUncommissionedRuntimeRoles(f.db, names)).roles).toHaveLength(3);
    for (const [name, password] of [[names.app, options.appPassword], [names.admin, options.adminPassword]]) {
      const db = await runtime(name, password);
      expect((await inspectUncommissionedRuntimeRoles(db, names)).identity).toEqual({
        database: options.expectedDatabase, role: name, session: name, backend_role: name });
      expect(Array.from(await db.execute(sql`SELECT current_user=${name} AND session_user=${name}
        AND (SELECT usesysid FROM pg_stat_activity WHERE pid=pg_backend_pid())=(SELECT oid FROM pg_roles WHERE rolname=${name}) AS independent`)))
        .toEqual([{ independent: true }]);
      for (const statement of ['SELECT * FROM public.role_test_business', 'UPDATE public.role_test_business SET value=\'no\'',
        'CREATE TABLE public.not_allowed(id int)', 'SELECT setval(\'public.role_test_business_id_seq\',99)',
        'SET ROLE finance_test', 'SET session_replication_role=replica']) {
        await expect(db.execute(sql.raw(statement))).rejects.toThrow();
      }
    }
    expect(await f.exec('SELECT * FROM public.role_test_business')).toEqual(before);
    expect(Array.from(await f.db.execute(sql`SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid
      WHERE rolname IN (${names.app},${names.admin})`))).toEqual([{ scram: true }, { scram: true }]);
    await expect(provisionRuntimeRoles(f.db, options)).rejects.toThrow('not confirmed');
  });
  it.each(['wrong-database', 'wrong-maintainer', 'public-schema-create', 'role-collision'])('refuses %s without partial role creation', async reason => {
    if (reason === 'role-collision') await f.exec('CREATE ROLE "' + names.admin + '" NOLOGIN');
    if (reason === 'public-schema-create') await f.exec('GRANT CREATE ON SCHEMA public TO PUBLIC');
    const before = await inspectUncommissionedRuntimeRoles(f.db, names);
    const candidate = { ...options, ...(reason === 'wrong-database' ? { expectedDatabase: 'wrong' } : {}),
      ...(reason === 'wrong-maintainer' ? { expectedMaintenanceRole: 'wrong' } : {}) };
    await expect(provisionRuntimeRoles(f.db, candidate)).rejects.toThrow('not confirmed');
    expect(await inspectUncommissionedRuntimeRoles(f.db, names)).toEqual(before);
  });
  it('validates root, distinct names and generated credentials before SQL', async () => {
    for (const appPassword of ['', 'short', "x'; SELECT 1;--", options.adminPassword])
      await expect(provisionRuntimeRoles(f.db, { ...options, appPassword })).rejects.toThrow('credentials');
    for (const app of ['postgres', 'bad;name', names.admin])
      await expect(provisionRuntimeRoles(f.db, { ...options, names: { ...names, app } })).rejects.toThrow();
    await f.db.transaction(async tx => { await expect(provisionRuntimeRoles(tx, options)).rejects.toThrow('root'); });
    expect((await inspectUncommissionedRuntimeRoles(f.db, names)).roles).toEqual([]);
  });
});
