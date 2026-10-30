/** Owned PG16 commissioning/ACL coexistence only. These cases use complete
 * source-declared Manager catalogs and actual restricted LOGIN connections;
 * they do not establish financial actor authorization or provider acceptance.
 * The fixed cluster role is serialized and removed only by the existing
 * fixture's recorded-OID cleanup. No inspector is mocked or replaced. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { auditRuntimeBusinessPrivileges, inspectRuntimeBusinessProfileInTransaction } from '@/migrations/auditRuntimeBusinessPrivileges';
import { auditManagerRuntimePrivileges, inspectManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';
import { MANAGER_RUNTIME_ROLE, managerRuntimeGrantSql } from '@/migrations/managerRuntimePrivilegePlan';
import { inspectOrderPromotionGiftReceiptCatalog } from '@/migrations/orderPromotionGiftReceipt';
import { runRuntimeBusinessCommissioning, type RuntimeCommissionTarget } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminWechatAppUpgrade } from '@/migrations/runAdminWechatAppUpgrade';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { managerRuntimePrivilegeFixture } from './helpers/managerRuntimePrivilegeFixture';
import { validateSequenceRunnerTestUrl } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof managerRuntimePrivilegeFixture>>;
type Peer = Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer: infer P) => unknown ? P : never;
type Context = { f: Fixture; app: Peer; admin: Peer; target: RuntimeCommissionTarget };
const gift = 'store_order_promotion_gift_coupon_reward';
const giftSequence = gift + '_id_seq';
const fixed = pricingIdentifier(MANAGER_RUNTIME_ROLE);

async function profiles(c: Context) {
  return c.f.db.transaction(async tx => ({
    app: await inspectRuntimeBusinessProfileInTransaction(tx, 'app', c.target, 'current'),
    admin: await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', c.target, 'current'),
  }), { isolationLevel: 'read committed', accessMode: 'read only' });
}
async function expectBaseReady(c: Context) {
  const result = await profiles(c);
  expect(result.app).toMatchObject({ ready: true, failures: [] });
  expect(result.admin).toMatchObject({ ready: true, failures: [] });
}
async function fixture(run: (c: Context) => Promise<void>) {
  const f = await managerRuntimePrivilegeFixture();
  try {
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.pricingOwner)
      throw Error('Owned native PG16 with independent App/Admin LOGINs required');
    const pricingOwner = f.pricingOwner;
    await f.withRuntimeRole(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute<{ database: string; maintenance: string }>(sql`
        SELECT current_database() AS database,current_user AS maintenance`);
      const target: RuntimeCommissionTarget = { database: identity.database, maintenance: identity.maintenance,
        pricingOwner, app: app.role, admin: admin.role };
      await runRuntimeBusinessCommissioning(f.db, target);
      const c: Context = { f, app, admin, target };
      await expectBaseReady(c);
      await run(c);
    }));
  } finally { await f.close(); }
}
async function createFixedManager(c: Context, complete = true, login = true) {
  await c.f.exec(`CREATE ROLE ${fixed} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  await c.f.markManagerRoleOwned();
  if (complete) {
    for (const statement of managerRuntimeGrantSql('current')) await c.f.exec(statement);
    expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: false })).toMatchObject({ ready: true, failures: [] });
  } else {
    await c.f.exec(`GRANT USAGE ON SCHEMA public TO ${fixed}; GRANT SELECT ON TABLE public.${pricingIdentifier(gift)} TO ${fixed}`);
  }
  const password = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  if (login) await c.f.exec(`ALTER ROLE ${fixed} LOGIN PASSWORD '${password}'`);
  return password;
}
async function withManagerLogin(c: Context, password: string, run: (db: DbClient) => Promise<void>) {
  const target = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
  target.pathname = '/' + c.f.database; target.username = MANAGER_RUNTIME_ROLE; target.password = password;
  const client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    const db = drizzle(client) as unknown as DbClient;
    const [identity] = await db.execute<{ role: string; session: string; pid: number; restricted: boolean }>(sql`
      SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AS restricted
      FROM pg_catalog.pg_roles WHERE rolname=current_user`);
    expect(identity).toMatchObject({ role: MANAGER_RUNTIME_ROLE, session: MANAGER_RUNTIME_ROLE, restricted: true });
    expect(identity.pid).not.toBe(c.app.pid); expect(identity.pid).not.toBe(c.admin.pid);
    expect(await auditManagerRuntimePrivileges(db)).toMatchObject({ ready: true, identity: {
      database: c.f.database, role: MANAGER_RUNTIME_ROLE, session: MANAGER_RUNTIME_ROLE, backend_role: MANAGER_RUNTIME_ROLE,
    } });
    await run(db);
  } finally { await client.end({ timeout: 5 }); }
}

/** Catalog-only snapshots bind refusal to no grant/revoke/repair. Password
 * verifiers are never read. Other databases' random roles are excluded. */
async function catalogState(c: Context, extraNames: readonly string[] = []) {
  const names = [...new Set([c.target.app, c.target.admin, MANAGER_RUNTIME_ROLE, ...extraNames])];
  const namesSql = sql.join(names.map(name => sql`${name}`), sql`, `);
  return {
    relations: await c.f.db.execute(sql`SELECT oid::text AS oid,relname,relkind,relowner::text AS owner,relacl::text AS acl,
      relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname,oid`),
    routines: await c.f.db.execute(sql`SELECT oid::text AS oid,proname,proowner::text AS owner,proacl::text AS acl,
      CASE WHEN prokind IN('f','p') THEN pg_catalog.pg_get_functiondef(oid) ELSE NULL END AS definition
      FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace ORDER BY oid`),
    constraints: await c.f.db.execute(sql`SELECT oid::text AS oid,conname,conrelid::text AS relation,
      pg_catalog.pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
      WHERE connamespace='public'::regnamespace ORDER BY oid`),
    roles: await c.f.db.execute(sql`SELECT oid::text AS oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
      rolinherit,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname IN (${namesSql}) ORDER BY rolname`),
    memberships: await c.f.db.execute(sql`SELECT a.roleid::text AS roleid,a.member::text AS member,a.grantor::text AS grantor,
      a.admin_option,a.inherit_option,a.set_option FROM pg_catalog.pg_auth_members a
      WHERE a.roleid IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${namesSql}))
         OR a.member IN(SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${namesSql})) ORDER BY a.roleid,a.member,a.grantor`),
  };
}
async function expectRejectedWithoutRepair(c: Context, extraNames: readonly string[] = []) {
  expect(await inspectOrderPromotionGiftReceiptCatalog(c.f.db, c.target.maintenance, c.target)).toMatchObject({ ready: false });
  const result = await profiles(c);
  expect(result.app.ready).toBe(false); expect(result.admin.ready).toBe(false);
  expect(result.app.failures).toContain('promotion_gift_receipt_catalog');
  expect(result.admin.failures).toContain('promotion_gift_receipt_catalog');
  const before = await catalogState(c, extraNames);
  await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).rejects.toThrow('exact existing runtime profiles');
  expect(await catalogState(c, extraNames)).toEqual(before);
  const [absent] = await c.f.db.execute(sql`SELECT to_regclass('public.admin_wechat_app_operation') IS NULL
    AND to_regclass('public.native_app_payment_account') IS NULL AND to_regclass('public.native_app_payment_evidence') IS NULL AS absent`);
  expect(absent).toEqual({ absent: true });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).sequential('Wechat App bundle coexists only with the exact commissioned manager on owned native PG16', () => {
  it('installs and rechecks the App bundle with no fixed manager and genuine App Admin LOGINs', async () => fixture(async c => {
    expect(await c.f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`)).toHaveLength(0);
    await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).resolves.toMatchObject({ applied: true });
    await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).resolves.toMatchObject({ applied: false });
    await expectBaseReady(c);
    expect(await auditRuntimeBusinessPrivileges(c.app.db, 'app', c.target)).toMatchObject({ ready: true, failures: [] });
    expect(await auditRuntimeBusinessPrivileges(c.admin.db, 'admin', c.target)).toMatchObject({ ready: true, failures: [] });
  }), 240_000);

  it('does not require a cluster role profile when that fixed name has no authority on this database gift objects', async () => fixture(async c => {
    // This proves absence of local gift authority, not deployment in a second
    // database. A cluster-wide role name alone must not create a prerequisite.
    await c.f.exec(`CREATE ROLE ${fixed} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await c.f.markManagerRoleOwned();
    expect((await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).ready).toBe(false);
    await expectBaseReady(c);
    await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).resolves.toMatchObject({ applied: true });
    await expectBaseReady(c);
    const [unchanged] = await c.f.db.execute(sql`SELECT has_table_privilege(${MANAGER_RUNTIME_ROLE},${'public.' + gift},'SELECT,INSERT') AS gift,
      has_sequence_privilege(${MANAGER_RUNTIME_ROLE},${'public.' + giftSequence},'USAGE,SELECT,UPDATE') AS sequence`);
    expect(unchanged).toEqual({ gift: false, sequence: false });
  }), 240_000);

  it('retains a complete fixed manager genuine LOGIN and both exact audits across applied and idempotent App upgrades', async () => fixture(async c => {
    const password = await createFixedManager(c);
    expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).toMatchObject({ ready: true, failures: [] });
    await expectBaseReady(c);
    await withManagerLogin(c, password, async db => {
      await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).resolves.toMatchObject({ applied: true });
      const installed = await catalogState(c);
      await expect(runAdminWechatAppUpgrade(c.f.db, c.target)).resolves.toMatchObject({ applied: false });
      expect(await catalogState(c)).toEqual(installed);
      await expectBaseReady(c);
      expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).toMatchObject({ ready: true, failures: [] });
      expect(await auditManagerRuntimePrivileges(db)).toMatchObject({ ready: true });
      expect(await auditRuntimeBusinessPrivileges(c.app.db, 'app', c.target)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(c.admin.db, 'admin', c.target)).toMatchObject({ ready: true, failures: [] });
      const [acl] = await db.execute(sql`SELECT has_table_privilege(current_user,${'public.' + gift},'SELECT') AS gift_read,
        has_table_privilege(current_user,${'public.' + gift},'INSERT') AS gift_insert,
        has_sequence_privilege(current_user,${'public.' + giftSequence},'USAGE') AS gift_sequence,
        has_any_column_privilege(current_user,'public.system_admin','UPDATE') AS staff_update,
        has_table_privilege(current_user,'public.native_app_payment_account','SELECT,INSERT') AS app_account,
        has_table_privilege(current_user,'public.native_app_payment_evidence','SELECT,INSERT') AS app_evidence`);
      expect(acl).toEqual({ gift_read: true, gift_insert: false, gift_sequence: false, staff_update: false,
        app_account: false, app_evidence: false });
    });
  }), 240_000);

  it('refuses an unknown random gift SELECT reader without adopting revoking or repairing its grant', async () => fixture(async c => {
    await c.f.withRuntimeRole!(async unknown => {
      await c.f.exec(`GRANT SELECT ON TABLE public.${pricingIdentifier(gift)} TO ${pricingIdentifier(unknown.role)}`);
      await expectRejectedWithoutRepair(c, [unknown.role]);
      const [retained] = await unknown.exec(`SELECT has_table_privilege(current_user,'public.${gift}','SELECT') AS read`);
      expect(retained).toEqual({ read: true });
    });
  }), 240_000);

  it('refuses the fixed name with only a partial profile and then a complete but NOLOGIN stage', async () => fixture(async c => {
    await createFixedManager(c, false, false);
    expect((await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).ready).toBe(false);
    await expectRejectedWithoutRepair(c);
    for (const statement of managerRuntimeGrantSql('current')) await c.f.exec(statement);
    expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: false })).toMatchObject({ ready: true, failures: [] });
    const loginRequired = await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true });
    expect(loginRequired.ready).toBe(false); expect(loginRequired.failures).toContain('login_stage');
    await expectRejectedWithoutRepair(c);
    const [retained] = await c.f.db.execute(sql`SELECT rolcanlogin AS login FROM pg_catalog.pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
    expect(retained).toEqual({ login: false });
  }), 240_000);

  it('rejects gift INSERT sequence USAGE or staff UPDATE added to the otherwise complete fixed LOGIN', async () => fixture(async c => {
    await createFixedManager(c);
    for (const [grant, revoke] of [
      [`GRANT INSERT ON TABLE public.${pricingIdentifier(gift)} TO ${fixed}`, `REVOKE INSERT ON TABLE public.${pricingIdentifier(gift)} FROM ${fixed}`],
      [`GRANT USAGE ON SEQUENCE public.${pricingIdentifier(giftSequence)} TO ${fixed}`, `REVOKE USAGE ON SEQUENCE public.${pricingIdentifier(giftSequence)} FROM ${fixed}`],
      [`GRANT UPDATE(pwd) ON TABLE public.system_admin TO ${fixed}`, `REVOKE UPDATE(pwd) ON TABLE public.system_admin FROM ${fixed}`],
    ]) {
      await c.f.exec(grant);
      expect((await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).ready).toBe(false);
      await expectRejectedWithoutRepair(c);
      await c.f.exec(revoke); // Explicit fixture restoration, never installer repair.
      expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).toMatchObject({ ready: true, failures: [] });
      await expectBaseReady(c);
    }
  }), 240_000);

  it('rejects a complete-looking fixed LOGIN missing one required manager capability grant', async () => fixture(async c => {
    await createFixedManager(c);
    await c.f.exec(`REVOKE EXECUTE ON FUNCTION public.manager_lock_carrier_v1(text) FROM ${fixed}`);
    const invalid = await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true });
    expect(invalid.ready).toBe(false); expect(invalid.failures).toContain('missing_lock_execute');
    await expectRejectedWithoutRepair(c);
  }), 240_000);

  it('rejects membership and manager catalog drift while retaining strict unknown-role rules', async () => fixture(async c => {
    await createFixedManager(c);
    await c.f.withRuntimeRole!(async member => {
      await c.f.exec(`GRANT ${pricingIdentifier(member.role)} TO ${fixed}`);
      const invalid = await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true });
      expect(invalid.ready).toBe(false); expect(invalid.failures).toContain('no_memberships');
      await expectRejectedWithoutRepair(c, [member.role]);
      await c.f.exec(`REVOKE ${pricingIdentifier(member.role)} FROM ${fixed}`);
    });
    expect(await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true })).toMatchObject({ ready: true, failures: [] });
    await c.f.exec('ALTER TABLE public.manager_order_operation_request DROP CONSTRAINT mor_kind_ck');
    const invalid = await inspectManagerRuntimePrivileges(c.f.db, { requireLogin: true });
    expect(invalid.ready).toBe(false); expect(invalid.failures).toContain('manager_operation_catalog');
    await expectRejectedWithoutRepair(c);
  }), 240_000);
});
