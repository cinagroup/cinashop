import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct, storeProductAttrResult, storeProductAttrValue, storeProductStockRecord,
  storeProductVirtual, storeCart, storeOrder, storeOrderCartInfo } from '@/models/schema';
import { SUPPLIER_COPY_FIELDS } from '@/services/supplier/SupplierProductCopySource';
import { supplierSkuBatchFixture, supplierSkuBatchValues } from './helpers/supplierSkuBatch';
import { supplierSystemFormCheckoutFixture } from './helpers/supplierProductSystemForms';

const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
type WireSku = Record<string, any>;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier physical multi-SKU batch payload through real App JWT and owned independent PG16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierSkuBatchFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned SKU batch scenario forbids outbound I/O'));
    f = await supplierSkuBatchFixture(); wiring.container = f.container;
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { await f?.close(); wiring.container = null; vi.restoreAllMocks(); }
  }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<{ status: number; msg: string; data: any }>();
  }
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  async function batchBody(id = 80) {
    const body = await f.body({}, id);
    // The browser/unit suite owns exact dimension targeting. This native suite
    // submits the resulting complete payload; no fake batch endpoint exists.
    body.attrs = (body.attrs as WireSku[]).map(row => row.detail.颜色 === '红' ? { ...row, ...supplierSkuBatchValues } : row);
    return body;
  }
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), sequences = await f.sequences();
    await work(); expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }
  async function preserved(before: Awaited<ReturnType<typeof f.snapshot>>, main: Awaited<ReturnType<typeof root>>, id = 80) {
    const current = await f.snapshot(), after = await root(id);
    for (const key of ['autoOnTime','autoOffTime','brandId','brandCom','ensureId','specsId','specs','labelId','commandWord','customForm',
      'systemFormId','addTime','sales','spu','price','cost','otPrice','vipPrice'] as const) expect(after[key], key).toEqual(main[key]);
    const mutable = ['store_product','store_product_attr','store_product_attr_result','store_product_attr_value','store_product_relation','store_product_stock_record'];
    for (const name of Object.keys(before)) if (!mutable.includes(name)) expect(current[name], name).toEqual(before[name]);
    const withoutTarget = (entries: any[], productKey: string) => entries.filter(entry => entry.row[productKey] !== id);
    expect(withoutTarget(current.store_product, 'id')).toEqual(withoutTarget(before.store_product, 'id'));
    for (const name of mutable.filter(name => name !== 'store_product'))
      expect(withoutTarget(current[name], 'product_id'), name).toEqual(withoutTarget(before[name], 'product_id'));
    expect(current.store_product_relation.filter(entry => entry.row.product_id === id && entry.row.type !== 1))
      .toEqual(before.store_product_relation.filter(entry => entry.row.product_id === id && entry.row.type !== 1));
  }

  it('reads all four active identities plus a separate historical retired SKU through a minimum SELECT-only viewer', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const read = await request('GET', '/product/product/80', undefined, 'viewer'); expect(read.status, read.msg).toBe(200);
      expect(read.data.items).toEqual(f.dimensions); expect(read.data.attrs.map((row: WireSku) => row.suk)).toEqual(['红,S','红,M','蓝,S','蓝,M']);
      expect(read.data.attrs.map((row: WireSku) => row.id)).toEqual([8001,8002,8003,8004]);
      expect(read.data.retired_attrs).toHaveLength(1); expect(read.data.retired_attrs[0]).toMatchObject({ id: 8099, unique: 'sbtold01', is_retired: 1 });
      expect(JSON.stringify(read.data)).not.toContain('UNCHANGED-CUSTOMER-ANSWER'); expect(read.data).not.toHaveProperty('custom_form');
    });
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      NOT has_table_privilege(current_user,'store_product_attr_value','INSERT,UPDATE,DELETE') AS readonly,
      NOT has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_private`);
    expect(rights).toEqual({ independent: true, readonly: true, answers_private: true });
  }));

  it('persists seven fields for the two exact selected rows with stable identities and exact stock delta ledgers while keeping every other SKU and hidden field', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await f.snapshot(), main = await root(), rows = await f.rows();
    const ledgers = await f.db.select().from(storeProductStockRecord).orderBy(asc(storeProductStockRecord.id));
    const saved = await request('POST', '/product/product/80', await batchBody()); expect(saved.status, saved.msg).toBe(200);
    const actual = await f.rows(); expect(actual).toHaveLength(5);
    for (let index = 0; index < rows.length; index++) {
      const old = rows[index], next = actual[index];
      if (!old.suk.startsWith('红,')) expect(next).toEqual(old);
      else {
        expect(next).toEqual({ ...old, image: '/api/assets/31', settlePrice: '7.65', stock: 20,
          barCode: 'BATCH-BARCODE', code: 'BATCH-CODE', weight: '1.20', volume: '0.35', sumStock: old.sumStock + 20 - old.stock });
      }
    }
    expect(await root()).toMatchObject({ stock: 56, settlePrice: '7.65', isShow: 0, isVerify: 0 });
    const afterLedgers = await f.db.select().from(storeProductStockRecord).orderBy(asc(storeProductStockRecord.id));
    expect(afterLedgers.slice(0, ledgers.length)).toEqual(ledgers);
    expect(afterLedgers.slice(ledgers.length).map(row => ({ unique: row.unique, number: row.number, pm: row.pm, costPrice: row.costPrice })))
      .toEqual([{ unique: 'sbtred01', number: 17, pm: 1, costPrice: '4.03' }, { unique: 'sbtred02', number: 15, pm: 1, costPrice: '5.03' }]);
    const read = await request('GET', '/product/product/80'); expect(read.status, read.msg).toBe(200);
    expect(read.data.attrs[0]).toMatchObject({ id: 8001, unique: 'sbtred01', image: '/api/assets/31', settle_price: '7.65',
      bar_code: 'BATCH-BARCODE', code: 'BATCH-CODE', weight: '1.20', volume: '0.35', stock: 20, price: '20.01', cost: '4.03' });
    const preview = read.data.media.previews['/api/assets/31']; expect(preview.status).toBe('ready'); expect(preview.src).toContain('/api/assets/31?expires=');
    const asset = await app.request(preview.src, {}, f.env); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toBe('image/png');
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0); expect(f.objectReads).toEqual(['attachments/supplier/7/batch.png']);
    await preserved(before, main);
  }));

  it('round trips the unchanged complete SKU payload without stock ledger growth after a zero-or-empty batch draft has been skipped in the UI', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await f.snapshot(), main = await root(), rows = await f.rows();
    const saved = await request('POST', '/product/product/80', await f.body()); expect(saved.status, saved.msg).toBe(200);
    expect(await f.rows()).toEqual(rows);
    expect((await f.snapshot()).store_product_stock_record).toEqual(before.store_product_stock_record);
    await preserved(before, main);
  }));

  it('creates four new physical SKU identities from a complete locally authored payload without copying historical unique values', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const body = await batchBody(); body.attrs = (body.attrs as WireSku[]).map(({ id: _id, unique: _unique, ...row }) => row);
    const before = await f.rows(), saved = await request('POST', '/product/product', body); expect(saved.status, saved.msg).toBe(200);
    const created = await f.rows(saved.data.id); expect(created).toHaveLength(4); expect(created.every(row => row.id > 8099 && row.sales === 0 && row.isRetired === 0)).toBe(true);
    expect(new Set(created.map(row => row.unique)).size).toBe(4);
    expect(created.every(row => !before.some(old => old.unique === row.unique))).toBe(true); expect(await f.rows()).toEqual(before);
    expect(await root(saved.data.id)).toMatchObject({ type: 2, relationId: 7, productType: 0, specType: 1, stock: 56, isShow: 0, isVerify: 0 });
  }));

  it.each(['javascript:alert(1)', '/api/assets/32', '/api/assets/999'])('rejects unsafe unavailable or foreign batch image %s with zero database or sequence writes', async image => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const body = await batchBody(); body.attrs = (body.attrs as WireSku[]).map(row => ({ ...row, image }));
      expect((await request('POST', '/product/product/80', body)).status).toBe(400);
    });
  }));

  it('requires current manage authority and real ownership rather than the selected tenant header for a complete batch payload', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await batchBody();
    await unchanged(async () => {
      for (const actor of ['viewer','denied'] as const) expect((await request('POST', '/product/product/80', body, actor)).status).toBe(400011);
      expect((await request('POST', '/product/product/80', body, 'anonymous')).status).toBe(410000);
      expect((await request('POST', '/product/product/80', body, 'other')).status).toBe(404);
      expect((await request('POST', '/product/product/90', body)).status).toBe(404);
    });
  }));

  it('preserves the mature empty-SKU-image fallback while keeping the submitted empty editor snapshot', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const body = await f.body(); (body.attrs as WireSku[])[0].image = '';
    const saved = await request('POST', '/product/product/80', body); expect(saved.status, saved.msg).toBe(200);
    expect((await f.rows())[0].image).toBe((await root()).image.slice(0,128));
    const [result] = await f.db.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId,80));
    expect(JSON.parse(result.result).value[0].image).toBe('');
  }));

  it.each([
    { field: 'image', column: 'image', corrupt: '/owned-media/rewritten.png' },
    { field: 'barCode', column: 'bar_code', corrupt: 'REWRITTEN-BARCODE' },
    { field: 'code', column: 'code', corrupt: 'REWRITTEN-CODE' },
    { field: 'weight', column: 'weight', corrupt: '9.91' },
    { field: 'volume', column: 'volume', corrupt: '9.92' },
  ] as const)('rejects an executable actual $column rewrite instead of returning a false seven-field save receipt', async ({ field, column, corrupt }) => f.withWriter(async runtime => {
    await f.exec(`CREATE FUNCTION owned_sku_batch_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id=80 AND NEW.suk='红,S' THEN NEW.${column}='${corrupt}'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER owned_sku_batch_rewrite BEFORE UPDATE OF ${column} ON public.store_product_attr_value FOR EACH ROW EXECUTE FUNCTION owned_sku_batch_rewrite()`);
    const rollback = Error('owned positive control rollback');
    try {
      await f.db.transaction(async tx => {
        await tx.update(storeProductAttrValue).set({ [field]: field === 'weight' || field === 'volume' ? '1.01' : 'owner-control' }).where(eq(storeProductAttrValue.id,8001));
        const [control] = await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,8001)); expect(control[field]).toBe(corrupt);
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    wiring.container = runtime.container; const before = await f.snapshot();
    const saved = await request('POST', '/product/product/80', await batchBody()); expect(saved.status, saved.msg).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  }));

  it('rejects an executable skipped SKU UPDATE and rolls back all earlier product and stock writes', async () => f.withWriter(async runtime => {
    await f.exec("CREATE FUNCTION owned_sku_batch_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id=80 AND NEW.suk='红,S' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_sku_batch_skip BEFORE UPDATE ON public.store_product_attr_value FOR EACH ROW EXECUTE FUNCTION owned_sku_batch_skip()");
    const control = await f.db.update(storeProductAttrValue).set({ barCode: 'MUST-BE-SKIPPED' }).where(eq(storeProductAttrValue.id,8001)).returning();
    expect(control).toEqual([]); expect((await f.rows())[0].barCode).toBe('BAR-0');
    wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', await batchBody())).status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
  }));

  it('rejects executable SKU snapshot corruption even when all actual seven-field columns match', async () => f.withWriter(async runtime => {
    await f.exec("CREATE FUNCTION owned_sku_batch_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id=80 THEN NEW.result=jsonb_set(NEW.result::jsonb,'{value,0,barCode}','\"SNAPSHOT-REWRITTEN\"'::jsonb)::text; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_sku_batch_snapshot BEFORE INSERT ON public.store_product_attr_result FOR EACH ROW EXECUTE FUNCTION owned_sku_batch_snapshot()");
    const rollback = Error('owned snapshot positive control rollback');
    try {
      await f.db.transaction(async tx => {
        const [old] = await tx.select().from(storeProductAttrResult).where(eq(storeProductAttrResult.productId,80));
        const [control] = await tx.insert(storeProductAttrResult).values({ productId:80,type:0,result:old.result,changeTime:1 }).returning();
        expect(JSON.parse(control.result).value[0].barCode).toBe('SNAPSHOT-REWRITTEN'); throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
    wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', await batchBody())).status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
  }));

  it('keeps retired identities and the existing card inventory authority outside the physical batch tool', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const retired = (await f.rows()).find(row => row.isRetired === 1), cards = await f.db.select().from(storeProductVirtual);
    const control = await request('POST', '/product/product/81', await f.body({},81)); expect(control.status, control.msg).toBe(200);
    const before = await f.snapshot();
    const body = await f.body({},81); (body.attrs as WireSku[])[0].stock = 2;
    expect((await request('POST', '/product/product/81', body)).status).toBe(400);
    // This late rejection may consume non-transactional sequence values;
    // every actual business row, including inventory and audit, rolls back.
    expect(await f.snapshot()).toEqual(before);
    expect(await f.db.select().from(storeProductVirtual)).toEqual(cards); expect((await f.rows()).find(row => row.isRetired === 1)).toEqual(retired);
  }));

  it('copies four active SKUs using the mature UUID HMAC receipt and then saves the copied physical SKU payload through an independent LOGIN', async () => f.withCopyWriter(async runtime => {
    wiring.container = runtime.container; const source = await f.rows(), main = await root();
    const seed = await request('GET', '/product/product/copy/80'); expect(seed.status, seed.msg).toBe(200);
    const operationId = crypto.randomUUID(), body = { operation_id: operationId, copy_token: seed.data.copy.token,
      product: Object.fromEntries(SUPPLIER_COPY_FIELDS.map(field => [field, seed.data.product[field]])) };
    const copied = await request('POST', '/product/product/copy/80', body); expect(copied.status, copied.msg).toBe(200); expect(copied.data.state).toBe('committed');
    const id = copied.data.result.id, copiedRows = await f.rows(id); expect(copiedRows).toHaveLength(4);
    expect(copiedRows.every(row => row.sales === 0 && !source.some(old => old.unique === row.unique || old.id === row.id))).toBe(true);
    const receipt = await request('GET', `/product/product/copy_operations/${operationId}`); expect(receipt.status,receipt.msg).toBe(200); expect(receipt.data).toEqual(copied.data);
    const saved = await request('POST', `/product/product/${id}`, await batchBody(id)); expect(saved.status,saved.msg).toBe(200);
    const after = await f.rows(id); expect(after.map(row => row.unique)).toEqual(copiedRows.map(row => row.unique));
    expect(after.filter(row => row.suk.startsWith('红,')).every(row => row.barCode === 'BATCH-BARCODE' && row.settlePrice === '7.65')).toBe(true);
    expect(await f.rows()).toEqual(source); expect(await root()).toEqual(main);
    const [rights] = await runtime.db.execute(sql`SELECT NOT has_table_privilege(current_user,'supplier_product_copy_operation_v1','UPDATE,DELETE,TRUNCATE') AS immutable_receipt,
      NOT has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_private`);
    expect(rights).toEqual({ immutable_receipt:true,answers_private:true });
  }),60000);

  it('freezes the saved Supplier settlement in a real Customer order and preserves the old line after a later SKU edit', async () => {
    const checkout = await supplierSystemFormCheckoutFixture(f);
    try {
      await f.db.update(storeProduct).set({ systemFormId:0 }).where(eq(storeProduct.id,80));
      await f.withWriter(async runtime => { wiring.container=runtime.container;
        const saved=await request('POST','/product/product/80',await batchBody()); expect(saved.status,saved.msg).toBe(200); });
      // Distinct Admin review, required after an ordinary Supplier edit.
      await f.db.update(storeProduct).set({isShow:1,isVerify:1}).where(eq(storeProduct.id,80)); wiring.container=f.container;
      const customer=async(path:string,body:unknown)=>{
        const response=await app.request('/api'+path,{method:'POST',headers:{Authorization:'Bearer '+checkout.token,'Content-Type':'application/json'},body:JSON.stringify(body)},f.env);
        return response.json<{status:number;msg:string;data:any}>();
      };
      const [cart]=await f.db.insert(storeCart).values({uid:11,productId:80,productAttrUnique:'sbtred01',cartNum:1,isNew:1,status:1}).returning();
      const input={cartIds:[cart.id],addressId:11,shippingType:1,useIntegral:false};
      const confirm=await customer('/order/confirm',input);expect(confirm.status,confirm.msg).toBe(200);
      const created=await customer('/order/create/'+confirm.data.orderKey,{...input,quoteToken:confirm.data.quoteToken,customForm:[]}); expect(created.status,created.msg).toBe(200);
      const [order]=await f.db.select().from(storeOrder).where(eq(storeOrder.orderId,created.data.orderId));
      const [line]=await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
      expect(line).toMatchObject({productId:80,skuUnique:'sbtred01',settlePrice:'7.65',cartNum:1}); expect(order.totalPrice).toBe('20.01');
      await f.withWriter(async runtime=>{wiring.container=runtime.container;const body=await batchBody();(body.attrs as WireSku[])[0].settle_price='8.76';
        const saved=await request('POST','/product/product/80',body);expect(saved.status,saved.msg).toBe(200);});
      expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,line.id)))[0]).toEqual(line);
      expect((await f.rows()).find(row=>row.unique==='sbtred01')?.settlePrice).toBe('8.76');
    } finally { await checkout.close(); }
  },60000);
});
