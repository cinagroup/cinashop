/** Formal maintenance/whole-profile acceptance on an owned PG16 database.
 * This does not commission the Routine HTTP author, provider account ownership,
 * production credentials or a browser flow. No SQL inspector is mocked. */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditCustomerFinancialRuntimePrivileges } from '@/migrations/auditCustomerFinancialRuntimePrivileges';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { auditCustomerCashierSecondCardRuntimePrivileges } from '@/migrations/auditCustomerCashierSecondCardRuntimePrivileges';
import { ADMIN_WECHAT_ROUTINE_OPERATION_SQL, assertAdminWechatRoutineOperationReady } from '@/migrations/adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE } from '@/migrations/adminWechatRoutineWriteCapability';
import { inspectAdminWechatRoutineWriteCatalog } from '@/migrations/adminWechatRoutineWriteCatalog';
import { runAdminWechatRoutineUpgrade, installAdminWechatRoutineUpgradeInTransaction } from '@/migrations/runAdminWechatRoutineUpgrade';
import { runAdminAuthorityOperationUpgrade } from '@/migrations/runAdminAuthorityOperationUpgrade';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { runAdminWechatOpenUpgrade } from '@/migrations/runAdminWechatOpenUpgrade';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { runAdminPcBaseUpgrade } from '@/migrations/runAdminPcBaseUpgrade';
import { AdminWechatBaseService } from '@/services/admin/AdminWechatBaseService';
import { AdminWechatOpenService } from '@/services/admin/AdminWechatOpenService';
import { AdminWechatAppService } from '@/services/admin/AdminWechatAppService';
import { AdminPcBaseService } from '@/services/admin/AdminPcBaseService';
import { PC_BASE_VIEW_SEED, PC_BASE_SAVE_SEED } from '@/services/admin/AdminPcBasePermissionBinding';
import { WECHAT_APP_VIEW_SEED } from '@/services/admin/AdminWechatAppPermissionBinding';
import { md5 } from '@/utils/jwt';
import { PC_BASE_KEYS } from '../../view/common/pcBase';
import type { PcBaseIntentSave } from '../../view/common/pcBaseIntent';
import { WECHAT_ROUTINE_KEYS } from '../../view/common/wechatRoutine';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type Target = { database: string; maintenance: string; app: string; admin: string; writer: string };
type Context = { f: Fixture; app: Peer; admin: Peer; target: Target };
const PASSWORD = 'owned-routine-coexist-password';
const actor = () => ({ id: 9123, authVersion: md5(PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 86400 });
const names = (c: Context) => ({ ...c.target, pricingOwner: c.f.pricingOwner });

async function fixture(run: (c: Context) => Promise<void>) {
  const f = await refundRuntimeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole) throw Error('Owned native PG16 and independent LOGINs required');
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute<{ database: string; maintenance: string }>(sql`
        SELECT current_database() AS database,current_user AS maintenance`);
      const target: Target = { ...identity, app: app.role, admin: admin.role,
        writer: `routine_upgrade_${randomUUID().replaceAll('-', '')}` };
      await runRuntimeBusinessCommissioning(f.db, { ...target, pricingOwner: f.pricingOwner });
      const writer = pricingIdentifier(target.writer);
      const created = await f.db.transaction(async tx => {
        await tx.execute(sql.raw(`CREATE ROLE ${writer} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`));
        const [row] = await tx.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${target.writer}`);
        if (!row?.oid) throw Error('Owned Routine writer OID was not recorded');
        return row;
      });
      try {
        expect(app.pid).not.toBe(admin.pid);
        await run({ f, app, admin, target });
      } finally {
        const [current] = await f.db.execute<{ oid: string }>(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname=${target.writer}`);
        if (current?.oid !== created.oid) throw Error('Owned Routine writer identity changed before cleanup');
        await f.exec(`DROP OWNED BY ${writer}; DROP ROLE ${writer}`);
        expect(await f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${target.writer}`)).toHaveLength(0);
      }
    }));
  } finally { await f.close(); }
}

async function configRows(db: DbClient, routineOnly = false) {
  return Array.from(await db.execute(sql`SELECT to_jsonb(c) AS row,c.xmin::text AS version
    FROM public.system_config c WHERE NOT ${routineOnly}
      OR c.menu_name IN (${sql.join(WECHAT_ROUTINE_KEYS.map(key => sql`${key}`), sql`, `)}) ORDER BY c.id`));
}
async function state(c: Context) {
  return {
    config: await configRows(c.f.db),
    relations: Array.from(await c.f.db.execute(sql`SELECT oid::text,relname,relkind,relowner::text,relacl::text
      FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
        AND (relname='system_config' OR relname='system_config_id_seq' OR starts_with(relname,'admin_wechat_routine_') OR starts_with(relname,'awro_')) ORDER BY oid`)),
    functions: Array.from(await c.f.db.execute(sql`SELECT oid::text,proname,prosrc,proowner::text,proacl::text,proconfig
      FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
        AND (starts_with(proname,'cinashop_wechat_routine_') OR starts_with(proname,'cinashop_admin_wechat_routine_')
          OR starts_with(proname,'admin_wechat_routine_')) ORDER BY oid`)),
    triggers: Array.from(await c.f.db.execute(sql`SELECT oid::text,tgname,tgfoid::text,tgenabled,tgtype
      FROM pg_catalog.pg_trigger WHERE tgrelid='public.system_config'::regclass ORDER BY oid`)),
    columnAcl: Array.from(await c.f.db.execute(sql`SELECT attnum,attacl::text FROM pg_catalog.pg_attribute
      WHERE attrelid='public.system_config'::regclass AND attnum>0 ORDER BY attnum`)),
    writer: Array.from(await c.f.db.execute(sql`SELECT oid::text,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
      FROM pg_catalog.pg_roles WHERE rolname=${c.target.writer}`)),
    writerGrants: Array.from(await c.f.db.execute(sql`SELECT c.oid::text,c.relname,a.privilege_type,a.is_grantable,a.grantor::text
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${c.target.writer})
      ORDER BY c.oid,a.privilege_type,a.grantor`)),
    sequence: Array.from(await c.f.db.execute(sql`SELECT last_value,is_called FROM public.system_config_id_seq`)),
  };
}
async function audits(c: Context) {
  for (const [peer, kind] of [[c.app, 'app'], [c.admin, 'admin']] as const)
    expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names(c))).toMatchObject({ ready: true, failures: [] });
}
async function authorReceipts(c: Context) {
  const result: Record<string, unknown> = {};
  for (const table of ['admin_wechat_base_operation', 'admin_wechat_open_operation', 'admin_wechat_app_operation', 'admin_pc_base_operation', 'admin_wechat_routine_operation'])
    result[table] = Array.from(await c.f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY operation_id`)));
  return result;
}

async function authors(c: Context) {
  for (const install of [runAdminAuthorityOperationUpgrade, runAdminWechatMenuUpgrade, runAdminWechatBaseUpgrade,
    runAdminWechatOpenUpgrade, runAdminWechatAppUpgrade, runAdminPcBaseUpgrade]) await install(c.f.db, names(c));
  await c.f.db.insert(systemRole).values({ id: 9123, roleName: 'Owned Routine coexist', rules: '1360,1361,1362,1379,315' });
  await c.f.db.insert(systemAdmin).values({ id: 9123, account: 'owned_routine_coexist', pwd: PASSWORD, roles: '9123', level: 1, adminType: 1 });
  await c.f.db.delete(systemMenus).where(inArray(systemMenus.id, [1360,1361,1362,1379,315]));
  await c.f.db.insert(systemMenus).values([
    { ...PC_BASE_VIEW_SEED, menuName: 'PC配置' }, { ...PC_BASE_SAVE_SEED, menuName: '保存配置' },
    { ...WECHAT_APP_VIEW_SEED, menuName: '原生App配置' },
    { id: 1360, pid: 135, type: 1, module: 'admin', controller: '', action: '', authType: 1,
      menuName: '开放平台', menuPath: '/admin/app/wechat_open', uniqueAuth: 'app-wechat-open', apiUrl: '', methods: '' },
    { id: 1362, pid: 69, type: 1, module: 'admin', controller: '', action: '', authType: 1,
      menuName: '公众号配置', menuPath: '/admin/app/wechat/base', uniqueAuth: 'app-wechat-base', apiUrl: '', methods: '' },
  ]);
  const base = { wechat_appid: 'wx1234567890abcdef', wechat_encode: 0 as const, share_qrcode: 0 as const,
    spread_share_forever: 0 as const, wechat_qrcode: '', create_wechat_user: 0 as const };
  const stored = { ...base, wechat_appsecret: 'owned-coexist-base-secret', wechat_encodingaeskey: 'A'.repeat(43), wechat_token: 'OwnedCoexistToken',
    wechat_base_callback_authority: 'disabled', wechat_open_app_id: 'wx1234567890abcdef', wechat_open_app_secret: 'owned-coexist-open-secret',
    wechat_open_credentials_authority: 'deployment', wechat_app_appid: 'owned-coexist-native-app', wechat_app_appsecret: 'owned-coexist-native-secret',
    pc_logo: '', bast_number: 1, first_number: 1, product_phone_buy_url: 2, contact_number: '', company_address: 'original address',
    copyright: '', seo_title: '', site_keywords: '', site_description: '', links_open: 0, links_list: [], filing_list: [],
    routine_appId: 'owned-routine-app', routine_appsecret: 'owned-routine-secret', routine_name: 'Owned Routine', routine_contact_type: 1, store_user_avatar: 0 };
  await c.f.db.delete(systemConfig).where(inArray(systemConfig.menuName, Object.keys(stored)));
  await c.f.db.insert(systemConfig).values(Object.entries(stored).map(([menuName, value]) => ({ menuName, value: JSON.stringify(value), sort: 7 })));
  const env = { APP_KEY: 'owned-routine-coexist-signing-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    CONFIG_KV: { get: vi.fn(async () => { throw Error('No cached author authority'); }), put: vi.fn(), delete: vi.fn(async () => {}) } } as unknown as Env;
  const container = createContainerFromDb(c.admin.db), staff = actor();
  const official = new AdminWechatBaseService(container, env), open = new AdminWechatOpenService(container, env);
  const app = new AdminWechatAppService(container, env), pc = new AdminPcBaseService(container, env);
  return [
    { key: 'share_qrcode', raw: '"1"', save: async () => {
      const before = await official.read(staff); expect(before.runtime_ready).toBe(true);
      return official.save({ request_id: randomUUID(), revision: before.revision, confirmed: true, database_callback: false,
        settings: { ...base, share_qrcode: 1 }, secrets: { wechat_appsecret: { action: 'keep' }, wechat_encodingaeskey: { action: 'keep' }, wechat_token: { action: 'keep' } } }, staff);
    } },
    { key: 'wechat_open_app_secret', raw: '"owned-coexist-open-replaced"', save: async () => {
      const before = await open.read(staff); expect(before.runtime_ready).toBe(true);
      return open.save({ request_id: randomUUID(), revision: before.revision, confirmed: true, database_credentials: false,
        settings: { wechat_open_app_id: 'wx1234567890abcdef' }, secrets: { wechat_open_app_secret: { action: 'replace', value: 'owned-coexist-open-replaced' } } }, staff);
    } },
    { key: 'wechat_app_appsecret', raw: '"owned-coexist-native-replaced"', save: async () => {
      const before = await app.read(staff); expect(before.runtime_ready).toBe(true);
      return app.save({ request_id: randomUUID(), revision: before.revision, confirmed: true,
        fields: { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'replace', value: 'owned-coexist-native-replaced' } } }, staff);
    } },
    { key: 'company_address', raw: '"Routine coexist address"', save: async () => {
      const before = await pc.read(staff); expect(before.runtime_ready).toBe(true);
      const fields = Object.fromEntries(PC_BASE_KEYS.map(key => [key, key === 'company_address'
        ? { action: 'replace', value: 'Routine coexist address' } : { action: 'keep' }])) as PcBaseIntentSave['fields'];
      return pc.save({ request_id: randomUUID(), revision: before.revision, confirmed: true, fields }, staff);
    } },
  ];
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine explicit maintenance addon and complete commissioned PG16 roles', () => {
  afterEach(() => vi.restoreAllMocks());

  it('installs atomically, is idempotent, passes both full profiles and retains restricted independent identities', async () => fixture(async c => {
    const before = await configRows(c.f.db), sequence = (await state(c)).sequence;
    await audits(c);
    const result = await runAdminWechatRoutineUpgrade(c.f.db, c.target);
    expect(result).toMatchObject({ operation: 'admin-wechat-routine-author-v1', applied: true,
      binding: { database: c.target.database, admin: c.target.admin, writer: c.target.writer } });
    expect(await inspectAdminWechatRoutineWriteCatalog(c.f.db,
      { maintenance: c.target.maintenance, admin: c.target.admin, writer: c.target.writer })).toMatchObject({ present: true, ready: true, failures: [] });
    await audits(c);
    await expect(c.admin.db.transaction(tx => assertAdminWechatRoutineOperationReady(tx))).resolves.toBeUndefined();
    expect(await configRows(c.f.db)).toEqual(before); expect((await state(c)).sequence).toEqual(sequence);
    expect(await c.admin.exec('SELECT * FROM public.admin_wechat_routine_operation')).toEqual([]);
    const installed = await state(c);
    expect(await runAdminWechatRoutineUpgrade(c.f.db, c.target)).toEqual({ ...result, applied: false });
    expect(await state(c)).toEqual(installed);
    for (const statement of ['SELECT * FROM public.admin_wechat_routine_operation',
      'SELECT public.cinashop_admin_wechat_routine_write_v1(NULL::uuid,NULL::integer,NULL::text,NULL::text,NULL::text,NULL::text,NULL::jsonb)'])
      await expect(c.app.exec(statement)).rejects.toMatchObject({ code: '42501' });
    for (const statement of ['INSERT INTO public.admin_wechat_routine_operation DEFAULT VALUES',
      'UPDATE public.admin_wechat_routine_operation SET actor_id=1', 'DELETE FROM public.admin_wechat_routine_operation', 'TRUNCATE public.admin_wechat_routine_operation'])
      await expect(c.admin.exec(statement)).rejects.toMatchObject({ code: '42501' });
    const [acl] = await c.f.db.execute<{ app: boolean; admin: boolean }>(sql`SELECT
      pg_catalog.has_function_privilege(${c.target.app},${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE},'EXECUTE') AS app,
      pg_catalog.has_function_privilege(${c.target.admin},${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE},'EXECUTE') AS admin`);
    expect(acl).toEqual({ app: false, admin: true });
  }), 180000);

  it('rolls all addon objects and grants back with its caller-owned maintenance transaction', async () => fixture(async c => {
    const before = await state(c), abort = Error('Owned caller rollback');
    await expect(c.f.db.transaction(async tx => {
      expect(await installAdminWechatRoutineUpgradeInTransaction(tx, c.target)).toMatchObject({ applied: true });
      throw abort;
    }, { isolationLevel: 'read committed', accessMode: 'read write' })).rejects.toBe(abort);
    expect(await state(c)).toEqual(before); await audits(c);
  }), 180000);

  it('refuses an incomplete receipt-only bundle without adding or repairing any authority', async () => fixture(async c => {
    await c.f.exec(ADMIN_WECHAT_ROUTINE_OPERATION_SQL);
    const before = await state(c);
    await expect(runAdminWechatRoutineUpgrade(c.f.db, c.target)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
  }), 180000);

  it('refuses an installed writer ACL drift without revoking or repairing the unexpected grant', async () => fixture(async c => {
    await runAdminWechatRoutineUpgrade(c.f.db, c.target);
    await c.f.exec(`GRANT UPDATE(info) ON public.system_config TO ${pricingIdentifier(c.target.writer)}`);
    const before = await state(c);
    await expect(runAdminWechatRoutineUpgrade(c.f.db, c.target)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
  }), 180000);

  it('refuses an unknown Routine namespace function without repairing it or changing configuration', async () => fixture(async c => {
    await runAdminWechatRoutineUpgrade(c.f.db, c.target);
    await c.f.exec('CREATE FUNCTION public.cinashop_wechat_routine_unreviewed_v1() RETURNS integer LANGUAGE sql SECURITY INVOKER AS $$SELECT 1$$');
    try {
      const before = await state(c);
      expect(await inspectAdminWechatRoutineWriteCatalog(c.f.db)).toMatchObject({ present: true, ready: false, failures: expect.arrayContaining(['namespace']) });
      await expect(runAdminWechatRoutineUpgrade(c.f.db, c.target)).rejects.toThrow();
      expect(await state(c)).toEqual(before);
    } finally { await c.f.exec('DROP FUNCTION public.cinashop_wechat_routine_unreviewed_v1()'); }
    expect(await runAdminWechatRoutineUpgrade(c.f.db, c.target)).toMatchObject({ applied: false });
  }), 180000);

  it('refuses an uncommissioned writer with unrelated data access without repairing its authority', async () => fixture(async c => {
    await c.f.exec(`GRANT SELECT ON public.system_admin TO ${pricingIdentifier(c.target.writer)}`);
    const before = await state(c);
    await expect(runAdminWechatRoutineUpgrade(c.f.db, c.target)).rejects.toThrow();
    expect(await state(c)).toEqual(before);
    const [grant] = await c.f.db.execute<{ retained: boolean }>(sql`SELECT
      pg_catalog.has_table_privilege(${c.target.writer},'public.system_admin','SELECT') AS retained`);
    expect(grant.retained).toBe(true);
  }), 180000);

  it.each([731667,731666])('refuses a busy maintenance or credential namespace %s without changing grants', async gate => fixture(async c => {
    const before = await state(c);
    if (!c.f.withPeer) throw Error('Independent owned maintenance peer required');
    await c.f.withPeer(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${gate},0)`);
      await expect(runAdminWechatRoutineUpgrade(c.f.db, c.target)).rejects.toThrow();
      expect(await state(c)).toEqual(before);
    }));
    expect(await runAdminWechatRoutineUpgrade(c.f.db, c.target)).toMatchObject({ applied: true });
  }), 180000);

  it('retains all four real author read/save paths and ordinary generic DML after installing Routine guards', async () => fixture(async c => {
    const writers = await authors(c), routine = await configRows(c.f.db, true);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider call in config authors'));
    await runAdminWechatRoutineUpgrade(c.f.db, c.target);
    for (const writer of writers) {
      expect(await writer.save()).toMatchObject({ state: 'committed', replayed: false });
      expect((await c.f.db.select().from(systemConfig).where(eq(systemConfig.menuName, writer.key)))[0].value).toBe(writer.raw);
      expect(await configRows(c.f.db, true)).toEqual(routine);
    }
    await c.admin.exec("INSERT INTO public.system_config(menu_name,value) VALUES('owned_routine_ordinary','ordinary')");
    await c.admin.exec("UPDATE public.system_config SET value='ordinary changed' WHERE menu_name='owned_routine_ordinary'");
    expect((await c.f.db.select().from(systemConfig).where(eq(systemConfig.menuName, 'owned_routine_ordinary')))[0].value).toBe('ordinary changed');
    expect(await c.admin.exec('SELECT * FROM public.admin_wechat_routine_operation')).toEqual([]);
    expect(network).not.toHaveBeenCalled(); await audits(c);
  }), 180000);

  it('keeps every author closed for an unknown config trigger, then recovers only after reviewed removal', async () => fixture(async c => {
    const writers = await authors(c);
    await runAdminWechatRoutineUpgrade(c.f.db, c.target);
    await c.f.exec(`CREATE FUNCTION public.owned_routine_unknown_guard() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER owned_routine_unknown_trigger BEFORE INSERT OR UPDATE ON public.system_config
FOR EACH ROW EXECUTE FUNCTION public.owned_routine_unknown_guard()`);
    try {
      const before = await configRows(c.f.db), receipts = await authorReceipts(c);
      for (const writer of writers) {
        await expect(writer.save()).rejects.toMatchObject({ code: 503 });
        expect(await configRows(c.f.db)).toEqual(before);
        expect(await authorReceipts(c)).toEqual(receipts);
      }
    } finally { await c.f.exec('DROP TRIGGER owned_routine_unknown_trigger ON public.system_config; DROP FUNCTION public.owned_routine_unknown_guard()'); }
    for (const writer of writers) expect(await writer.save()).toMatchObject({ state: 'committed' });
  }), 180000);

  it('coexists with all five actual LOGIN profiles only with the complete explicit local, gift-peer and App-reader declarations', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in maintenance peer coexistence'));
    const f = await customerCashierRuntimeHttpFixture();
    try {
      // This factory records the newly created role's OID and removes it before
      // all earlier roles in close(); the installer never creates this role.
      const writer = await f.createOwnedRole('routine_writer');
      const target = { ...f.target, writer: writer.role };
      const snapshot = async () => {
        const [row] = await f.maintenanceDb.execute(sql`SELECT jsonb_build_object(
          'relations',(SELECT jsonb_agg(jsonb_build_array(oid::text,relname,relowner::text,relacl::text) ORDER BY oid)
            FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace),
          'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid::text,a.attnum,a.attacl::text) ORDER BY a.attrelid,a.attnum)
            FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
            WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL),
          'routines',(SELECT jsonb_agg(jsonb_build_array(oid::text,proname,proowner::text,proacl::text,prosrc,proconfig) ORDER BY oid)
            FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace),
          'writer',(SELECT jsonb_build_array(oid::text,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls)
            FROM pg_catalog.pg_roles WHERE rolname=${writer.role})) AS state`);
        return row.state;
      };
      const before = await snapshot(), config = await configRows(f.maintenanceDb), business = await f.facts();
      // Omitting either declaration must not turn the mature multi-principal
      // database into a reduced two-role proof or repair its existing grants.
      await expect(runAdminWechatRoutineUpgrade(f.maintenanceDb, target, undefined, f.appReaders)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(runAdminWechatRoutineUpgrade(f.maintenanceDb, target, f.peers)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      await expect(runAdminWechatRoutineUpgrade(f.maintenanceDb, { ...target, local: [] }, f.peers, f.appReaders)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await f.facts()).toEqual(business);
      if (!target.local?.length || !target.caseLock?.runtimeRoles.length)
        throw Error('Complete local and case-lock fixture required');
      const callerTarget = { ...target, local: [...target.local],
        caseLock: { ...target.caseLock, runtimeRoles: [...target.caseLock.runtimeRoles] } };
      const callerPeers = structuredClone(f.peers), callerReader = structuredClone(f.appReaders);
      // The public API must capture before asynchronous BEGIN. Mutate only
      // caller-owned copies immediately after obtaining its actual DB promise.
      const pending = runAdminWechatRoutineUpgrade(f.maintenanceDb, callerTarget, callerPeers, callerReader);
      callerTarget.writer = 'routine_changed_' + randomUUID().replaceAll('-', '');
      callerTarget.local.splice(0); callerTarget.caseLock.runtimeRoles.splice(0);
      callerPeers.target.admin = writer.role; callerPeers.target.local = [];
      expect(Reflect.set(callerReader, 'cashierOrigin', false)).toBe(true);
      const installed = await pending;
      expect(installed).toMatchObject({ operation: 'admin-wechat-routine-author-v1', applied: true,
        binding: { admin: f.adminRuntime.role, writer: writer.role } });
      const after = await snapshot();
      expect(await runAdminWechatRoutineUpgrade(f.maintenanceDb, target, f.peers, f.appReaders)).toEqual({ ...installed, applied: false });
      expect(await snapshot()).toEqual(after); expect(await configRows(f.maintenanceDb)).toEqual(config);
      const proofs = [
        await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders),
        await auditRuntimeBusinessPrivileges(f.adminRuntime.db, 'admin', f.target, undefined, f.peers),
        await auditCustomerFinancialRuntimePrivileges(f.financialRuntime.db, f.target, f.manual, f.readers),
        await auditManagerRuntimePrivileges(f.managerRuntime.db, f.target),
        await auditCustomerCashierSecondCardRuntimePrivileges(f.cashierRuntime.db, f.cashierRuntime.role, f.target,
          { abandon: true, conditionalGuards: true, formImages: true }),
      ];
      for (const proof of proofs) expect(proof).toMatchObject({ ready: true, failures: [], completeServiceCoverageVerified: false });
      const runtimes = [f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime];
      const pids: number[] = [];
      for (const runtime of runtimes) pids.push(await runtime.verify());
      expect(new Set(pids).size).toBe(5);
      await expect(f.adminRuntime.db.transaction(tx => assertAdminWechatRoutineOperationReady(tx))).resolves.toBeUndefined();
      for (const runtime of [f.appRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime]) {
        await expect(runtime.db.execute(sql`SELECT * FROM public.admin_wechat_routine_operation LIMIT 0`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(runtime.db.execute(sql`SELECT public.cinashop_admin_wechat_routine_write_v1(
          NULL::uuid,NULL::integer,NULL::text,NULL::text,NULL::text,NULL::text,NULL::jsonb)`))
          .rejects.toMatchObject({ cause: { code: '42501' } });
      }
      expect(await f.adminRuntime.db.execute(sql`SELECT * FROM public.admin_wechat_routine_operation`)).toHaveLength(0);
      expect(await f.facts()).toEqual(business);
      expect(network).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 180000);
});
