/** Full registered schema, actual App/JWT and separately commissioned LOGINs.
 * Historical shipment/refund rows are explicitly declared read fixtures. The
 * only provider is a strict local implementation of the existing fetch boundary. */
import { expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, systemConfig, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { refundRuntimeFixture } from './refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned buyer tracking LOGIN missing'); return wiring.container;
} }));
const app = createApp();
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type ResponseEnvelope = { status: number; msg: string; data: any; headers: Headers; httpStatus: number };
export async function withBuyerOrderTracking(work: (s: {
  f: Fixture; env: Env; appRole: string; appPid: number; useContainer(container: Container): void;
  operations: ReturnType<Fixture['operationsFor']>;
  token(uid?: number): Promise<string>;
  request(path: string, token?: string | null): Promise<ResponseEnvelope>;
  fetch(request: Request): Promise<Response>;
  seedOrder(id?: number, orderId?: string, changes?: Partial<typeof storeOrder.$inferInsert>): Promise<void>;
  seedRefund(id?: number, number?: string, changes?: Partial<typeof storeOrderRefund.$inferInsert>): Promise<void>;
  state(): Promise<unknown>; enableProvider(): Promise<void>;
  providerCalls: Array<{ no: string; type: string | null }>;
  provider(reply: (no: string) => Promise<unknown>): void;
}) => Promise<void>) {
  let f: Fixture | undefined;
  const providerCalls: Array<{ no: string; type: string | null }> = [];
  let reply = async (_no: string): Promise<unknown> => ({ status: '0', result: { deliverystatus: 1, issign: 0,
    list: [{ time: '2026-11-13 10:00:00', status: '隔离样本：快件已揽收' }, { time: '2026-11-12 09:00:00', status: '隔离样本：商家已交运' }] } });
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe('https://wuliu.market.alicloudapi.com'); expect(url.pathname).toBe('/kdi'); expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe('APPCODE owned-local-tracking-provider');
    const no = url.searchParams.get('no') ?? ''; expect(no).not.toBe(''); providerCalls.push({ no, type: url.searchParams.get('type') });
    return new Response(JSON.stringify(await reply(no)), { headers: { 'content-type': 'application/json' } });
  });
  try {
    f = await refundRuntimeFixture(); const owned = f, cache = new Map<string, string>();
    const previousKV = owned.env.CONFIG_KV;
    const env = { ...owned.env, NODE_ENV: 'test', APP_KEY: 'owned-buyer-order-tracking-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ALIYUN_EXPRESS_APP_CODE: 'owned-local-tracking-provider',
      ORDER_QUEUE: { send: async () => { throw Error('Tracking must not enqueue'); }, sendBatch: async () => { throw Error('Tracking must not enqueue'); } },
      CONFIG_KV: { get: async (key: string, type?: string) => cache.has(key) ? type === 'json' ? JSON.parse(cache.get(key)!) : cache.get(key)! : previousKV.get(key),
        put: async (key: string, value: string) => { cache.set(key, value); }, delete: async (key: string) => { cache.delete(key); } },
      TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) },
    } as unknown as Env;
    await owned.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'logistics_type'));
    if (!owned.withRuntimeRole) throw Error('Independent LOGINs required');
    await owned.withRuntimeRole(appRole => owned.withRuntimeRole!(async adminRole => {
      const [database] = await owned.exec('SELECT current_database() AS name');
      const roles = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: owned.pricingOwner };
      await runRuntimeBusinessCommissioning(owned.db, roles);
      expect((await runRoutinePaymentRuntimeInstallation(owned.db, roles)).after.ready).toBe(true);
      wiring.container = createContainerFromDb(appRole.db);
      const fetch = async (request: Request) => {
        const tasks: Promise<unknown>[] = [];
        const response = await app.fetch(request, env, { waitUntil: task => { tasks.push(task); }, passThroughOnException() {}, props: {} });
        await Promise.all(tasks); return response;
      };
      const token = async (uid = 11) => { const [account] = await owned.db.select().from(user).where(eq(user.uid, uid));
        if (!account) throw Error('Owned buyer absent'); return (await createToken(uid, 'api', md5(account.pwd), env.APP_KEY)).token; };
      await work({ f: owned, env, appRole: appRole.role, appPid: appRole.pid, operations: owned.operationsFor(appRole), useContainer: container => { wiring.container = container; }, token, fetch,
        request: async (path, bearer = undefined) => {
          const value = bearer === undefined ? await token() : bearer;
          const response = await fetch(new Request('http://127.0.0.1' + path, { headers: value ? { Authorization: 'Bearer ' + value } : {} }));
          return { ...await response.json<Omit<ResponseEnvelope, 'headers' | 'httpStatus'>>(), headers: response.headers, httpStatus: response.status };
        },
        seedOrder: async (id = 840001, orderId = 'tracking_order_A', changes = {}) => {
          await owned.db.insert(storeOrder).values({ id, orderId, uid: 11, unique: crypto.randomUUID(), paid: 1, status: 1, pid: 0,
            deliveryType: 'express', deliveryName: '本机历史快递', deliveryCode: 'LOCAL', deliveryId: 'OUTGOING-A',
            realName: '隔离样本收货人', userPhone: '00000000000', userAddress: '本机测试地址', ...changes });
          await owned.db.insert(storeOrderCartInfo).values({ id: id + 100, oid: id, uid: changes.uid ?? 11, cartId: String(id + 100), cartNum: 2,
            cartInfo: JSON.stringify({ truePrice: '10.00', product: { storeName: '隔离物流商品', image: '' }, sku: { suk: '本机规格', price: '10.00' } }) });
        },
        seedRefund: async (id = 840101, number = 'tracking_refund_A', changes = {}) => {
          await owned.db.insert(storeOrderRefund).values({ id, orderId: number, storeOrderId: 840001, uid: 11, applyType: 2,
            refundType: 5, refundNum: 1, refundPrice: '10.00', refundExpress: 'RETURN-A', refundExpressName: '本机历史退件',
            cartInfo: JSON.stringify({ cartIds: [{ cart_id: 840101, cart_num: 1 }] }), ...changes });
        },
        state: async () => ({ business: await owned.state(), sequences: await owned.exec("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename") }),
        enableProvider: async () => {
          const rows = await owned.db.update(systemConfig).set({ value: '2' }).where(eq(systemConfig.menuName, 'logistics_type')).returning({ id: systemConfig.id });
          if (!rows.length) await owned.db.insert(systemConfig).values({ menuName: 'logistics_type', value: '2' });
        }, providerCalls, provider: callback => { reply = callback; },
      });
    }));
  } finally { wiring.container = null; network.mockRestore(); await f?.close(); }
}
