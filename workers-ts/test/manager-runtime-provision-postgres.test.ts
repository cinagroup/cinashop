import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbFromConnectionString, type DbClient } from '../src/lib/di';
import { inspectManagerProvisionState, provisionManagerRuntime, type ManagerProvisionTarget } from '../src/migrations/provisionManagerRuntime';
import { MANAGER_RUNTIME_ROLE } from '../src/migrations/managerRuntimePrivilegePlan';
import { auditManagerRuntimePrivileges } from '../src/migrations/auditManagerRuntimePrivileges';
import { managerRuntimePrivilegeFixture } from './helpers/managerRuntimePrivilegeFixture';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';
const generatedPassword = () => Array.from(randomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');

// Fixed cluster-wide role: CI must run this file and the privilege fixture
// serially on a dedicated owned native PG16 cluster, never a production target.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('fixed Manager atomic commissioning on owned native PG16', () => {
  let f: Awaited<ReturnType<typeof managerRuntimePrivilegeFixture>>, target: ManagerProvisionTarget, password: string;
  const clients: DbClient[] = [];
  beforeEach(async () => {
    validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    f = await managerRuntimePrivilegeFixture();
    const [identity] = await f.db.execute(sql`SELECT current_database() AS database,current_user AS role`);
    target = { database: String(identity.database), maintenanceRole: String(identity.role) };
    password = generatedPassword();
  }, 180000);
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(db => db.$client.end({ timeout: 1 })));
    if (f) await f.close();
  }, 30000);
  const login = () => {
    const url = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    url.pathname = '/' + target.database; url.username = MANAGER_RUNTIME_ROLE; url.password = password;
    const db = createDbFromConnectionString(url.href, 1); clients.push(db); return db;
  };
  it('commits an exact restricted LOGIN, independently authenticates it, and refuses collisions without rotating credentials', async () => {
    const before = await inspectManagerProvisionState(f.db, target); expect(before.role).toBeNull(); expect(before.prerequisites?.ready).toBe(true);
    const result = await provisionManagerRuntime(f.db, password, target);
    await f.markManagerRoleOwned();
    expect(result).toMatchObject({ created: true, commissioned: true, role: { name: MANAGER_RUNTIME_ROLE, login: true, restricted: true, no_memberships: true, connection_limit: 15 }, privileges: { ready: true } });
    expect((await inspectManagerProvisionState(f.db, target)).ready).toBe(true);
    expect((await auditManagerRuntimePrivileges(login())).ready).toBe(true);
    const [hash] = await f.db.execute(sql`SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname=${MANAGER_RUNTIME_ROLE}`);
    expect(hash.scram).toBe(true);
    await expect(provisionManagerRuntime(f.db, generatedPassword(), target)).rejects.toThrow('outcome not confirmed');
    expect((await auditManagerRuntimePrivileges(login())).ready).toBe(true);
  });
  it('rolls back role creation and grants when the actual inherited PUBLIC authority fails the late exact ACL audit', async () => {
    await f.db.execute(sql`CREATE TABLE public.manager_provision_unreviewed(id integer)`);
    await f.db.execute(sql`GRANT SELECT ON public.manager_provision_unreviewed TO PUBLIC`);
    const expected = await f.db.execute(sql`SELECT oid,relowner,relacl::text FROM pg_class WHERE oid='public.manager_provision_unreviewed'::regclass`);
    await expect(provisionManagerRuntime(f.db, password, target)).rejects.toThrow('outcome not confirmed');
    expect((await inspectManagerProvisionState(f.db, target)).role).toBeNull();
    expect(await f.db.execute(sql`SELECT oid,relowner,relacl::text FROM pg_class WHERE oid='public.manager_provision_unreviewed'::regclass`)).toEqual(expected);
  });
  it('recovers a committed operation after caller reply loss by read-only inspection and the original independent credential', async () => {
    const ambiguous = { $client: f.db.$client, transaction: async (...args: Parameters<typeof f.db.transaction>) => {
      await f.db.transaction(...args); throw Error('synthetic reply lost after actual commit');
    } } as unknown as DbClient;
    await expect(provisionManagerRuntime(ambiguous, password, target)).rejects.toThrow('outcome not confirmed');
    expect((await inspectManagerProvisionState(f.db, target)).ready).toBe(true);
    await f.markManagerRoleOwned();
    expect((await auditManagerRuntimePrivileges(login())).ready).toBe(true);
  });
  it('refuses wrong maintenance identity and malformed credentials without creating the fixed role', async () => {
    await expect(provisionManagerRuntime(f.db, password, { ...target, database: 'wrong_database' })).rejects.toThrow('outcome not confirmed');
    for (const value of ['', 'short', "';RESET ROLE;--"]) await expect(provisionManagerRuntime(f.db, value, target)).rejects.toThrow('generated Manager credential');
    expect((await inspectManagerProvisionState(f.db, target)).role).toBeNull();
  });
  it('commissions the fixed legacy profile from read-only catalog evidence without installing an unused gift receipt', async () => {
    await f.exec('DROP TABLE public.store_order_promotion_gift_coupon_reward');
    const before = await inspectManagerProvisionState(f.db, target);
    expect(before.prerequisites).toMatchObject({ ready: true, profile: 'legacy-without-promotion-gift-receipt', presence: { ready: true } });
    expect((await provisionManagerRuntime(f.db, password, target)).privileges.ready).toBe(true); await f.markManagerRoleOwned();
    expect((await auditManagerRuntimePrivileges(login())).ready).toBe(true);
    const [presence] = await f.db.execute(sql`SELECT to_regclass('public.store_order_promotion_gift_coupon_reward') IS NULL
      AND to_regclass('public.store_order_promotion_gift_coupon_reward_id_seq') IS NULL AS absent`);
    expect(presence.absent).toBe(true);
  });
});
