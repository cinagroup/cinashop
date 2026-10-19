import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, storePromotions,
  storePromotionsAuxiliary, systemAdmin, systemRole, systemSupplier } from '@/models/schema';
import { AdminFullGiftService } from '@/services/admin/AdminFullGiftService';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { SupplierOrderReadService } from '@/services/supplier/SupplierOrderReadService';
import { SupplierSplitOrderReadService } from '@/services/supplier/SupplierSplitOrderReadService';
import { SupplierOperationalReadService } from '@/services/supplier/SupplierOperationalReadService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { createToken, md5 } from '@/utils/jwt';
import { supplierOrderGiftIdentityFixture } from './helpers/supplierOrderGiftIdentity';
import { refundRuntimeFixture, shipping } from './helpers/refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing independent gift identity LOGIN'); return wiring.container;
} }));
type Surface = 'detail' | 'shipment' | 'pending';
type Envelope = { status: number; msg: string; data: any };
const app = createApp();
const path = (surface: Surface, id: number) => `/supplierapi/order/${surface === 'detail' ? 'info' : surface === 'shipment' ? 'split_order' : 'split_cart_info'}/${id}`;
const items = (surface: Surface, data: any): Array<{ id: number; is_gift: number; quantity?: number; cart_num?: number }> =>
  surface === 'detail' ? data.review.items : surface === 'pending' ? data : data.flatMap((order: any) => order.cart_info);
const surfaces = ['detail', 'shipment', 'pending'] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier protected purchase/gift identity actual App JWT SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderGiftIdentityFixture>>;
  beforeEach(async () => {
    f = await supplierOrderGiftIdentityFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Gift identity must not query providers'));
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function unchanged<T>(work: () => Promise<T>) {
    const before = await f.snapshot(), seq = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); return result;
  }
  async function request(surface: Surface, id = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer') {
    return unchanged(async () => (await app.request(path(surface, id), { headers: actor === 'anonymous' ? {}
      : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env)).json<Envelope>());
  }
  async function read(surface: Surface, id = 100, actor: keyof typeof f.tokens = 'viewer') {
    const response = await request(surface, id, actor); expect(response.status, response.msg).toBe(200); return response.data;
  }

  it.each([{ actor: 'viewer' }, { actor: 'manager' }] as const)('reads all three actual surfaces with $actor JWT and a genuine SELECT-only LOGIN', async ({ actor }) => f.withReader(async peer => {
    wiring.container = peer.container;
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      has_column_privilege(current_user,'store_order_cart_info','is_gift','SELECT') AS gift_read,
      has_any_column_privilege(current_user,'store_order_cart_info','UPDATE') AS cart_write,
      has_any_column_privilege(current_user,'store_order','UPDATE') AS order_write,
      has_schema_privilege(current_user,'public','CREATE') AS creates,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns`);
    expect(rights).toEqual({ independent: true, gift_read: true, cart_write: false, order_write: false, creates: false, owns: 0 });
    for (const surface of surfaces) {
      const actual = items(surface, await read(surface, 100, actor));
      expect(actual.map(item => ({ id: item.id, is_gift: item.is_gift, quantity: item.quantity ?? item.cart_num }))).toEqual(f.expectedGiftItems);
      expect(actual.every(item => Object.hasOwn(item, 'is_gift'))).toBe(true);
    }
  }));

  it('keeps a real recorded zero-priced purchase distinct from a gift', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const detail = await read('detail', 111);
    expect(detail.review.items).toMatchObject([{ is_gift: 0, settlement_unit: '0.00', settlement_subtotal: '0.00' }]);
    expect(detail.cart_info[0].isGift).toBe(0);
  }));

  it.each([{ protectedFlag: 0, jsonFlag: 1 }, { protectedFlag: 1, jsonFlag: 0 }] as const)
    ('uses row flag $protectedFlag despite JSON flag $jsonFlag on each surface', async ({ protectedFlag, jsonFlag }) => f.withReader(async peer => {
      wiring.container = peer.container;
      const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1002));
      const snapshot = { ...JSON.parse(row.cartInfo!), is_gift: jsonFlag, isGift: jsonFlag };
      await f.db.update(storeOrderCartInfo).set({ isGift: protectedFlag, cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, row.id));
      for (const surface of surfaces) expect(items(surface, await read(surface)).find(item => item.id === row.id)?.is_gift).toBe(protectedFlag);
      expect((await read('detail')).cart_info.find((item: any) => item.id === row.id).cartInfo).toBe(JSON.stringify(snapshot));
    }));

  it('reads legacy gifts from their row flag without inventing a current campaign or trusting opposite legacy JSON', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const surface of ['detail', 'shipment'] as const) expect(items(surface, await read(surface, 301)).find(item => item.id === 3011)?.is_gift).toBe(1);
    const detail = await read('detail', 301);
    expect(detail.review.items.find((item: any) => item.id === 3011)).toMatchObject({ product_name: '旧赠品礼盒', settlement_unit: null });
    expect(detail.review.promotions).toMatchObject({ basis: 'legacy', total: '3.00' });
  }));

  it('retains exact per-child identity and pending remainder quantities without borrowing the platform root', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const shipments = await read('shipment', 201);
    expect(shipments.map((order: any) => order.id)).toEqual([201, 202]);
    for (const child of shipments) expect(child.cart_info.map((item: any) => [item.is_gift, item.cart_num])).toEqual([[0, 1], [1, 1]]);
    expect(items('pending', await read('pending', 200)).map(item => [item.id, item.is_gift, item.cart_num])).toEqual([[2003, 0, 1], [2021, 1, 1]]);
    expect((await request('detail', 300)).status).toBe(404);
    expect((await read('shipment', 301)).map((order: any) => order.id)).toEqual([301]);
  }));

  it('does not change gift identity or frozen item text when current product and SKU values change', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const before = (await read('detail')).review.items;
    await f.db.update(storeProduct).set({ storeName: '当前改名', price: '777.00', isDel: 1 }).where(eq(storeProduct.id, 81));
    await f.db.update(storeProductAttrValue).set({ price: '555.00', settlePrice: '444.00', suk: '当前规格' }).where(eq(storeProductAttrValue.id, 81));
    expect((await read('detail')).review.items).toEqual(before);
  }));

  it.each(surfaces.flatMap(surface => [-1, 2].map(flag => ({ surface, flag }))))
    ('rejects actual invalid row flag $flag on $surface instead of coercing it', async ({ surface, flag }) => f.withReader(async peer => {
      wiring.container = peer.container;
      await f.db.update(storeOrderCartInfo).set({ isGift: flag }).where(eq(storeOrderCartInfo.id, 1002));
      expect(await request(surface)).toMatchObject({ status: 400, data: null });
    }));

  it.each(surfaces)('rejects actual NULL history on %s after an explicit owned-fixture nullability alteration', async surface => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.exec('ALTER TABLE public.store_order_cart_info ALTER COLUMN is_gift DROP NOT NULL');
    await f.exec('UPDATE public.store_order_cart_info SET is_gift=NULL WHERE id=1002');
    expect(await request(surface)).toMatchObject({ status: 400, data: null });
  }));

  it('checks the complete cart flags before filtering consumed pending rows and before projecting the shared picking read', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ isGift: 2, splitStatus: 2, splitSurplusNum: 0 }).where(eq(storeOrderCartInfo.id, 1002));
    expect(await request('pending')).toMatchObject({ status: 400, data: null });
    await f.exec(`GRANT SELECT ON public.system_supplier TO "${peer.role}"`);
    await unchanged(async () => {
      const response = await app.request('/supplierapi/order/distribution_info?ids=100', { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env);
      expect(await response.json<Envelope>()).toMatchObject({ status: 400, data: null });
    });
  }));

  it.each(surfaces)('preserves real missing is_gift SELECT permission on %s as an SQL failure', async surface => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.exec(`REVOKE SELECT ON public.store_order_cart_info FROM "${peer.role}"`);
    const columns = (await f.exec("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='store_order_cart_info' AND column_name<>'is_gift' ORDER BY ordinal_position") as Array<{ column_name: unknown }>).map(row => {
      if (typeof row.column_name !== 'string' || !/^[a-z_]+$/.test(row.column_name)) throw Error('Unexpected owned cart column');
      return '"' + row.column_name + '"';
    });
    await f.exec(`GRANT SELECT(${columns.join(',')}) ON public.store_order_cart_info TO "${peer.role}"`);
    const [rights] = await peer.db.execute(sql`SELECT has_column_privilege(current_user,'store_order_cart_info','is_gift','SELECT') AS reads`);
    expect(rights.reads).toBe(false);
    await expect(surface === 'detail' ? new SupplierOrderReadService(peer.container).detail(7, 100, f.env.APP_KEY)
      : surface === 'shipment' ? new SupplierSplitOrderReadService(peer.container).read(7, 100)
        : new SupplierOperationalReadService(peer.container).splitCartInfo(7, 100)).rejects.toMatchObject({ cause: { code: '42501' } });
    const result = await request(surface); expect(result.status).not.toBe(200); expect(result.data).toBeNull();
  }));

  it.each(surfaces.flatMap(surface => [{ surface, field: 'uid' }, { surface, field: 'relationId' }] as const))
    ('rejects wrong cart $field on $surface without partial gift disclosure', async ({ surface, field }) => f.withReader(async peer => {
      wiring.container = peer.container;
      await f.db.update(storeOrderCartInfo).set(field === 'uid' ? { uid: 12 } : { relationId: 8 }).where(eq(storeOrderCartInfo.id, 1002));
      expect(await request(surface)).toMatchObject({ status: 400, data: null });
    }));

  it.each([{ actor: 'anonymous', id: 100 }, { actor: 'denied', id: 100 }, { actor: 'foreign', id: 100 },
    { actor: 'viewer', id: 900 }, { actor: 'customer', id: 100 }, { actor: 'admin', id: 100 }] as const)
    ('enforces actual JWT/client/tenant denial for $actor/$id on all surfaces', async ({ actor, id }) => f.withReader(async peer => {
      wiring.container = peer.container;
      for (const surface of surfaces) { const result = await request(surface, id, actor); expect(result.status).not.toBe(200); expect(result.data).toBeNull(); }
    }));

  it.each(surfaces)('uses a single read-only repeatable-read snapshot for %s after an independent gift-flag commit', async surface => f.withReader(async peer => {
    wiring.container = peer.container; let reached = false, committed: unknown;
    await peer.exec('SET statement_timeout=0');
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (/from "store_order_cart_info"/.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared);
        prepared.execute = async values => {
          const result = await execute(values);
          if (!reached) {
            reached = true;
            const [settings] = await this.client.unsafe(`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
            expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
            await f.db.update(storeOrderCartInfo).set({ isGift: 0 }).where(eq(storeOrderCartInfo.id, 1002)); committed = await f.snapshot();
          }
          return result;
        };
      }
      return prepared;
    });
    const seq = await f.sequences();
    try {
      const response = await app.request(path(surface, 100), { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env);
      const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
      expect(items(surface, result.data).find(item => item.id === 1002)?.is_gift).toBe(1);
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(committed); expect(await f.sequences()).toEqual(seq);
    expect(items(surface, await read(surface)).find(item => item.id === 1002)?.is_gift).toBe(0);
    const [settings] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
    expect(settings).toEqual({ readonly: 'off', timeout: '0' });
  }), 30000);

  it.each([{ mode: 'fulfillment' }, { mode: 'supplier-allocation' }] as const)
    ('connects actual Admin type4 author and same-owner gift checkout to $mode then all Supplier reads without SQL writes', async ({ mode }) => {
      const whole = await refundRuntimeFixture();
      try {
        const password = 'owned-gift-identity-actual', key = f.env.APP_KEY;
        await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.order.view' });
        await whole.db.insert(systemAdmin).values({ id: 990, account: 'gift-actual-reader', pwd: password, adminType: 4, relationId: 7, roles: '990' });
        await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
        await whole.db.insert(storeProduct).values({ id: 81, type: 2, relationId: 7, storeName: '真实Supplier赠品',
          price: '99.00', stock: 10, isShow: 1, isVerify: 1, deliveryType: '1', freight: 1 });
        await whole.db.insert(storeProductAttrValue).values({ id: 81, productId: 81, type: 0, unique: 'gift0081',
          suk: '真实礼盒', price: '99.00', settlePrice: '88.00', stock: 10 });
        if (mode === 'supplier-allocation') await whole.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 71));
        const date = (hours: number) => new Date(Date.now() + (hours + 8) * 3600000).toISOString().replace('T', ' ').slice(0, 19);
        // Actual mature Admin author, executed on the owned maintenance boundary;
        // not synthetic campaign SQL and not an independent Admin ACL claim.
        const campaign = await new AdminFullGiftService(createContainerFromDb(whole.db)).mutate('create', 0, {
          name: '真实Supplier赠品活动', section_time: [date(-1), date(24)], promotions_cate: 2, threshold_type: 2,
          promotions: [{ threshold: 1, give_integral: 0, give_coupon_id: [],
            give_product_id: [{ give_product_id: 81, unique: 'gift0081', give_product_num: 10 }] }],
          is_label: 0, label_id: [], product_partake_type: 2, product_id: [{ product_id: 70, unique: ['qared001'] }],
          brand_id: [], store_label_id: [], status: 1, sort: 0, request_id: '00000000-0000-4000-8000-000000000001',
        }, { id: 9 });
        expect((await whole.db.select().from(storePromotions).where(eq(storePromotions.id, campaign.id)))[0]).toMatchObject({ promotionsType: 4, type: 1, storeId: 0 });
        const token = (await createToken(990, 'supplier', md5(password), key)).token;
        await whole.withRuntime(async writer => {
          if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(writer.role)) throw Error('Unowned gift writer');
          // Actual gift reservation needs quota UPDATE. No auxiliary INSERT or
          // DELETE, and no production role changes or coupon/points grant claim.
          await whole.exec(`GRANT SELECT ON public.store_promotions_auxiliary TO "${writer.role}"`);
          await whole.exec(`GRANT UPDATE(surplus_num) ON public.store_promotions_auxiliary TO "${writer.role}"`);
          const [rights] = await writer.db.execute(sql`SELECT has_table_privilege(current_user,'store_promotions_auxiliary','SELECT') AS reads,
            has_column_privilege(current_user,'store_promotions_auxiliary','surplus_num','UPDATE') AS reserves,
            has_table_privilege(current_user,'store_promotions_auxiliary','INSERT') AS inserts,
            has_table_privilege(current_user,'store_promotions_auxiliary','DELETE') AS deletes`);
          expect(rights).toEqual({ reads: true, reserves: true, inserts: false, deletes: false });
          const created = await writer.checkout({ key: 'gift-' + mode, orderId: mode === 'fulfillment' ? 'gift_fulfill' : 'gift_allocate' });
          const [unpaid] = await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
          const originalRows = await writer.carts(unpaid.id), gifts = originalRows.filter(row => row.isGift === 1);
          expect(gifts).toHaveLength(1); expect(gifts[0]).toMatchObject({ productId: 81, type: 2, relationId: 7, uid: 11, cartNum: 2, settlePrice: '0.00' });
          expect(JSON.parse(gifts[0].cartInfo!)).toMatchObject({ promotion_gift: { root_id: campaign.id }, sku: { price: '0.00' } });
          expect((await whole.db.select().from(storeProduct).where(eq(storeProduct.id, 81)))[0].stock).toBe(8);
          expect((await whole.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 81)))[0].stock).toBe(8);
          expect((await whole.db.select().from(storePromotionsAuxiliary).where(eq(storePromotionsAuxiliary.type, 3)))[0].surplusNum).toBe(8);
          // Explicit synthetic paid admission; actual allocation and fulfillment
          // remain registered writers, not a provider/payment callback proof.
          const [paid] = await whole.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-ONLY' })
            .where(eq(storeOrder.id, unpaid.id)).returning();
          const allocated = await withTx(writer.container, async tx => {
            const result = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
            // Same registered supplier-payment author as refundRuntimeFixture's
            // createPaid; shipping must have its real pending settlement entry.
            for (const child of result.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
            return result;
          });
          let target = allocated.fulfillmentOrders.find(order => order.supplierId === 7)!;
          expect(target).toBeDefined();
          if (mode === 'fulfillment') {
            const rows = await writer.carts(target.id), gift = rows.find(row => row.isGift === 1)!, bought = rows.find(row => row.productId === 70)!;
            const split = await new SupplierFulfillmentService(writer.container, whole.env).splitDelivery(7, target.id, shipping,
              [{ cartId: bought.cartId, cartNum: 1 }, { cartId: gift.cartId, cartNum: 1 }]);
            target = await writer.order(split.remaining_order_id!);
            expect((await writer.carts(split.order_id)).filter(row => row.isGift === 1)).toMatchObject([{ cartNum: 1 }]);
          } else {
            expect(allocated.split).toBe(true);
            expect((await writer.carts(target.id)).filter(row => row.isGift === 1)).toMatchObject([{ cartNum: 2 }]);
          }
          await whole.withRuntimeRole!(async peer => {
            await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,
              public.store_order,public.store_order_cart_info,public.store_order_refund,public.store_order_invoice,
              public.store_order_promotions,public.store_promotions,public."user",public.system_attachment TO "${peer.role}"`);
            wiring.container = createContainerFromDb(peer.db);
            const [permission] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
              has_any_column_privilege(current_user,'store_order_cart_info','UPDATE') AS cart_write`);
            expect(permission).toEqual({ independent: true, cart_write: false });
            const state = async () => {
              const result: Record<string, unknown> = {};
              for (const table of (await whole.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(table.tablename)) throw Error('Unexpected gift table');
                result[table.tablename] = (await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
              }
              for (const sequence of (await whole.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(sequence.sequencename)) throw Error('Unexpected gift sequence');
                result['sequence:' + sequence.sequencename] = (await whole.query(`SELECT last_value,is_called FROM public."${sequence.sequencename}"`)).rows;
              }
              return result;
            };
            for (const surface of surfaces) {
              const before = await state(), response = await app.request(path(surface, target.id), { headers: { Authorization: 'Bearer ' + token } }, { ...whole.env, APP_KEY: key, NODE_ENV: 'test' });
              const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
              const projected = items(surface, result.data); expect(projected.some(item => item.is_gift === 1)).toBe(true);
              expect(projected.some(item => item.is_gift === 0)).toBe(true);
              const protectedRows = await writer.carts(target.id);
              for (const item of projected.filter(item => protectedRows.some(row => row.id === item.id))) {
                const row = protectedRows.find(row => row.id === item.id)!;
                expect(item.is_gift).toBe(row.isGift); expect(item.quantity ?? item.cart_num).toBe(row.cartNum);
              }
              expect(await state()).toEqual(before);
            }
          });
        });
      } finally { await whole.close(); }
    }, 120000);
});
