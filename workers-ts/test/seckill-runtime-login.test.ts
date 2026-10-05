import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { orderConfirm, orderCreate, orderCancel, orderDel } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { AdminSeckillActivityService } from '../src/services/admin/AdminSeckillActivityService';
import { AdminSeckillTimeService } from '../src/services/admin/AdminSeckillTimeService';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { storeActivity, storeCart, storeProduct, storeProductAttrValue, storeSeckill, storeSeckillTime, systemAttachment, systemConfig, systemStore, systemSupplier } from '../src/models/schema';
import { ActivityService } from '../src/services/activity/ActivityService';
import { createHmac } from 'node:crypto';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

function errorChain(error: unknown) {
  const messages: string[] = [], codes: string[] = [];
  for (let depth = 0; depth < 12 && error && typeof error === 'object'; depth++) {
    if ('message' in error) messages.push(String(error.message));
    if ('code' in error) codes.push(String(error.code));
    if (!('cause' in error) || error.cause === error) break;
    error = error.cause;
  }
  return { messages: messages.join(' / '), codes };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Seckill purchases using the exact separately authenticated app LOGIN', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    // This suite exercises real pickup purchases. The shared refund fixture
    // disables pricing flags; enable pickup through its actual SQL authority.
    const pickupFlags = await f.db.update(systemConfig).set({ value: '1' })
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['store_func_status', 'store_self_mention'])))
      .returning({ key: systemConfig.menuName });
    expect([...new Set(pickupFlags.map(row => row.key))].sort()).toEqual(['store_func_status', 'store_self_mention']);
    f.env.APP_KEY = 'local-seckill-runtime-image-key';
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.update(storeProduct).set({ type: 1, relationId: 0, isVip: 0, freight: 1 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeSeckillTime).values({ id: 101, title: '隔离全天场', startTime: '00:00', endTime: '24:00',
      pic: '/images/local-slot.png', describe: '本机权限测试', status: 1 });
    const day = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, name: '隔离父活动', status: 1, timeId: '101', startDay: day, endDay: day + 86_400 });
    await f.db.insert(storeSeckill).values({ id: 20, activityId: 9, productId: 70, timeId: '101', stock: 8, quota: 8,
      quotaShow: 8, onceNum: 3, num: 10, price: '6.25', status: 1, isShow: 1, isDel: 0 });
    await f.db.insert(storeProductAttrValue).values({ id: 3, productId: 20, type: 1, unique: 'roleSk20',
      suk: '红色,大号', stock: 8, quota: 8, quotaShow: 8, price: '6.25' });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),3,true)");
    await f.db.update(storeCart).set({ activityId: 20, type: 1, isNew: 1 }).where(eq(storeCart.id, 1));
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);
  type Role = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r: infer R) => unknown ? R : never;
  async function profiles(run: (app: Role, admin: Role) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [database] = await f.exec('SELECT current_database() AS name');
      await runRuntimeBusinessCommissioning(f.db, { database: String(database.name), app: app.role, admin: admin.role,
        maintenance: 'finance_test', pricingOwner: f.pricingOwner });
      await run(app, admin);
    }));
  }
  const createInput = () => ({ uid: 11, key: 'actual_role_seckill', cartIds: [1], type: 1, seckillId: 20,
    shippingType: 2, storeId: 1, realName: '隔离角色样本', userPhone: '00000000000', userIp: '127.0.0.1' });
  async function businessState() {
    return { shared: await f.state(), parent: await f.exec('SELECT to_jsonb(t) AS row FROM public.store_activity t ORDER BY id'),
      slots: await f.exec('SELECT to_jsonb(t) AS row FROM public.store_seckill_time t ORDER BY id'),
      children: await f.exec('SELECT to_jsonb(t) AS row FROM public.store_seckill t ORDER BY id') };
  }
  function publicHttp(role: Role) {
    const http = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    // End-user identity and the sequence DO are synthetic; controller, quote,
    // SQL purchase/cancellation and the authenticated database LOGIN are real.
    http.use('*', async (c, next) => { c.set('container', createContainerFromDb(role.db)); c.set('uid', 11); await next(); });
    http.onError((error, c) => c.json({ status: 400, msg: errorChain(error).messages, data: null }));
    http.post('/confirm', orderConfirm); http.post('/create/:key', orderCreate);
    http.post('/cancel', orderCancel); http.post('/delete', orderDel);
    const sequence = vi.fn(async () => new Response('actual_app_seckill_order'));
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'local', get: () => ({ fetch: sequence }) } });
    const post = async (path: string, body: object) => (await http.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, f.env))
      .json<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; orderId: string } }>();
    return { post, sequence };
  }
  const publicInput = () => ({ cartIds: [1], type: 1, seckillId: 20, useIntegral: false,
    shippingType: 2, storeId: 1, realName: '隔离角色样本', userPhone: '00000000000' });

  it('reproduces 42501 in actual order creation when parent/slot have only the prior SELECT grants', async () => {
    await profiles(async app => {
      // Retain the original deficiency as a negative control after the fix:
      // this changes only the two reviewed lock-column grants on this owned role.
      await f.exec(`REVOKE UPDATE(id) ON public.store_activity,public.store_seckill_time FROM "${app.role}"`);
      const [grants] = await f.exec(`SELECT has_table_privilege('${app.role}','public.store_activity','SELECT') AS readable,
        has_any_column_privilege('${app.role}','public.store_activity','UPDATE') AS parent_lock,
        has_any_column_privilege('${app.role}','public.store_seckill_time','UPDATE') AS slot_lock`);
      expect(grants).toEqual({ readable: true, parent_lock: false, slot_lock: false });
      const before = await businessState();
      const result = await outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(app.db),
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'local_role_repro' }, createInput()));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = errorChain(result.error);
        expect(error.codes, error.messages).toContain('42501');
        expect(error.messages).toContain('permission denied for table store_activity');
      }
      expect(await businessState()).toEqual(before);
    });
  }, 60_000);

  it.each(['parent', 'slot'] as const)('requires the reviewed %s lock-column authority, including complete rollback', async target => {
    await profiles(async app => {
      const table = target === 'parent' ? 'store_activity' : 'store_seckill_time';
      await f.exec(`REVOKE UPDATE(id) ON public.${table} FROM "${app.role}"`);
      const before = await businessState();
      const result = await outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(app.db),
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'missing_one_lock' }, createInput()));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = errorChain(result.error);
        expect(error.codes, error.messages).toContain('42501');
        expect(error.messages).toContain(`permission denied for table ${table}`);
      }
      expect(await businessState()).toEqual(before);
    });
  }, 60_000);

  it.each([[true, 'cancel'], [false, 'cancel'], [true, 'delete'], [false, 'delete']] as const)
    ('runs actual public type1 confirm/create/replay with linked-parent=%s and %s recovery', async (linked, action) => {
      if (!linked) await f.db.update(storeSeckill).set({ activityId: 0 }).where(eq(storeSeckill.id, 20));
      await profiles(async app => {
        const before = await businessState(), http = publicHttp(app), input = publicInput();
        const quote = await http.post('/confirm', input);
        expect(quote.status, quote.msg).toBe(200);
        expect(http.sequence).not.toHaveBeenCalled();
        const body = { ...input, quoteToken: quote.data.quoteToken, requirePurchaseOrigin: false };
        const created = await http.post(`/create/${quote.data.orderKey}`, body);
        expect(created.status, created.msg).toBe(200);
        expect(await app.exec('SELECT type,activity_id,total_num,total_price,paid FROM public.store_order'))
          .toEqual([{ type: 1, activity_id: 20, total_num: 2, total_price: '12.50', paid: 0 }]);
        expect(await app.exec('SELECT stock,quota,quota_show FROM public.store_seckill WHERE id=20'))
          .toEqual([{ stock: 6, quota: 6, quota_show: 8 }]);
        expect(await app.exec('SELECT stock,quota,quota_show FROM public.store_product_attr_value WHERE id=3'))
          .toEqual([{ stock: 6, quota: 6, quota_show: 8 }]);
        const made = await businessState();
        expect((await http.post(`/create/${quote.data.orderKey}`, body)).status).toBe(200);
        expect(await businessState()).toEqual(made);
        expect((await http.post(`/${action}`, { order_id: 'actual_app_seckill_order' })).status).toBe(200);
        const recovered = await businessState();
        expect(recovered.parent).toEqual(before.parent); expect(recovered.slots).toEqual(before.slots);
        expect(recovered.children).toEqual(before.children);
        for (const table of ['store_product', 'store_product_attr_value', 'store_cart', 'user'])
          expect(recovered.shared[table], table).toEqual(before.shared[table]);
        expect((await http.post('/cancel', { order_id: 'actual_app_seckill_order' })).status).toBe(400);
        expect(await businessState()).toEqual(recovered);
      });
    }, 60_000);

  it.each([1, 2] as const)('preserves purchased identities through Admin total-quota edit, retirement and app cancellation for owner type %s', async ownerType => {
    await f.db.update(storeProduct).set({ type: ownerType, relationId: ownerType === 2 ? 7 : 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(systemSupplier).set({ isShow: 1, isDel: 0 }).where(eq(systemSupplier.id, 7));
    await profiles(async (app, admin) => {
      const adminService = new AdminSeckillActivityService(createContainerFromDb(admin.db), f.env.APP_KEY);
      const day = new Date(Date.now() + 28_800_000).toISOString().slice(0, 10);
      const input = { name: '真实角色父活动', start_day: day, end_day: day, time_ids: [101], num: 10, once_num: 3, image: '', status: 1,
        products: [{ child_id: null as number | null, product_id: 70, status: 1, skus: [{ id: null as number | null,
          base_unique: 'qared001', price: '6.25', quota_total: 6, enabled: true }] }] };
      const made = await adminService.mutate('create', undefined, { ...input, request_id: crypto.randomUUID() }, { id: 1 });
      const first = await adminService.detail(made.id), product = first.products[0], sku = product.skus[0];
      expect(await app.exec(`SELECT type,relation_id,is_support_refund FROM public.store_seckill WHERE id=${product.child_id}`))
        .toEqual([{ type: ownerType, relation_id: ownerType === 2 ? 7 : 0, is_support_refund: 1 }]);
      const [inherited] = await app.exec(`SELECT settle_price,cost,brokerage FROM public.store_product_attr_value WHERE id=${sku.id}`);
      expect(inherited).toEqual({ settle_price: '2.50', cost: '2.00', brokerage: '0.30' });
      await f.db.update(storeCart).set({ activityId: product.child_id }).where(eq(storeCart.id, 1));
      const sourceBefore = await app.exec('SELECT to_jsonb(t) AS row FROM public.store_product t WHERE id=70');
      const http = publicHttp(app), purchase = { ...publicInput(), seckillId: product.child_id };
      const quote = await http.post('/confirm', purchase); expect(quote.status, quote.msg).toBe(200);
      const body = { ...purchase, quoteToken: quote.data.quoteToken, requirePurchaseOrigin: false };
      const bought = await http.post(`/create/${quote.data.orderKey}`, body); expect(bought.status, bought.msg).toBe(200);
      const consumed = await adminService.detail(made.id);
      expect(consumed.products[0].skus[0]).toMatchObject({ id: sku.id, unique: sku.unique, consumed: 2, remaining: 4 });
      const edit = { ...input, request_id: crypto.randomUUID(), revision: consumed.revision,
        products: [{ ...input.products[0], child_id: product.child_id,
          skus: [{ ...input.products[0].skus[0], id: sku.id, quota_total: 7 }] }] };
      await adminService.mutate('update', made.id, edit, { id: 1 });
      const adjusted = await adminService.detail(made.id);
      expect(adjusted.products[0].skus[0]).toMatchObject({ id: sku.id, unique: sku.unique, consumed: 2, remaining: 5, quota_total: 7 });
      await adminService.mutate('update', made.id, { ...edit, request_id: crypto.randomUUID(), revision: adjusted.revision,
        products: [{ ...edit.products[0], status: 0, skus: [{ ...edit.products[0].skus[0], enabled: false }] }] }, { id: 1 });
      expect(await app.exec(`SELECT is_retired,quota,quota_show FROM public.store_product_attr_value WHERE id=${sku.id}`))
        .toEqual([{ is_retired: 1, quota: 5, quota_show: 7 }]);
      expect((await http.post('/cancel', { order_id: 'actual_app_seckill_order' })).status).toBe(200);
      expect(await app.exec(`SELECT id,"unique",is_retired,stock,quota,quota_show FROM public.store_product_attr_value WHERE id=${sku.id}`))
        .toEqual([{ id: sku.id, unique: sku.unique, is_retired: 1, stock: 7, quota: 7, quota_show: 7 }]);
      expect(await app.exec(`SELECT id,status,stock,quota,quota_show FROM public.store_seckill WHERE id=${product.child_id}`))
        .toEqual([{ id: product.child_id, status: 0, stock: 7, quota: 7, quota_show: 7 }]);
      expect(await app.exec('SELECT to_jsonb(t) AS row FROM public.store_product t WHERE id=70')).toEqual(sourceBefore);
      const recovered = await businessState();
      expect((await http.post('/cancel', { order_id: 'actual_app_seckill_order' })).status).toBe(400);
      expect(await businessState()).toEqual(recovered);
    });
  }, 60_000);

  it('signs an owned supplier product image under actual app LOGIN and refuses a cross-supplier reference', async () => {
    await f.db.update(systemSupplier).set({isShow:1,isDel:0}).where(eq(systemSupplier.id,7));
    await f.db.insert(systemAttachment).values([71,72].map(attId=>({attId,type:4,relationId:attId===71?7:8,moduleType:1,
      fileType:1,imageType:8,attType:'image/png',attDir:`/api/assets/${attId}`,name:`attachments/supplier/${attId===71?7:8}/runtime-image-${attId}.png`})));
    await f.db.update(storeSeckill).set({type:2,relationId:7,image:'/api/assets/71'}).where(eq(storeSeckill.id,20));
    await profiles(async app=>{
      const media=new ActivityService(createContainerFromDb(app.db),f.env),before=await businessState();
      const rows=await media.seckillList('101');expect(rows).toHaveLength(1);
      const url=new URL(rows[0].image,'https://local.invalid'),expires=Number(url.searchParams.get('expires'));
      expect(url.pathname).toBe('/api/assets/71');expect(expires).toBeGreaterThan(Math.floor(Date.now()/1000));
      expect(url.searchParams.get('signature')).toBe(createHmac('sha256',f.env.APP_KEY).update(`GET\n/api/assets/71\n${expires}`).digest('base64url'));
      expect(await businessState()).toEqual(before);
      await f.db.update(storeSeckill).set({image:'/api/assets/72'}).where(eq(storeSeckill.id,20));
      expect((await media.seckillList('101'))[0].image).toBe('');
      expect(await app.exec('SELECT image FROM public.store_seckill WHERE id=20')).toEqual([{image:'/api/assets/72'}]);
    });
  },60_000);

  it.each(['parent', 'slot'] as const)('serializes real app purchase and real Admin %s close, then restores stock through the closed schedule', async target => {
    await profiles(async (app, admin) => {
      const adminContainer = createContainerFromDb(admin.db);
      const parentService = new AdminSeckillActivityService(adminContainer, f.env.APP_KEY);
      const slotService = new AdminSeckillTimeService(adminContainer, f.env.APP_KEY);
      const revision = target === 'parent' ? (await parentService.detail(9)).revision : (await slotService.detail(101)).revision;
      await f.withPeer(async blocker => {
        await blocker.exec('BEGIN; SELECT id FROM public.store_cart WHERE id=1 FOR UPDATE');
        try {
          const buyer = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(app.db),
            { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'actual_concurrent_seckill' }, createInput()));
          await waitForFinanceBlock(f.db, app.pid, blocker.pid);
          const close = outcome((target === 'parent' ? parentService : slotService).mutate('status', target === 'parent' ? 9 : 101,
            { revision, request_id: crypto.randomUUID(), status: 0 }, { id: 1 }));
          await waitForFinanceBlock(f.db, admin.pid, app.pid);
          await blocker.exec('COMMIT');
          expect(await buyer).toMatchObject({ ok: true });
          const closed = await close;
          if (target === 'parent') {
            // Inventory changed under the displayed graph revision while the
            // Admin fence waited. A fresh confirmation is required.
            expect(closed).toMatchObject({ ok: false, error: { message: expect.stringContaining('已更新') } });
            await parentService.mutate('status', 9, { revision: (await parentService.detail(9)).revision,
              request_id: crypto.randomUUID(), status: 0 }, { id: 1 });
          } else expect(closed).toMatchObject({ ok: true });
        } finally { await blocker.exec('ROLLBACK'); }
      });
      expect(await app.exec('SELECT stock,quota FROM public.store_seckill WHERE id=20')).toEqual([{ stock: 6, quota: 6 }]);
      expect((await publicHttp(app).post('/cancel', { order_id: 'actual_concurrent_seckill' })).status).toBe(200);
      expect(await app.exec('SELECT stock,quota FROM public.store_seckill WHERE id=20')).toEqual([{ stock: 8, quota: 8 }]);
      expect(await app.exec('SELECT stock,quota FROM public.store_product_attr_value WHERE id=3')).toEqual([{ stock: 8, quota: 8 }]);
      expect(await app.exec(`SELECT status FROM public.${target === 'parent' ? 'store_activity' : 'store_seckill_time'} WHERE id=${target === 'parent' ? 9 : 101}`))
        .toEqual([{ status: 0 }]);
    });
  }, 60_000);
});
