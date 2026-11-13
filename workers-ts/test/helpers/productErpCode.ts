import { expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemSupplier, storeProductCategory, storeProduct } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';

export type Writer = 'supplier' | 'modern' | 'out';
type Envelope = { status: number; msg: string; data: any };
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
const wiring = vi.hoisted(() => ({ application: null as Container | null, admin: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => wiring.application,
  createAdminDatabaseSession: () => { if (!wiring.admin) throw Error('Missing owned Admin LOGIN'); return { container: wiring.admin, close: async () => {} }; },
}));
const app = createApp();
const businessTables = ['store_product', 'store_product_attr_value', 'store_product_attr', 'store_product_attr_result',
  'store_product_description', 'store_product_relation', 'store_product_stock_record', 'store_product_coupon',
  'store_product_virtual', 'store_cart', 'out_product_write_replay', 'system_log', 'system_admin', 'system_supplier', 'system_config'];
export interface Scenario {
  f: Fixture;
  body(writer: Writer, type?: number): Record<string, unknown>;
  request(method: string, path: string, body?: object, token?: string | null, key?: string): Promise<Envelope>;
  ok(method: string, path: string, body?: object, token?: string | null, key?: string): Promise<any>;
  token(writer: Writer): string;
  create(writer: Writer, type?: number, key?: string): Promise<{ id: number; body: Record<string, unknown>; key: string }>;
  edit(writer: Writer, id: number, body: Record<string, unknown>, key?: string): Promise<Envelope>;
  publish(writer: Writer, id: number): Promise<void>;
  row(id: number): Promise<typeof storeProduct.$inferSelect>;
  snapshot(): Promise<Record<string, unknown>>;
}

export async function withScenario(work: (s: Scenario) => Promise<void>) {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned ERP code acceptance forbids providers'));
  let owned: Fixture | undefined;
  try {
    const f = owned = await refundRuntimeFixture();
    await f.db.update(systemSupplier).set({ adminId: 21, isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 7));
    await f.db.insert(systemAdmin).values([
      { id: 21, account: 'defaults-supplier', pwd: 'defaults-supplier-password', adminType: 4, relationId: 7, status: 1, isDel: 0 },
      { id: 101, account: 'defaults-admin', pwd: 'defaults-admin-password', adminType: 1, relationId: 0, level: 0, status: 1, isDel: 0 },
    ]);
    await f.db.insert(storeProductCategory).values([
      { id: 800001, type: 2, relationId: 7, cateName: 'Owned supplier defaults', isShow: 1 },
      { id: 800002, type: 0, relationId: 0, cateName: 'Owned platform defaults', isShow: 1 },
    ]);
    await f.exec(`INSERT INTO out_interface(id,type,method,url) VALUES(800011,1,'POST','/product'),(800012,1,'PUT','/product/{id}');
      INSERT INTO out_account(id,appid,appsecret,rules) VALUES(800021,'defaults-out','defaults-out-password','[800011,800012]');
      SELECT setval(pg_get_serial_sequence('store_product','id'),800010,true);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),800010,true)`);
    await f.db.update(storeProduct).set({ star: '3.0' });
    const env = { ...f.env, NODE_ENV: 'test', APP_KEY: 'owned-erp-code-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, auditEvent: false, limit: 120, remaining: 119, resetAt: Date.now() + 60000 }) }) },
    } as unknown as Env;
    const tokens = {
      supplier: (await createToken(21, 'supplier', md5('defaults-supplier-password'), env.APP_KEY)).token,
      modern: (await createToken(101, 'admin', md5('defaults-admin-password'), env.APP_KEY)).token,
      out: (await createToken(800021, 'out', md5('defaults-out-password'), env.APP_KEY)).token,
    };
    if (!f.withRuntimeRole) throw Error('Independent native runtime LOGINs required');
    await f.withRuntimeRole(appRole => f.withRuntimeRole!(async adminRole => {
      const [database] = await f.db.execute(sql`SELECT current_database() AS name`);
      const names = { app: appRole.role, admin: adminRole.role, maintenance: 'finance_test', database: String(database.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect((await runRoutinePaymentRuntimeInstallation(f.db, names)).after.ready).toBe(true);
      expect(await auditRuntimeBusinessPrivileges(appRole.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(adminRole.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      wiring.application = createContainerFromDb(appRole.db); wiring.admin = createContainerFromDb(adminRole.db);
      const request: Scenario['request'] = async (method, path, body, token = null, key) => {
        const tasks: Promise<unknown>[] = [];
        const response = await app.request(path, { method, headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        }, ...(body ? { body: JSON.stringify(body) } : {}) }, env,
        { waitUntil: task => { tasks.push(task); }, passThroughOnException() {}, props: {} });
        await Promise.all(tasks); return response.json<Envelope>();
      };
      const ok: Scenario['ok'] = async (...args) => { const r = await request(...args); expect(r.status, r.msg).toBe(200); return r.data; };
      const body: Scenario['body'] = (writer, type = 0) => ({
        product_type: type, cate_id: [writer === 'supplier' ? 800001 : 800002], store_name: 'Owned ERP code ' + writer + type,
        slider_image: ['/creation-defaults.png'], spec_type: 0, items: [], is_show: 1, freight: 1, is_postage: 1,
        delivery_type: type === 0 ? [1] : type === 4 ? [2] : [],
        star: '1.0', spu: 'FORGED-CLIENT-SPU', bar_code: 'TOP-BARCODE',
        attrs: [{ suk: '默认', image: '/creation-defaults.png', price: '10.00', settle_price: '1.00', vip_price: '0.00', stock: 8,
          code: 'OWNED-SKU-CODE', ...(type === 1 ? { delivery_mode: 'fixed', disk_info: 'owned-fixed-content' } : {}),
          ...(type === 4 ? { write_times: 3, write_valid: 1 } : {}) }],
      });
      const create: Scenario['create'] = async (writer, type = 0, key = crypto.randomUUID()) => {
        const input = body(writer, type), path = writer === 'supplier' ? '/supplierapi/product/product/0' : writer === 'modern' ? '/adminapi/product/add' : '/outapi/product';
        const result = await ok('POST', path, input, tokens[writer], key);
        return { id: Number(result.id), body: input, key };
      };
      const edit: Scenario['edit'] = async (writer, id, input, key = crypto.randomUUID()) => {
        if (writer === 'supplier') {
          const detail = await ok('GET', '/supplierapi/product/product/' + id, undefined, tokens.supplier);
          return request('POST', '/supplierapi/product/product/' + id, { ...input, attrs: detail.attrs }, tokens.supplier, key);
        }
        return request(writer === 'out' ? 'PUT' : 'POST', writer === 'out' ? '/outapi/product/' + id : '/adminapi/product/edit/' + id, input, tokens[writer], key);
      };
      const publish: Scenario['publish'] = async (writer, id) => {
        if (writer === 'supplier') await ok('POST', '/adminapi/product/product/set_verify/' + id,
          { is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }, tokens.modern);
      };
      const snapshot: Scenario['snapshot'] = async () => {
        const state: Record<string, unknown> = {};
        for (const table of businessTables) state[table] = await f.exec('SELECT to_jsonb(t) AS row FROM public.' + table + ' t ORDER BY to_jsonb(t)::text');
        return state;
      };
      await work({ f, body, request, ok, create, edit, publish, snapshot, token: writer => tokens[writer],
        row: async id => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0] });
    }));
    expect(network).not.toHaveBeenCalled();
  } finally { wiring.application = null; wiring.admin = null; network.mockRestore(); await owned?.close(); }
}
