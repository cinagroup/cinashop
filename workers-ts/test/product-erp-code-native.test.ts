import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { systemConfig, storeProduct, storeProductAttrValue } from '@/models/schema';
import { ERP_CONFIG_LOCK } from '@/services/erp/ErpConnectionPolicy';
import { withScenario, type Scenario, type Writer } from './helpers/productErpCode';

async function policy(s: Scenario, value: string) {
  await s.f.db.delete(systemConfig).where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'erp_open')));
  await s.f.db.insert(systemConfig).values({ isStore: 0, menuName: 'erp_open', value });
}
const path = (writer: Writer, id = 0) => writer === 'supplier' ? '/supplierapi/product/product/' + id
  : writer === 'modern' ? id ? '/adminapi/product/edit/' + id : '/adminapi/product/add' : '/outapi/product' + (id ? '/' + id : '');
const input = (s: Scenario, writer: Writer, code = 'ERP-MAIN', skuCode = 'ERP-SKU', type = 0) => {
  const body = s.body(writer, type);
  return { ...body, code, attrs: (body.attrs as Record<string, unknown>[]).map(row => ({ ...row, code: skuCode })) };
};
const write = (s: Scenario, writer: Writer, body: object, id = 0, key = crypto.randomUUID()) =>
  s.request(writer === 'out' && id ? 'PUT' : 'POST', path(writer, id), body, s.token(writer), key);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('physical ERP merchant and SKU code admission on actual runtime profiles', () => {
  it.each((['modern', 'out'] as const).flatMap(writer => (['main', 'sku'] as const).map(missing => ({ writer, missing }))))
  ('rejects ERP enabled $writer create missing $missing code before business or sequence writes', async ({ writer, missing }) => withScenario(async s => {
    await policy(s, '1'); const body = input(s, writer, missing === 'main' ? '' : 'ERP-MAIN', missing === 'sku' ? '' : 'ERP-SKU');
    const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
    const result = await write(s, writer, body); expect(result.status, result.msg).toBe(400);
    expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequence);
  }), 120000);

  it.each(['modern', 'out'] as const)('persists separate %s main and SKU codes and keeps creation metadata and public data bounded', async writer => withScenario(async s => {
    await policy(s, '"true"'); const body = input(s, writer, ' ERP-MAIN ', 'ERP-SKU');
    const made = await write(s, writer, body); expect(made.status, made.msg).toBe(200);
    const id = Number(made.data.id), row = await s.row(id);
    expect(row).toMatchObject({ code: 'ERP-MAIN', star: '5.0', type: 0, relationId: 0 }); expect(row.spu).toMatch(/^\d{13}$/);
    expect((await s.f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, id))).map(x => x.code)).toEqual(['ERP-SKU']);
    const detail = await s.ok('GET', '/api/product/detail/' + id);
    expect(detail.storeInfo).not.toHaveProperty('code'); expect(JSON.stringify(detail)).not.toContain('ERP-MAIN');
    await s.f.db.update(storeProduct).set({ star: '2.7', spu: 'history-spu' }).where(eq(storeProduct.id, id));
    const edited = await write(s, writer, input(s, writer, 'UPDATED-MAIN', 'UPDATED-SKU'), id);
    expect(edited.status, edited.msg).toBe(200); expect(await s.row(id)).toMatchObject({ code: 'UPDATED-MAIN', star: '2.7', spu: 'history-spu' });
  }), 120000);

  it.each(['modern', 'out'] as const)('rejects zero %s main and SKU codes only for physical ERP admission', async writer => withScenario(async s => {
    await policy(s, '1');
    for (const [main, sku] of [['0', 'ERP-SKU'], ['ERP-MAIN', '0']]) {
      const before = await s.snapshot(), seq = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
      const result = await write(s, writer, input(s, writer, main, sku)); expect(result.status, result.msg).toBe(400);
      expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(seq);
    }
    await policy(s, 'false'); const made = await write(s, writer, input(s, writer, '0', '0')); expect(made.status, made.msg).toBe(200);
    const cleared = await write(s, writer, input(s, writer, '', ''), made.data.id); expect(cleared.status, cleared.msg).toBe(200);
    expect(await s.row(made.data.id)).toMatchObject({ code: '' });
  }), 120000);

  it('retains modern omitted code and untouched SKU bytes without authoring code columns', async () => withScenario(async s => {
    await policy(s, '1'); const made = await write(s, 'modern', input(s, 'modern')); expect(made.status, made.msg).toBe(200);
    const id = made.data.id, skus = await s.f.exec('SELECT to_jsonb(t) FROM store_product_attr_value t WHERE product_id=' + id);
    await s.f.exec(`CREATE FUNCTION owned_no_code_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Omitted code must not be authored'; END $$;
      CREATE TRIGGER owned_no_code_update BEFORE UPDATE OF code ON store_product FOR EACH ROW EXECUTE FUNCTION owned_no_code_update()`);
    const result = await write(s, 'modern', { store_name: 'partial edit with retained codes' }, id);
    expect(result.status, result.msg).toBe(200); expect(await s.row(id)).toMatchObject({ code: 'ERP-MAIN' });
    expect(await s.f.exec('SELECT to_jsonb(t) FROM store_product_attr_value t WHERE product_id=' + id)).toEqual(skus);
    await s.f.exec('DROP TRIGGER owned_no_code_update ON store_product');
    await s.f.db.update(storeProductAttrValue).set({ code: '' }).where(eq(storeProductAttrValue.productId, id));
    const before = await s.snapshot(), failed = await write(s, 'modern', { store_name: 'invalid actual active SKU' }, id);
    expect(failed.status, failed.msg).toBe(400); expect(await s.snapshot()).toEqual(before);
    const repaired = await write(s, 'modern', input(s, 'modern'), id); expect(repaired.status, repaired.msg).toBe(200);
  }), 120000);

  it('rejects modern physical creation without an active SKU before allocating a product', async () => withScenario(async s => {
    await policy(s, '1'); const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
    const result = await write(s, 'modern', { store_name: 'no SKU', price: '1.00', code: 'ERP-MAIN', cate_id: [800002] });
    expect(result.status, result.msg).toBe(400); expect(await s.snapshot()).toEqual(before);
    expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequence);
  }), 120000);

  it.each(['modern', 'out'] as const)('fails closed on malformed duplicate and oversized %s ERP flags while ignoring store-specific flags', async writer => withScenario(async s => {
    for (const value of ['{}', '2', '"'.repeat(2049)]) {
      await policy(s, value); const before = await s.snapshot(), seq = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
      const result = await write(s, writer, input(s, writer)); expect(result.status, result.msg).toBe(400); expect(result.msg).toContain('ERP开关');
      expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(seq);
    }
    await policy(s, '1'); await s.f.db.insert(systemConfig).values({ menuName: 'erp_open', isStore: 0, value: '0' });
    const before = await s.snapshot(), failed = await write(s, writer, input(s, writer)); expect(failed.status, failed.msg).toBe(400); expect(await s.snapshot()).toEqual(before);
    await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'erp_open'));
    await s.f.db.insert(systemConfig).values({ menuName: 'erp_open', isStore: 1, value: '{}' });
    const allowed = await write(s, writer, input(s, writer, '', '')); expect(allowed.status, allowed.msg).toBe(200);
  }), 120000);

  it.each(['modern', 'out'] as const)('does not apply physical ERP policy to supported nonphysical %s types', async writer => withScenario(async s => {
    await policy(s, '{}');
    for (const type of writer === 'out' ? [1, 2, 3, 4] : [1, 3, 4]) {
      const result = await write(s, writer, input(s, writer, '', '', type)); expect(result.status, result.msg + ' type=' + type).toBe(200);
      expect(await s.row(result.data.id)).toMatchObject({ code: '', productType: type });
    }
  }), 180000);

  it('keeps Out full-form omission semantics and committed replay independent of later ERP policy', async () => withScenario(async s => {
    await policy(s, '0'); const body = input(s, 'out', '', ''), key = crypto.randomUUID();
    const made = await write(s, 'out', body, 0, key); expect(made.status, made.msg).toBe(200);
    for (const flag of ['1', '{}']) {
      await policy(s, flag); const before = await s.snapshot(), replay = await write(s, 'out', body, 0, key);
      expect(replay.status, replay.msg).toBe(200); expect(replay.data).toMatchObject({ id: made.data.id, idempotent: true });
      expect(await s.snapshot()).toEqual(before);
    }
    await policy(s, '1'); const valid = await write(s, 'out', input(s, 'out')); expect(valid.status, valid.msg).toBe(200);
    const omitted = input(s, 'out'); delete (omitted as { code?: string }).code;
    const before = await s.snapshot(), failed = await write(s, 'out', omitted, valid.data.id); expect(failed.status, failed.msg).toBe(400); expect(await s.snapshot()).toEqual(before);
    await policy(s, '0'); const cleared = await write(s, 'out', omitted, valid.data.id); expect(cleared.status, cleared.msg).toBe(200); expect(await s.row(valid.data.id)).toMatchObject({ code: '' });
  }), 120000);

  it.each(['modern', 'out'] as const)('refuses %s while the actual ERP configuration barrier is held without any product sequence write', async writer => withScenario(async s => {
    await policy(s, '1'); if (!s.f.withPeer) throw Error('Independent peer required');
    await s.f.withPeer(async peer => {
      let signal!: () => void, release!: () => void;
      const held = new Promise<void>(r => { signal = r; }), done = new Promise<void>(r => { release = r; });
      const holding = peer.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(${ERP_CONFIG_LOCK},0)`); signal(); await done; });
      try {
        await held; const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
        const result = await write(s, writer, input(s, writer)); expect(result.status, result.msg).toBe(409); expect(result.msg).toContain('ERP配置');
        expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequence);
      } finally { release(); await holding; }
    });
    const retry = await write(s, writer, input(s, writer)); expect(retry.status, retry.msg).toBe(200);
  }), 120000);

  it.each((['modern', 'out'] as const).flatMap(writer => (['main', 'sku', 'deferred-sku', 'flag'] as const).map(target => ({ writer, target }))))
  ('rolls back $writer late $target rewriting after approved authors and allows retry after removing the trigger', async ({ writer, target }) => withScenario(async s => {
    await policy(s, target === 'flag' ? '0' : '1');
    const table = writer === 'out' ? 'out_product_write_replay' : 'system_log';
    const id = writer === 'out' ? 'NEW.product_id' : '(SELECT max(id) FROM public.store_product)';
    const rewrite = target === 'main' ? `UPDATE public.store_product SET code='CHANGED' WHERE id=${id};`
      : target === 'flag' ? "UPDATE public.system_config SET value='1' WHERE menu_name='erp_open' AND is_store=0;"
      : `UPDATE public.store_product_attr_value SET code='CHANGED' WHERE product_id=${id};`;
    await s.f.exec(`CREATE FUNCTION owned_code_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN ${rewrite} RETURN NEW; END $$;
      ${target === 'deferred-sku' ? 'CREATE CONSTRAINT TRIGGER' : 'CREATE TRIGGER'} owned_code_tamper AFTER INSERT ON ${table}
      ${target === 'deferred-sku' ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION owned_code_tamper()`);
    const before = await s.snapshot(), body = input(s, writer), key = crypto.randomUUID();
    const failed = await write(s, writer, body, 0, key);
    expect(failed.status, failed.msg).toBe(writer === 'out' && target === 'main' ? 400 : 409);
    expect(failed.msg).toContain(writer === 'out' && target === 'main' ? '定时上下架' : '商品编码');
    expect(await s.snapshot()).toEqual(before);
    await s.f.exec(`DROP TRIGGER owned_code_tamper ON ${table}`);
    const retry = await write(s, writer, body, 0, key); expect(retry.status, retry.msg).toBe(200); expect(await s.row(retry.data.id)).toMatchObject({ code: 'ERP-MAIN' });
    if (writer === 'out') expect(retry.data.idempotent).toBe(false);
  }), 120000);

  it('fails closed on oversized stored SKU history during a modern partial edit', async () => withScenario(async s => {
    await policy(s, '1'); const made = await write(s, 'modern', input(s, 'modern')); expect(made.status, made.msg).toBe(200);
    await s.f.exec(`INSERT INTO store_product_attr_value(product_id,type,product_type,suk,"unique",code,is_retired)
      SELECT ${Number(made.data.id)},0,0,'retired-'||n,'R'||lpad(n::text,7,'0'),'',1 FROM generate_series(1,1000) n`);
    const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
    const result = await write(s, 'modern', { store_name: 'oversized history' }, made.data.id);
    expect(result.status, result.msg).toBe(409); expect(result.msg).toContain('商品编码'); expect(await s.snapshot()).toEqual(before);
    expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequence);
  }), 120000);

  it('keeps the existing Supplier coordinator and rejects PHP-empty zero main and SKU codes', async () => withScenario(async s => {
    await policy(s, '1');
    for (const [main, sku] of [['0', 'ERP-SKU'], ['ERP-MAIN', '0']]) {
      const before = await s.snapshot(), seq = await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq');
      const failed = await write(s, 'supplier', input(s, 'supplier', main, sku)); expect(failed.status, failed.msg).toBe(400);
      expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(seq);
    }
    const allowed = await write(s, 'supplier', input(s, 'supplier')); expect(allowed.status, allowed.msg).toBe(200);
    const detail = await s.ok('GET', path('supplier', allowed.data.id), undefined, s.token('supplier'));
    expect(detail.code_selection).toEqual({ version: 1, code: 'ERP-MAIN', erp_open: true });
  }), 120000);
});
