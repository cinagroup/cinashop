import { expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, systemAdmin, systemRole } from '@/models/schema';
import { createToken } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';

const wiring = vi.hoisted(() => ({ app: null as Container | null, admin: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => wiring.app,
  createAdminDatabaseSession: () => {
    if (!wiring.admin) throw Error('Owned Admin LOGIN missing');
    return { container: wiring.admin, close: async () => {} };
  },
}));
const app = createApp();
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Role = 'root' | 'manager' | 'viewer' | 'disabled' | 'supplier';
type Envelope = { status: number; msg: string; data: any; headers: Headers; httpStatus: number };
export interface RemarkScenario {
  f: Fixture;
  token(role?: Role): string;
  request(method: string, path: string, body?: unknown, token?: string | null): Promise<Envelope>;
  seed(id?: number, orderId?: string): Promise<void>;
  snapshot(): Promise<Record<string, unknown>>;
}

export async function withRemarkScenario(work: (s: RemarkScenario) => Promise<void>,
  prepare?: (f: Fixture, roles: { app: string; admin: string }, databases: { app: DbClient; admin: DbClient }) => Promise<void>) {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned order remark acceptance forbids providers'));
  let owned: Fixture | undefined;
  try {
    const f = owned = await refundRuntimeFixture();
    await f.db.insert(systemRole).values([
      { id: 820001, roleName: 'Owned order writer', rules: 'order.manage', type: 0, relationId: 0, status: 1 },
      { id: 820002, roleName: 'Owned order reader', rules: 'order.view', type: 0, relationId: 0, status: 1 },
    ]);
    const password = 'owned-remark-admin-password';
    await f.db.insert(systemAdmin).values([
      { id: 101, account: 'remark-root', pwd: password, adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 },
      { id: 102, account: 'remark-manager', pwd: password, adminType: 1, relationId: 0, level: 1, roles: '820001', status: 1, isDel: 0 },
      { id: 103, account: 'remark-viewer', pwd: password, adminType: 1, relationId: 0, level: 1, roles: '820002', status: 1, isDel: 0 },
      { id: 104, account: 'remark-disabled', pwd: password, adminType: 1, relationId: 0, level: 0, status: 0, isDel: 0 },
      { id: 105, account: 'remark-supplier', pwd: password, adminType: 4, relationId: 7, level: 0, status: 1, isDel: 0 },
    ]);
    const env = { ...f.env, NODE_ENV: 'test', APP_KEY: 'owned-order-remark-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, auditEvent: false, limit: 120,
        remaining: 119, resetAt: Date.now() + 60000 }) }) },
    } as unknown as Env;
    const { md5 } = await import('@/utils/jwt');
    const tokens = {} as Record<Role, string>;
    for (const [role, id] of Object.entries({ root: 101, manager: 102, viewer: 103, disabled: 104, supplier: 105 }))
      tokens[role as Role] = (await createToken(id, 'admin', md5(password), env.APP_KEY)).token;
    if (!f.withRuntimeRole) throw Error('Independent native LOGINs required');
    await f.withRuntimeRole(appRole => f.withRuntimeRole!(async adminRole => {
      const [database] = await f.db.execute(sql`SELECT current_database() AS name`);
      const names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect((await runRoutinePaymentRuntimeInstallation(f.db, names)).after.ready).toBe(true);
      expect(await auditRuntimeBusinessPrivileges(appRole.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(adminRole.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      await prepare?.(f, { app: appRole.role, admin: adminRole.role }, { app: appRole.db, admin: adminRole.db });
      wiring.app = createContainerFromDb(appRole.db); wiring.admin = createContainerFromDb(adminRole.db);
      const request: RemarkScenario['request'] = async (method, path, body, token = tokens.root) => {
        const tasks: Promise<unknown>[] = [];
        const response = await app.request(path, { method, headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }, env,
        { waitUntil: task => { tasks.push(task); }, passThroughOnException() {}, props: {} });
        await Promise.all(tasks);
        return { ...await response.json<Omit<Envelope, 'headers' | 'httpStatus'>>(), headers: response.headers, httpStatus: response.status };
      };
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        for (const table of ['store_order', 'store_order_status', 'store_order_outbox', 'user', 'user_bill', 'system_admin', 'system_role'])
          result[table] = await f.exec('SELECT to_jsonb(t) AS row FROM public.' + table + ' t ORDER BY to_jsonb(t)::text');
        return result;
      };
      await work({ f, request, snapshot, token: (role = 'root') => tokens[role],
        seed: async (id = 820001, orderId = 'owned-remark-order') => {
          // Unpaid test configuration, not a manufactured payment or fulfillment.
          await f.db.insert(storeOrder).values({ id, orderId, uid: 11, paid: 0, status: 0, pid: 0,
            isDel: 0, isSystemDel: 0, unique: crypto.randomUUID(), remark: '原备注', payPrice: '0.00', totalPrice: '0.00' });
        },
      });
    }));
    expect(network).not.toHaveBeenCalled();
  } finally { wiring.app = null; wiring.admin = null; network.mockRestore(); await owned?.close(); }
}
