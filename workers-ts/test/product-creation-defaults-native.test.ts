import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, systemSupplier, storeProductCategory, storeProduct } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runRoutinePaymentRuntimeInstallation } from '@/migrations/routinePaymentRuntime';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';

type Writer = 'supplier' | 'modern' | 'out';
type Envelope = { status: number; msg: string; data: any };
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
const wiring = vi.hoisted(() => ({ application: null as Container | null, admin: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => wiring.application,
  createAdminDatabaseSession: () => { if (!wiring.admin) throw Error('Missing owned Admin LOGIN'); return { container: wiring.admin, close: async () => {} }; },
}));
const app = createApp();
const matrix = [
  ...[0, 1, 3].map(type => ({ writer: 'supplier' as const, type })),
  ...[0, 1, 3, 4].map(type => ({ writer: 'modern' as const, type })),
  ...[0, 1, 2, 3, 4].map(type => ({ writer: 'out' as const, type })),
];
const businessTables = ['store_product', 'store_product_attr_value', 'store_product_attr', 'store_product_attr_result',
  'store_product_description', 'store_product_relation', 'store_product_stock_record', 'store_product_coupon',
  'store_product_virtual', 'store_cart', 'out_product_write_replay', 'system_log', 'system_admin', 'system_supplier'];
interface Scenario {
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

async function withScenario(work: (s: Scenario) => Promise<void>) {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned product defaults acceptance forbids providers'));
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
    const env = { ...f.env, NODE_ENV: 'test', APP_KEY: 'owned-creation-defaults-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
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
        product_type: type, cate_id: [writer === 'supplier' ? 800001 : 800002], store_name: 'Owned creation defaults ' + writer + type,
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

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary product creation metadata on actual App/Admin LOGIN profiles', () => {
  it.each(matrix)('uses PHP creation defaults for $writer type $type and preserves feedback on edits and replay', async ({ writer, type }) => withScenario(async s => {
    const created = await s.create(writer, type), row = await s.row(created.id);
    console.log('OWNED_CREATION_METADATA ' + JSON.stringify({ writer, type, id: row.id, star: row.star, spu: row.spu }));
    expect(row.star).toBe('5.0'); expect(row.spu).toMatch(/^\d{13}$/);
    expect(row.barCode).toBe(writer === 'modern' ? '' : 'TOP-BARCODE'); expect(row.code).toBe('');
    await s.publish(writer, row.id);
    expect((await s.ok('GET', '/api/product/detail/' + row.id)).storeInfo.star).toBe('5.0');
    const rank = await s.ok('GET', '/api/product/rank/2?limit=100');
    expect(rank[0].id).toBe(row.id); expect(rank.find((r: any) => r.id === row.id).star).toBe('5.0');
    const legacySpu = 'abcdef1234567'; await s.f.db.update(storeProduct).set({ star: '2.7', spu: legacySpu }).where(eq(storeProduct.id, row.id));
    const updated = await s.edit(writer, row.id, { ...created.body, star: '4.9', spu: 'FORGED-EDIT' }); expect(updated.status, updated.msg).toBe(200);
    expect(await s.row(row.id)).toMatchObject({ star: '2.7', spu: legacySpu }); await s.publish(writer, row.id);
    expect((await s.ok('GET', '/api/product/detail/' + row.id)).storeInfo.star).toBe('2.7');
    expect((await s.ok('GET', '/api/product/rank/2?limit=100')).find((r: any) => r.id === row.id).star).toBe('2.7');
    if (writer === 'out') {
      await s.f.db.update(storeProduct).set({ star: '4.1', spu: '' }).where(eq(storeProduct.id, row.id));
      const replay = await s.ok('POST', '/outapi/product', { ...created.body, star: '0.0', spu: 'FORGED-REPLAY' }, s.token('out'), created.key);
      expect(replay).toMatchObject({ id: row.id, idempotent: true }); expect(await s.row(row.id)).toMatchObject({ star: '4.1', spu: '' });
    }
  }), 120000);

  it.each(['supplier', 'modern', 'out'] as const)('omits star and SPU columns on %s edits', async writer => withScenario(async s => {
    const made = await s.create(writer); await s.f.db.update(storeProduct).set({ star: '0.0', spu: '' }).where(eq(storeProduct.id, made.id));
    await s.f.exec(`CREATE FUNCTION owned_no_metadata_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Creation metadata must not be authored on edit'; END $$;
      CREATE TRIGGER owned_no_metadata_update BEFORE UPDATE OF star,spu ON store_product FOR EACH ROW EXECUTE FUNCTION owned_no_metadata_update()`);
    const edited = await s.edit(writer, made.id, { ...made.body, star: '5.0', spu: 'FORGED-COLUMN' }); expect(edited.status, edited.msg).toBe(200);
    expect(await s.row(made.id)).toMatchObject({ star: '0.0', spu: '' });
  }), 120000);

  it.each(['supplier', 'modern', 'out'] as const)('denies anonymous %s creation without business or sequence writes', async writer => withScenario(async s => {
    const before = await s.snapshot(), sequences = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
    const path = writer === 'supplier' ? '/supplierapi/product/product/0' : writer === 'modern' ? '/adminapi/product/add' : '/outapi/product';
    expect((await s.request('POST', path, s.body(writer), null, crypto.randomUUID())).status).not.toBe(200);
    expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequences);
  }), 120000);

  const tamperCases = (['supplier', 'modern', 'out'] as const).flatMap(writer =>
    (['insert', 'sku', 'late', 'deferred'] as const).map(phase => ({ writer, phase })));
  it.each(tamperCases)('rolls back $writer creation when $phase author changes rating', async ({ writer, phase }) => withScenario(async s => {
    const table = phase === 'sku' ? 'store_product_attr_value' : phase === 'late'
      ? writer === 'supplier' ? 'store_product_description' : writer === 'out' ? 'out_product_write_replay' : 'system_log' : 'store_product';
    const target = table === 'system_log' ? '(SELECT max(id) FROM store_product)' : table === 'store_product' ? 'NEW.id' : 'NEW.product_id';
    const rewrite = phase === 'insert' ? "NEW.star:='4.4'; RETURN NEW;" : `UPDATE store_product SET star='4.4' WHERE id=${target}; RETURN NEW;`;
    const timing = phase === 'insert' ? 'CREATE TRIGGER owned_rating_tamper BEFORE INSERT' : phase === 'deferred'
      ? 'CREATE CONSTRAINT TRIGGER owned_rating_tamper AFTER INSERT' : 'CREATE TRIGGER owned_rating_tamper AFTER INSERT';
    await s.f.exec(`CREATE FUNCTION owned_rating_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${rewrite} END $$;
      ${timing} ON ${table} ${phase === 'deferred' ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION owned_rating_tamper()`);
    const before = await s.snapshot(), input = s.body(writer), key = crypto.randomUUID();
    const path = writer === 'supplier' ? '/supplierapi/product/product/0' : writer === 'modern' ? '/adminapi/product/add' : '/outapi/product';
    const result = await s.request('POST', path, input, s.token(writer), key);
    expect(result.status, result.msg).toBe(writer === 'out' && phase !== 'insert' ? 400 : 409);
    if (writer === 'out' && phase !== 'insert') expect(result.msg).toContain('定时上下架');
    expect(await s.snapshot()).toEqual(before);
    if (writer === 'out' && phase === 'late') {
      await s.f.exec('DROP TRIGGER owned_rating_tamper ON out_product_write_replay');
      const retry = await s.ok('POST', path, input, s.token(writer), key); expect(retry.idempotent).toBe(false);
      expect(await s.row(retry.id)).toMatchObject({ star: '5.0' });
    }
  }), 120000);

  it.each(['modern', 'out'] as const)('rolls back late %s SPU rewriting', async writer => withScenario(async s => {
    await s.f.exec(`CREATE FUNCTION owned_late_spu() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET spu='tampered' WHERE id=NEW.product_id; RETURN NEW; END $$;
      CREATE TRIGGER owned_late_spu AFTER INSERT ON store_product_attr_value FOR EACH ROW EXECUTE FUNCTION owned_late_spu()`);
    const before = await s.snapshot(), path = writer === 'modern' ? '/adminapi/product/add' : '/outapi/product';
    const failed = await s.request('POST', path, s.body(writer), s.token(writer), crypto.randomUUID());
    expect(failed.status, failed.msg).toBe(writer === 'out' ? 400 : 409);
    if (writer === 'out') expect(failed.msg).toContain('定时上下架');
    expect(await s.snapshot()).toEqual(before);
  }), 120000);

  it.each(['supplier', 'modern', 'out'] as const)('rolls back late %s edit changes to historical metadata', async writer => withScenario(async s => {
    const made = await s.create(writer); await s.f.db.update(storeProduct).set({ star: '2.7', spu: 'old-reference' }).where(eq(storeProduct.id, made.id));
    await s.f.exec(`CREATE FUNCTION owned_edit_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET star='0.5',spu='changed' WHERE id=NEW.id; RETURN NEW; END $$;
      CREATE TRIGGER owned_edit_metadata AFTER UPDATE OF store_name ON store_product FOR EACH ROW EXECUTE FUNCTION owned_edit_metadata()`);
    const before = await s.snapshot(), result = await s.edit(writer, made.id, { ...made.body, store_name: 'changed ordinary name' });
    expect(result.status, result.msg).toBe(409); expect(await s.snapshot()).toEqual(before);
  }), 120000);
});
