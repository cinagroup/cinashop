import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { legacyCategory, storeProductLabel, systemAdmin, systemMenus, systemRole, systemSupplier } from '@/models/schema';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminProductLabelUpgrade } from '@/migrations/runAdminProductLabelUpgrade';
import { inspectAdminProductLabelOperation, inspectProductLabelAuxiliaryRead } from '@/migrations/adminProductLabelOperation';
import {
  installSupplierProductLabelUpgradeInTransaction, runSupplierProductLabelUpgrade,
} from '@/migrations/runSupplierProductLabelUpgrade';
import {
  assertSupplierProductLabelCapabilityReady, inspectSupplierProductLabelCapability, inspectSupplierProductLabelOwner,
  SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE, supplierProductLabelCapabilityBody,
  type SupplierProductLabelCapabilityTarget,
} from '@/migrations/supplierProductLabelCapability';
import { SupplierProductLabelService, type SupplierProductLabelActor } from '@/services/supplier/SupplierProductLabelService';
import { md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import type { SequenceRunnerPeer } from './helpers/checkoutPricingMigrationDatabase';

type Whole = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Login = SequenceRunnerPeer & { role: string; connectionString: string };
type Scenario = { whole: Whole; app: Login; admin: Login; target: SupplierProductLabelCapabilityTarget };
const ids = { supplier: 1_900_020, actor: 1_900_021, role: 1_900_021, secondRole: 1_900_022, menu: 1_900_031, group: 1_900_041, label: 1_900_051 };
const password = 'owned-supplier-label-capability-password';
const actor = (): SupplierProductLabelActor => ({ id: ids.actor, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const signature = SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE;
const rollback = new Error('Owned Supplier label capability test rollback');

function causes(error: unknown): string[] {
  const result: string[] = [];
  for (let i = 0; i < 8 && error && typeof error === 'object'; i++) {
    if ('code' in error) result.push(String(error.code));
    error = 'cause' in error ? error.cause : null;
  }
  return result;
}
async function failure(task: Promise<unknown>): Promise<unknown> {
  try { await task; } catch (error) { return error; }
  throw Error('Expected actual SQL or service rejection did not occur');
}
async function audits(s: Scenario) {
  return { app: await auditRuntimeBusinessPrivileges(s.app.db, 'app', s.target), admin: await auditRuntimeBusinessPrivileges(s.admin.db, 'admin', s.target) };
}
async function seed(s: Scenario) {
  await s.whole.db.insert(systemSupplier).values({ id: ids.supplier, adminId: ids.actor + 100, supplierName: 'Owned capability supplier' });
  await s.whole.db.insert(systemAdmin).values({ id: ids.actor, account: 'owned_supplier_label_cap', pwd: password,
    adminType: 4, relationId: ids.supplier, roles: String(ids.role), level: 1 });
  await s.whole.db.insert(systemRole).values([
    { id: ids.role, type: 4, relationId: ids.supplier, roleName: 'Owned capability writer', rules: 'supplier.product.manage' },
    { id: ids.secondRole, type: 4, relationId: ids.supplier, roleName: 'Owned second role', rules: '', status: 0 },
  ]);
  await s.whole.db.insert(systemMenus).values({ id: ids.menu, type: 4, authType: 2, access: 1, isDel: 0,
    methods: 'POST', apiUrl: 'product/label/0', menuName: 'Owned numeric writer' });
  await s.whole.db.insert(legacyCategory).values({ id: ids.group, type: 0, relationId: 0, ownerId: 0, group: 2, name: '能力验证平台组' });
  await s.whole.exec("SELECT setval(pg_get_serial_sequence('public.store_product_label','id'),(SELECT coalesce(max(id),0)+1 FROM public.store_product_label),false)");
}

/** Each case owns an actual complete migrated database and distinct current
 * App/Admin LOGINs. Only this fixture creates the empty NOLOGIN owner. */
async function withCurrent<T>(installed: boolean, run: (scenario: Scenario) => Promise<T>): Promise<T> {
  const whole = await refundRuntimeFixture();
  try {
    if (!whole.withRuntimeRole) throw Error('Actual independent current App/Admin LOGINs are required');
    return await whole.withRuntimeRole(async app => whole.withRuntimeRole!(async admin => {
      const [identity] = await whole.db.execute(sql`SELECT current_database() AS database,current_user AS maintenance`);
      const owner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
      const target = { database: String(identity.database), maintenance: String(identity.maintenance), app: app.role, admin: admin.role, owner };
      await runRuntimeBusinessCommissioning(whole.db, { ...target, pricingOwner: whole.pricingOwner });
      await whole.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      try {
        const s = { whole, app, admin, target };
        expect(await audits(s)).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
        for (const peer of [app, admin]) {
          const [login] = await peer.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num')::integer/10000 AS version");
          expect(login).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, version: 16 });
        }
        expect(app.pid).not.toBe(admin.pid);
        if (installed) expect(await runSupplierProductLabelUpgrade(whole.db, target)).toEqual({ operation: 'supplier-product-label-capability-v1', applied: true });
        await seed(s);
        return await run(s);
      } finally {
        await whole.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
        expect(await whole.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${owner}`)).toEqual([]);
      }
    }));
  } finally { await whole.close(); }
}

function interruptedAfterFinalGrant(db: DbClient, app: string, trace: { reached: boolean; installedInsideTransaction: boolean }): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, { get(target, key) {
    const member: unknown = Reflect.get(target, key);
    if (typeof member !== 'function') return member;
    if (key !== 'transaction') return member.bind(target);
    return (callback: (tx: Pick<DbClient, 'execute'>) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      const port = new Proxy(tx, { get(current, property) {
        const method: unknown = Reflect.get(current, property);
        if (typeof method !== 'function') return method;
        if (property !== 'execute') return method.bind(current);
        return async (query: Parameters<typeof tx.execute>[0]) => {
          const text = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql;
          const result = await tx.execute(query);
          if (text === `GRANT EXECUTE ON FUNCTION ${signature} TO "${app}"`) {
            trace.reached = true;
            const state = await inspectSupplierProductLabelCapability(tx);
            trace.installedInsideTransaction = state.ready;
            throw Error('Owned interruption after actual Supplier label final GRANT');
          }
          return result;
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

async function dataSnapshot(s: Scenario) {
  const snapshot: Record<string, unknown> = {};
  for (const table of ['store_product_label', 'store_product_label_auxiliary', 'store_product_relation', 'system_log', 'system_admin', 'system_supplier', 'system_role', 'system_menus', 'category']) {
    snapshot[table] = await s.whole.exec(`SELECT to_jsonb(t) AS row,xmin::text AS version FROM public."${table}" t ORDER BY to_jsonb(t)::text`);
  }
  return snapshot;
}

async function rawCall(db: Pick<DbClient, 'execute'>, context: unknown, name: string, operation = 'create', id = 0, expected: unknown = null, payload?: unknown) {
  const contextJson = context === undefined ? null : JSON.stringify(context);
  const payloadJson = JSON.stringify(payload === undefined ? { label_cate: ids.group, label_name: name } : payload);
  const [result] = await db.execute(sql`SELECT public.supplier_product_label_mutate_v1(${contextJson}::jsonb,${operation},${id},${JSON.stringify(expected)}::jsonb,${payloadJson}::jsonb) AS mutation`);
  return result?.mutation;
}
const contextFor = (a = actor()) => ({ actor_id: a.id, supplier_id: ids.supplier, auth_version: a.authVersion, expires_at: a.expiresAt });

/** Always rolls back successful direct calls as well as denied ones. A failed
 * PostgreSQL transaction is never reused for the next permission vector. */
async function sqlPermissionProbe(s: Scenario, context: unknown, name: string) {
  let allowed = false, error: unknown;
  try {
    await s.app.db.transaction(async tx => {
      const result = await rawCall(tx, context, name);
      expect(result).toMatchObject({ row: { type: 2, relation_id: ids.supplier, label_name: name }, audit_id: expect.any(Number) });
      allowed = true;
      throw rollback;
    }, { isolationLevel: 'read committed', accessMode: 'read write' });
  } catch (caught) { if (caught !== rollback) error = caught; }
  if (allowed && error) throw error;
  return { allowed, error };
}
async function tsPermissionProbe(s: Scenario, a = actor()) {
  try {
    await s.app.db.transaction(tx => SupplierProductLabelService.assertAuthority(tx as unknown as DbClient, ids.supplier, a, 'POST', '/supplierapi/product/label/0'));
    return true;
  } catch { return false; }
}

type MenuVector = { method: string; api: string; allowed: boolean };
// These are actual stored numeric-menu methods. In particular the mature menu
// resolver trims " post " before passing it to requiredSupplierPermissions.
const menuVectors: readonly MenuVector[] = [
  { method: 'GET', api: 'product/label/form', allowed: false },
  { method: 'HEAD', api: 'product/label/catalog', allowed: false },
  { method: 'POST', api: 'product/label/0', allowed: true },
  { method: 'POST', api: '/supplierapi/product/label/:id', allowed: true },
  { method: 'DELETE', api: 'product/label/<id>', allowed: true },
  { method: 'PUT', api: 'product/label/201', allowed: false },
  { method: 'POST', api: 'product/label/catalog', allowed: false },
  { method: 'POST', api: 'product/label/catalog/1', allowed: false },
  { method: 'PATCH', api: 'product/label/201', allowed: false },
  { method: 'POST', api: 'product/product/copy/1', allowed: true },
  { method: 'POST', api: 'product/product/copy/0', allowed: false },
  { method: 'POST', api: 'product/product/copy_operations/uuid/resolve', allowed: false },
  { method: 'GET', api: 'product/product/copy/1', allowed: false },
  { method: 'DELETE', api: 'product/product/thorough/1', allowed: true },
  { method: 'POST', api: 'product/product/thorough/1', allowed: false },
  { method: 'POST', api: 'product/type_header/1', allowed: false },
  { method: 'POST', api: 'product/product/rule/0', allowed: true },
  { method: 'DELETE', api: 'product/product/rule/delete/<id>', allowed: true },
  { method: 'POST', api: 'product/product/rule/delete/1', allowed: false },
  { method: 'POST', api: 'product/product/get_rule', allowed: false },
  { method: 'POST', api: 'product/batch_process', allowed: true },
  { method: 'POST', api: 'product/batch_process/1', allowed: false },
  { method: 'POST', api: 'product/product/batch-selection', allowed: false },
  { method: 'POST', api: 'product/category', allowed: true },
  { method: 'PUT', api: 'product/category/:id', allowed: true },
  { method: 'DELETE', api: 'product/category/1', allowed: true },
  { method: 'PUT', api: 'product/category/set_show/1/1', allowed: true },
  { method: 'POST', api: 'product/category/set_show/1/1', allowed: false },
  { method: 'PUT', api: 'product/category/create', allowed: false },
  { method: 'POST', api: 'form/product', allowed: true },
  { method: 'GET', api: 'form/product', allowed: false },
  { method: 'POST', api: 'product/unregistered-literal', allowed: true },
  { method: 'POST', api: 'product/*', allowed: true },
  { method: 'POST', api: 'order/print/1', allowed: false },
  { method: 'POST', api: 'supplierapi/product/label/0', allowed: false },
  { method: ' post ', api: 'product/label/0', allowed: true },
];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier label capability exact current PG16 installation and authority facts', () => {
  it('composes the sole Admin auxiliary reader with only the exact reviewed Supplier NOLOGIN owner and rejects foreign or drifted reads', async () => {
    noNetwork();
    await withCurrent(false, async s => {
      await runAdminProductLabelUpgrade(s.whole.db, s.target);
      expect(await inspectAdminProductLabelOperation(s.whole.db, s.target)).toBe(true);
      expect(await runSupplierProductLabelUpgrade(s.whole.db, s.target)).toEqual({ operation: 'supplier-product-label-capability-v1', applied: true });
      expect(await runSupplierProductLabelUpgrade(s.whole.db, s.target)).toEqual({ operation: 'supplier-product-label-capability-v1', applied: false });
      expect(await inspectAdminProductLabelOperation(s.admin.db, s.target)).toBe(true);
      expect(await audits(s)).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
      for (const statement of [
        `GRANT SELECT(label_id) ON public.store_product_label_auxiliary TO "${s.app.role}"`,
        `GRANT SELECT(product_id) ON public.store_product_label_auxiliary TO "${s.target.owner}"`,
        `GRANT SELECT ON public.store_product_label_auxiliary TO "${s.target.owner}"`,
        `ALTER FUNCTION ${signature} SECURITY INVOKER`,
      ]) {
        await expect(s.whole.db.transaction(async tx => {
          await tx.execute(sql.raw(statement));
          expect((await inspectSupplierProductLabelCapability(tx, s.target)).ready).toBe(false);
          expect(await inspectProductLabelAuxiliaryRead(tx)).toBe(false);
          expect(await inspectAdminProductLabelOperation(tx, s.target)).toBe(false);
          throw rollback;
        })).rejects.toBe(rollback);
        expect(await inspectAdminProductLabelOperation(s.admin.db, s.target)).toBe(true);
      }
      await expect(s.app.exec('SELECT label_id FROM public.store_product_label_auxiliary LIMIT 0')).rejects.toMatchObject({ code: '42501' });
      await expect(s.admin.exec('SELECT product_id FROM public.store_product_label_auxiliary LIMIT 0')).rejects.toMatchObject({ code: '42501' });
    });
  }, 240000);
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  const noNetwork = () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned Supplier label capability fixture forbids outbound I/O'));

  it('rolls back the actual final App EXECUTE grant and empty owner, then installs and replays without changing either current profile', async () => {
    noNetwork();
    await withCurrent(false, async s => {
      const before = await audits(s), trace = { reached: false, installedInsideTransaction: false };
      expect(await inspectSupplierProductLabelOwner(s.whole.db, s.target.owner, false)).toBe(true);
      await expect(runSupplierProductLabelUpgrade(interruptedAfterFinalGrant(s.whole.db, s.app.role, trace), s.target)).rejects.toThrow('Owned interruption after actual Supplier label final GRANT');
      expect(trace).toEqual({ reached: true, installedInsideTransaction: true });
      expect(await inspectSupplierProductLabelCapability(s.whole.db, s.target)).toMatchObject({ absent: true, ready: false });
      expect(await inspectSupplierProductLabelOwner(s.whole.db, s.target.owner, false)).toBe(true);
      expect(await audits(s)).toEqual(before);
      expect(await s.whole.db.execute(sql`SELECT to_regprocedure(${signature}) IS NULL AS absent`)).toEqual([{ absent: true }]);
      expect(await runSupplierProductLabelUpgrade(s.whole.db, s.target)).toEqual({ operation: 'supplier-product-label-capability-v1', applied: true });
      const installed = await inspectSupplierProductLabelCapability(s.whole.db, s.target);
      expect(installed).toMatchObject({ absent: false, ready: true, appRole: s.app.role, ownerRole: s.target.owner });
      expect(await runSupplierProductLabelUpgrade(s.whole.db, s.target)).toEqual({ operation: 'supplier-product-label-capability-v1', applied: false });
      expect(await inspectSupplierProductLabelCapability(s.whole.db, s.target)).toEqual(installed);
      expect(await audits(s)).toEqual(before);
      await s.app.db.transaction(tx => assertSupplierProductLabelCapabilityReady(tx));
      const [acl] = await s.app.exec(`SELECT has_function_privilege(current_user,${literal(signature)},'EXECUTE') AS execute,
        has_table_privilege(current_user,'public.store_product_label','INSERT,UPDATE,DELETE') AS label_dml,
        has_any_column_privilege(current_user,'public.store_product_label_auxiliary','SELECT') AS aux_read,
        has_sequence_privilege(current_user,'public.store_product_label_id_seq','USAGE,SELECT,UPDATE') AS sequence`);
      expect(acl).toEqual({ execute: true, label_dml: false, aux_read: false, sequence: false });
      expect((await s.admin.exec(`SELECT has_function_privilege(current_user,${literal(signature)},'EXECUTE') AS execute`))[0]).toEqual({ execute: false });
    });
  }, 240000);

  it('rejects exact catalog owner body ACL default and runtime privilege drift without repairing or retaining any drift', async () => {
    noNetwork();
    await withCurrent(true, async s => {
      const initial = await inspectSupplierProductLabelCapability(s.whole.db, s.target);
      const drifts = [
        { title: 'body', sql: `CREATE OR REPLACE FUNCTION public.supplier_product_label_mutate_v1(p_context jsonb,p_operation text,p_id integer,p_expected jsonb,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $owned_drift$${supplierProductLabelCapabilityBody(s.app.role)}\n-- Owned body drift\n$owned_drift$` },
        { title: 'search path', sql: `ALTER FUNCTION ${signature} SET search_path=public,pg_temp` },
        { title: 'volatility', sql: `ALTER FUNCTION ${signature} STABLE` },
        { title: 'owner', sql: `ALTER FUNCTION ${signature} OWNER TO "${s.target.maintenance}"` },
        { title: 'schema', sql: `CREATE SCHEMA owned_supplier_label_drift; ALTER FUNCTION ${signature} SET SCHEMA owned_supplier_label_drift` },
        { title: 'overload', sql: 'CREATE FUNCTION public.supplier_product_label_mutate_v1(jsonb) RETURNS jsonb LANGUAGE sql AS $$SELECT $1$$' },
        { title: 'PUBLIC execute', sql: `GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC` },
        { title: 'Admin execute', sql: `GRANT EXECUTE ON FUNCTION ${signature} TO "${s.admin.role}"` },
        { title: 'App grant option', sql: `GRANT EXECUTE ON FUNCTION ${signature} TO "${s.app.role}" WITH GRANT OPTION` },
        { title: 'owner extra column', sql: `GRANT UPDATE(icon) ON public.store_product_label TO "${s.target.owner}"` },
        { title: 'owner auxiliary table read', sql: `GRANT SELECT ON public.store_product_label_auxiliary TO "${s.target.owner}"` },
        { title: 'owner LOGIN', sql: `ALTER ROLE "${s.target.owner}" LOGIN` },
        { title: 'label extra column', sql: 'ALTER TABLE public.store_product_label ADD COLUMN owned_forbidden integer' },
        { title: 'label integer type', sql: 'ALTER TABLE public.store_product_label ALTER COLUMN sort TYPE bigint' },
        { title: 'serial default', sql: 'ALTER TABLE public.store_product_label ALTER COLUMN id SET DEFAULT 0' },
      ];
      for (const drift of drifts) {
        const error = await failure(s.whole.db.transaction(async tx => {
          await tx.execute(sql.raw(drift.sql));
          const unsafe = await inspectSupplierProductLabelCapability(tx, s.target);
          expect(unsafe.ready, drift.title).toBe(false);
          await tx.execute(sql.raw('SAVEPOINT owned_rejected_install'));
          let rejected = false;
          try { await installSupplierProductLabelUpgradeInTransaction(tx, s.target); } catch { rejected = true; }
          await tx.execute(sql.raw('ROLLBACK TO SAVEPOINT owned_rejected_install'));
          await tx.execute(sql.raw('RELEASE SAVEPOINT owned_rejected_install'));
          expect(rejected, drift.title).toBe(true);
          expect(await inspectSupplierProductLabelCapability(tx, s.target), drift.title).toEqual(unsafe);
          throw rollback;
        }));
        expect(error, drift.title).toBe(rollback);
        expect(await inspectSupplierProductLabelCapability(s.whole.db, s.target), drift.title).toEqual(initial);
      }
      // Committed drift is confined to this owned test DB so the genuinely
      // separate App LOGIN observes it. Revoke exactly the injected privilege
      // in finally; requests/installer must fail rather than silently repair it.
      for (const drift of [
        { grant: `GRANT INSERT ON public.store_product_label TO "${s.app.role}"`, revoke: `REVOKE INSERT ON public.store_product_label FROM "${s.app.role}"` },
        { grant: `GRANT SELECT ON public.store_product_label_auxiliary TO "${s.app.role}"`, revoke: `REVOKE SELECT ON public.store_product_label_auxiliary FROM "${s.app.role}"` },
        { grant: `GRANT UPDATE(icon) ON public.store_product_label TO "${s.target.owner}"`, revoke: `REVOKE UPDATE(icon) ON public.store_product_label FROM "${s.target.owner}"` },
      ]) {
        const before = await dataSnapshot(s);
        await s.whole.exec(drift.grant);
        try {
          expect((await inspectSupplierProductLabelCapability(s.app.db)).ready).toBe(false);
          await expect(s.app.db.transaction(tx => assertSupplierProductLabelCapabilityReady(tx))).rejects.toMatchObject({ code: 503 });
          await expect(new SupplierProductLabelService(createContainerFromDb(s.app.db)).save(ids.supplier, 0, { label_cate: ids.group, label_name: '漂移不写入' }, actor())).rejects.toMatchObject({ code: 503 });
          await expect(runSupplierProductLabelUpgrade(s.whole.db, s.target)).rejects.toThrow();
          expect((await inspectSupplierProductLabelCapability(s.whole.db, s.target)).ready).toBe(false);
          expect(await dataSnapshot(s)).toEqual(before);
        } finally { await s.whole.exec(drift.revoke); }
        expect(await inspectSupplierProductLabelCapability(s.whole.db, s.target)).toEqual(initial);
      }
      expect(await audits(s)).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
    });
  }, 240000);

  it('matches the genuine TS write authority for all 36 numeric-menu method and closed-route vectors', async () => {
    noNetwork();
    await withCurrent(true, async s => {
      expect(menuVectors).toHaveLength(36);
      await s.whole.db.update(systemRole).set({ rules: String(ids.menu) }).where(eq(systemRole.id, ids.role));
      const before = await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_label t ORDER BY id');
      const logs = await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.system_log t ORDER BY id');
      for (const [index, vector] of menuVectors.entries()) {
        await s.whole.db.update(systemMenus).set({ methods: vector.method, apiUrl: vector.api }).where(eq(systemMenus.id, ids.menu));
        const label = `V${index}真实菜单`;
        const tsAllowed = await tsPermissionProbe(s), actual = await sqlPermissionProbe(s, contextFor(), label);
        const identity = `${index}: ${JSON.stringify(vector)}`;
        expect(tsAllowed, identity).toBe(vector.allowed);
        expect(actual.allowed, identity).toBe(tsAllowed);
        if (!actual.allowed) expect(causes(actual.error), identity).toContain('P2104');
      }
      expect(await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_label t ORDER BY id')).toEqual(before);
      expect(await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.system_log t ORDER BY id')).toEqual(logs);
    });
  }, 240000);

  it('matches live primary canonical role and menu bounds while rejecting NULL and forged context without label or audit effects', async () => {
    noNetwork();
    await withCurrent(true, async s => {
      const vectors: Array<{ title: string; allowed: boolean; statements?: string[]; claims?: Partial<SupplierProductLabelActor> }> = [
        { title: 'primary bypasses malformed roles', allowed: true, statements: [`UPDATE system_supplier SET admin_id=${ids.actor} WHERE id=${ids.supplier}`, `UPDATE system_admin SET roles='not-a-role' WHERE id=${ids.actor}`] },
        { title: 'exact canonical manage', allowed: true },
        { title: 'view alone', allowed: false, statements: [`UPDATE system_role SET rules='supplier.product.view' WHERE id=${ids.role}`] },
        { title: 'wildcard does not expand', allowed: false, statements: [`UPDATE system_role SET rules='supplier.product.*,*' WHERE id=${ids.role}`] },
        { title: 'stable keys remain case sensitive', allowed: false, statements: [`UPDATE system_role SET rules='SUPPLIER.PRODUCT.MANAGE' WHERE id=${ids.role}`] },
        { title: 'disabled role', allowed: false, statements: [`UPDATE system_role SET status=0 WHERE id=${ids.role}`] },
        { title: 'missing role', allowed: false, statements: [`UPDATE system_admin SET roles='2147483647' WHERE id=${ids.actor}`] },
        { title: 'foreign role', allowed: false, statements: [`UPDATE system_role SET relation_id=7 WHERE id=${ids.role}`] },
        { title: 'non Supplier role', allowed: false, statements: [`UPDATE system_role SET type=1 WHERE id=${ids.role}`] },
        { title: 'role leading zero', allowed: false, statements: [`UPDATE system_admin SET roles='0${ids.role}' WHERE id=${ids.actor}`] },
        { title: 'role zero', allowed: false, statements: [`UPDATE system_admin SET roles='0' WHERE id=${ids.actor}`] },
        { title: 'role above int32', allowed: false, statements: [`UPDATE system_admin SET roles='2147483648' WHERE id=${ids.actor}`] },
        { title: 'overlong positive role', allowed: false, statements: [`UPDATE system_admin SET roles='999999999999999999999999' WHERE id=${ids.actor}`] },
        { title: 'ECMAScript Unicode trim', allowed: true, statements: [`UPDATE system_admin SET roles=${literal(`\u00a0\ufeff${ids.role}\u3000`)} WHERE id=${ids.actor}`, `UPDATE system_role SET rules=${literal('\ufeffsupplier.product.manage\u2029')} WHERE id=${ids.role}`] },
        { title: 'noncanonical menu zeros ignored', allowed: true, statements: [`UPDATE system_role SET rules='0,0000000000000000000000,001,supplier.product.manage' WHERE id=${ids.role}`] },
        { title: 'disabled role canonical overflowing menu still fails write precheck', allowed: false, statements: [`UPDATE system_admin SET roles='${ids.role},${ids.secondRole}' WHERE id=${ids.actor}`, `UPDATE system_role SET rules='2147483648',status=0 WHERE id=${ids.secondRole}`] },
        { title: 'disabled unknown rule overflow remains ineffective', allowed: true, statements: [`UPDATE system_admin SET roles='${ids.role},${ids.secondRole}' WHERE id=${ids.actor}`, `UPDATE system_role SET rules=${literal(Array.from({ length: 600 }, (_, n) => `ignored.${n}`).join(','))},status=0 WHERE id=${ids.secondRole}`] },
        { title: 'active distinct rule count overflow', allowed: false, statements: [`UPDATE system_role SET rules=${literal(['supplier.product.manage', ...Array.from({ length: 512 }, (_, n) => `ignored.${n}`)].join(','))} WHERE id=${ids.role}`] },
        { title: 'global active union overflow', allowed: false, statements: [`UPDATE system_admin SET roles='${ids.role},${ids.secondRole}' WHERE id=${ids.actor}`, `UPDATE system_role SET rules=${literal(['supplier.product.manage', ...Array.from({ length: 255 }, (_, n) => `first.${n}`)].join(','))} WHERE id=${ids.role}`, `UPDATE system_role SET rules=${literal(Array.from({ length: 257 }, (_, n) => `second.${n}`).join(','))},status=1 WHERE id=${ids.secondRole}`] },
        { title: 'wrong menu realm', allowed: false, statements: [`UPDATE system_role SET rules='${ids.menu}' WHERE id=${ids.role}`, `UPDATE system_menus SET type=1 WHERE id=${ids.menu}`] },
        { title: 'menu is not API', allowed: false, statements: [`UPDATE system_role SET rules='${ids.menu}' WHERE id=${ids.role}`, `UPDATE system_menus SET auth_type=1 WHERE id=${ids.menu}`] },
        { title: 'menu access disabled', allowed: false, statements: [`UPDATE system_role SET rules='${ids.menu}' WHERE id=${ids.role}`, `UPDATE system_menus SET access=0 WHERE id=${ids.menu}`] },
        { title: 'menu deleted', allowed: false, statements: [`UPDATE system_role SET rules='${ids.menu}' WHERE id=${ids.role}`, `UPDATE system_menus SET is_del=1 WHERE id=${ids.menu}`] },
        { title: 'hidden API menu remains effective', allowed: true, statements: [`UPDATE system_role SET rules='${ids.menu}' WHERE id=${ids.role}`, `UPDATE system_menus SET is_show=0 WHERE id=${ids.menu}`] },
        { title: 'real actor disabled', allowed: false, statements: [`UPDATE system_admin SET status=0 WHERE id=${ids.actor}`] },
        { title: 'real Supplier disabled', allowed: false, statements: [`UPDATE system_supplier SET is_show=0 WHERE id=${ids.supplier}`] },
        { title: 'password changed', allowed: false, statements: [`UPDATE system_admin SET pwd='rotated' WHERE id=${ids.actor}`] },
        { title: 'actor deadline expired', allowed: false, claims: { expiresAt: 1 } },
      ];
      const labels = await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_label t ORDER BY id');
      const logs = await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.system_log t ORDER BY id');
      for (const [index, vector] of vectors.entries()) {
        await s.whole.exec(`UPDATE system_admin SET roles='${ids.role}',pwd=${literal(password)},admin_type=4,relation_id=${ids.supplier},status=1,is_del=0 WHERE id=${ids.actor};
          UPDATE system_supplier SET admin_id=${ids.actor + 100},is_show=1,is_del=0 WHERE id=${ids.supplier};
          UPDATE system_role SET type=4,relation_id=${ids.supplier},rules='supplier.product.manage',status=1 WHERE id=${ids.role};
          UPDATE system_role SET type=4,relation_id=${ids.supplier},rules='',status=0 WHERE id=${ids.secondRole};
          UPDATE system_menus SET type=4,auth_type=2,access=1,is_del=0,is_show=1,methods='POST',api_url='product/label/0' WHERE id=${ids.menu}`);
        for (const statement of vector.statements ?? []) await s.whole.exec(statement);
        const currentActor = { ...actor(), ...vector.claims };
        const tsAllowed = await tsPermissionProbe(s, currentActor), actual = await sqlPermissionProbe(s, contextFor(currentActor), `F${index}身份验证`);
        expect(tsAllowed, vector.title).toBe(vector.allowed);
        expect(actual.allowed, vector.title).toBe(tsAllowed);
        if (!actual.allowed) expect(causes(actual.error).some(code => ['P2101', 'P2104', 'P2105'].includes(code)), vector.title).toBe(true);
      }
      const valid = contextFor();
      const { auth_version: omitted, ...missingVersion } = valid;
      expect(omitted).toBe(md5(password));
      for (const invalid of [undefined, null, [], missingVersion, { ...valid, extra: true }, { ...valid, actor_id: null }, { ...valid, auth_version: null }, { ...valid, expires_at: null }, { ...valid, expires_at: 9007199254740992 }, { ...valid, actor_id: 2147483648 }]) {
        const actual = await sqlPermissionProbe(s, invalid, '无效身份不写入');
        expect(actual.allowed).toBe(false);expect(causes(actual.error)).toContain('P2104');
      }
      expect(await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.store_product_label t ORDER BY id')).toEqual(labels);
      expect(await s.whole.exec('SELECT to_jsonb(t) AS row,xmin::text AS version FROM public.system_log t ORDER BY id')).toEqual(logs);
    });
  }, 240000);

  it('executes deferred maintenance-owned reference label audit and authority faults and then rolls back every business effect', async () => {
    noNetwork();
    await withCurrent(true, async s => {
      await s.whole.db.insert(storeProductLabel).values(Array.from({ length: 4 }, (_, index) => ({ id: ids.label + index, type: 2, relationId: ids.supplier,
        labelCate: ids.group, labelName: `原始回滚${index}`, styleType: 2, color: '#123456', bgColor: '#abcdef', borderColor: '#333333',
        icon: '/legacy/exact-icon.png', isShow: 0, status: 0, sort: -9, addTime: 99 })));
      await s.whole.exec('CREATE SEQUENCE public.owned_supplier_label_probe START 1');
      const service = new SupplierProductLabelService(createContainerFromDb(s.app.db));
      const faults = [
        { title: 'private auxiliary reference', operation: 'delete', code: 400, message: /引用/u, sql: `INSERT INTO public.store_product_label_auxiliary(label_id,product_id) VALUES(${ids.label},70)` },
        { title: 'full label metadata', operation: 'update', code: 503, message: /商品标签提交事实或审计回执不完整/u, sql: `UPDATE public.store_product_label SET icon='/owned-trigger-rewrite.png' WHERE id=${ids.label + 1}` },
        { title: 'exact audit receipt', operation: 'update', code: 503, message: /商品标签提交事实或审计回执不完整/u, sql: "UPDATE public.system_log SET admin_name='owned trigger rewrite' WHERE id=NEW.id" },
        { title: 'live authority withdrawal', operation: 'update', code: 400011, message: /供应商标签权限已变化/u, sql: `UPDATE public.system_role SET rules='supplier.product.view' WHERE id=${ids.role}` },
      ] as const;
      const probe = async () => Number((await s.whole.exec('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS value FROM public.owned_supplier_label_probe'))[0]!.value);
      for (const [index, fault] of faults.entries()) {
        const id = ids.label + index;
        await s.whole.exec(`CREATE FUNCTION public.owned_supplier_label_deferred_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
          SET search_path=pg_catalog,public,pg_temp AS $owned_fault$BEGIN
          IF NEW.type='supplier_product_label' AND NEW.path='product/label/${id}' THEN
            PERFORM pg_catalog.nextval('public.owned_supplier_label_probe');
            ${fault.sql};
          END IF; RETURN NEW; END;$owned_fault$;
          REVOKE ALL ON FUNCTION public.owned_supplier_label_deferred_fault() FROM PUBLIC;
          CREATE CONSTRAINT TRIGGER owned_supplier_label_deferred_fault AFTER INSERT ON public.system_log
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_supplier_label_deferred_fault()`);
        try {
          const before = await dataSnapshot(s), seen = await probe();
          const error = await failure(fault.operation === 'delete' ? service.delete(ids.supplier, id, undefined, actor())
            : service.save(ids.supplier, id, { label_cate: ids.group, label_name: `提交前原子回滚${index}` }, actor()));
          // The real service deliberately maps P210x to its public exception
          // and does not preserve that private SQL cause chain.
          expect(error, fault.title).toMatchObject({ code: fault.code, message: expect.stringMatching(fault.message) });
          expect(causes(error), fault.title).not.toContain('42501');
          // nextval survives SQL rollback, so this cannot pass because the
          // trigger was denied before its malicious statement or never ran.
          expect(await probe(), fault.title).toBe(seen + 1);
          expect(await dataSnapshot(s), fault.title).toEqual(before);
          expect((await inspectSupplierProductLabelCapability(s.whole.db, s.target)).ready).toBe(true);
        } finally {
          await s.whole.exec('DROP TRIGGER owned_supplier_label_deferred_fault ON public.system_log; DROP FUNCTION public.owned_supplier_label_deferred_fault()');
        }
      }
      await s.whole.exec('DROP SEQUENCE public.owned_supplier_label_probe');
      expect(await audits(s)).toMatchObject({ app: { ready: true, failures: [] }, admin: { ready: true, failures: [] } });
    });
  }, 240000);
});
