/** Full migrated PG16 schema, actual App/UserJWT and independently authenticated
 * commissioned application LOGIN. All sample orders are declared local rows;
 * invoice application never calls an issuer, payment provider or Queue. */
import { expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, systemConfig, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { refundRuntimeFixture } from './refundRuntimeFixture';
const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned buyer invoice LOGIN missing'); return wiring.container;
} }));
const app = createApp();
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
export async function withBuyerInvoices(work: (s: {
  f: Fixture; env: Env; appPid: number; appRole: string; appContainer: Container;
  fetch(request: Request): Promise<Response>;
  token(uid?: number): Promise<string>;
  request(path: string, body?: unknown, bearer?: string | null, method?: string): Promise<{ status: number; msg: string; data: any; headers: Headers; httpStatus: number }>;
  seedOrder(id?: number, number?: string, changes?: Partial<typeof storeOrder.$inferInsert>): Promise<void>;
  flags(enabled?: string, special?: string): Promise<void>;
}) => Promise<void>) {
  let f: Fixture | undefined;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Invoice acceptance must not use external fetch'); });
  try {
    f = await refundRuntimeFixture(); const owned = f, values = new Map<string, string>(), original = owned.env.CONFIG_KV;
    const env = { ...owned.env, NODE_ENV: 'test', APP_KEY: 'owned-buyer-invoices-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ORDER_QUEUE: { send: async () => { throw Error('Invoice must not enqueue'); }, sendBatch: async () => { throw Error('Invoice must not enqueue'); } },
      CONFIG_KV: { get: async (key: string, type?: string) => values.has(key) ? type === 'json' ? JSON.parse(values.get(key)!) : values.get(key)! : original.get(key),
        put: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } },
      TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) },
    } as unknown as Env;
    if (!owned.withRuntimeRole) throw Error('Independent LOGINs required');
    await owned.withRuntimeRole(appRole => owned.withRuntimeRole!(async adminRole => {
      const [database] = await owned.exec('SELECT current_database() AS name');
      await runRuntimeBusinessCommissioning(owned.db, { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: owned.pricingOwner });
      const appContainer = createContainerFromDb(appRole.db); wiring.container = appContainer;
      const token = async (uid = 11) => { const [row] = await owned.db.select().from(user).where(eq(user.uid, uid)); if (!row) throw Error('Owned user missing'); return (await createToken(uid, 'api', md5(row.pwd), env.APP_KEY)).token; };
      const flags = async (enabled = '1', special = '1') => {
        for (const [key, value] of [['invoice_func_status', enabled], ['special_invoice_status', special]]) {
          const rows = await owned.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, key)).returning({ id: systemConfig.id });
          if (!rows.length) await owned.db.insert(systemConfig).values({ menuName: key, value });
        }
      };
      await flags();
      // The historical refund fixture explicitly inserts template id=1. Advance
      // this self-owned fixture sequence before testing actual title creation.
      await owned.exec("SELECT setval('public.user_invoice_id_seq',(SELECT greatest(coalesce(max(id),1),1) FROM public.user_invoice),true)");
      const fetch = async (request: Request) => { const tasks: Promise<unknown>[] = []; const response = await app.fetch(request, env,
        { waitUntil: task => { tasks.push(task); }, passThroughOnException() {}, props: {} }); await Promise.all(tasks); return response; };
      await work({ f: owned, env, appPid: appRole.pid, appRole: appRole.role, appContainer, token, flags, fetch,
        request: async (path, body, bearer, method = body === undefined ? 'GET' : 'POST') => {
          const value = bearer === undefined ? await token() : bearer;
          const headers = new Headers({ 'content-type': 'application/json' }); if (value) headers.set('Authorization', 'Bearer ' + value);
          const response = await fetch(new Request('http://127.0.0.1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
          return { ...await response.json<{ status: number; msg: string; data: any }>(), headers: response.headers, httpStatus: response.status };
        },
        seedOrder: async (id = 850001, number = 'invoice_order_A', changes = {}) => {
          await owned.db.insert(storeOrder).values({ id, orderId: number, uid: 11, unique: crypto.randomUUID(), paid: 1, payType: 'yue', status: 0, pid: 0,
            payPrice: '20.00', totalPrice: '20.00', totalNum: 2, ...changes });
          await owned.db.insert(storeOrderCartInfo).values({ id: id + 100, oid: id, uid: changes.uid ?? 11, cartId: String(id + 100), cartNum: 2,
            cartInfo: JSON.stringify({ truePrice: '10.00', product: { storeName: '本机发票商品', image: '' }, sku: { suk: '本机规格', price: '10.00' } }) });
        },
      });
      expect(network).not.toHaveBeenCalled();
    }));
  } finally { wiring.container = null; network.mockRestore(); await f?.close(); }
}
