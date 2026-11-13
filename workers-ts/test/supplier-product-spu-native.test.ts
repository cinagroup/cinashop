import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import { supplierProductRecommendImageFixture } from './helpers/supplierProductRecommendImage';

const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
type Envelope = { status: number; msg: string; data: { id: number } };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ordinary server-owned SPU through real JWT and minimum App LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecommendImageFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned SPU acceptance forbids outbound I/O'));
    f = await supplierProductRecommendImageFixture(); wiring.container = f.container;
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { await f?.close(); wiring.container = null; vi.restoreAllMocks(); }
  }, 30000);
  async function call(id: number, body: Record<string, unknown>, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi/product/product/' + id, { method: 'POST', headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }),
      'X-Supplier-Id': '8', 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<Envelope>();
  }
  async function createBody(type = 0) {
    return f.body({ product_type: type, spec_type: 0, items: [],
      bar_code: 'TOP-BARCODE', spu: 'FORGED-CLIENT-SPU',
      attrs: [{ suk: '默认', image: '/owned-media/schedule.png', price: '19.99', settle_price: '12.34',
        cost: '10.00', ot_price: '29.99', vip_price: '18.00', stock: type === 1 ? 0 : 7,
        code: 'SKU-CODE', disk_info: '' }] });
  }
  async function rollsBack(work: () => Promise<unknown>) {
    const before = await f.snapshot(); await work(); expect(await f.snapshot()).toEqual(before);
  }
  async function conflict(body: Record<string, unknown>, id = 0) {
    const saved = await call(id, body); expect(saved.status).toBe(409); expect(saved.msg).toContain('内部 SPU');
  }

  it.each([0, 1, 3])('generates a server-owned 13-digit SPU for ordinary create type %s', async type => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const before = await f.snapshot(), result = await call(0, await createBody(type));
    expect(result.status, result.msg).toBe(200); const row = await f.product(result.data.id);
    expect(row).toMatchObject({ type: 2, relationId: 7, productType: type, barCode: 'TOP-BARCODE', code: '', isShow: 0, isVerify: 0 });
    expect(row.spu).toMatch(/^\d{13}$/); expect(row.spu).not.toBe('FORGED-CLIENT-SPU');
    const after = await f.snapshot();
    for (const [name, rows] of Object.entries(before)) for (const row of rows) expect(after[name], 'existing ' + name).toContainEqual(row);
  }));

  it.each([[0, ''], [1, 'legacy-SPU'], [3, '1234567890123']] as const)('preserves historical SPU for type %s even when the client forges an edit', async (type, spu) => {
    await f.withWriter(async runtime => {
      wiring.container = runtime.container; const created = await call(0, await createBody(type));
      expect(created.status, created.msg).toBe(200); const id = created.data.id;
      await f.db.update(storeProduct).set({ spu }).where(eq(storeProduct.id, id));
      const body = await f.body({ spu: 'FORGED-EDIT', store_name: 'edited owned SPU ' + type }, id);
      const edited = await call(id, body); expect(edited.status, edited.msg).toBe(200);
      expect((await f.product(id)).spu).toBe(spu);
    });
  });

  it('keeps the generated value stable across repeated ordinary edits', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const saved = await call(0, await createBody()); expect(saved.status).toBe(200);
    const id = saved.data.id, initial = (await f.product(id)).spu; expect(initial).toMatch(/^\d{13}$/);
    for (const spu of ['9999999999999', '']) {
      const body = await f.body({ spu, store_name: 'stable generated SPU' }, id);
      expect((await call(id, body)).status).toBe(200); expect((await f.product(id)).spu).toBe(initial);
    }
  }));

  it('does not author the SPU column on an ordinary edit', async () => {
    await f.db.update(storeProduct).set({ spu: 'legacy-column' }).where(eq(storeProduct.id, 80));
    await f.exec(`CREATE FUNCTION public.owned_spu_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SPU column must not be authored'; END $$;
      CREATE TRIGGER owned_spu_no_update BEFORE UPDATE OF spu ON public.store_product FOR EACH ROW EXECUTE FUNCTION public.owned_spu_no_update()`);
    await f.withWriter(async runtime => {
      wiring.container = runtime.container; const saved = await call(80, await f.body({ spu: 'forged-column-edit' }));
      expect(saved.status, saved.msg).toBe(200); expect((await f.product()).spu).toBe('legacy-column');
    });
  });

  it.each(['anonymous', 'viewer', 'denied', 'other'] as const)('denies unauthorized SPU save for %s without business or sequence changes', async actor => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await f.snapshot(), sequences = await f.sequences();
    expect((await call(80, await f.body({ spu: 'forged' }), actor)).status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }));

  it('rolls back an immediate insert trigger rewriting the generated SPU', async () => {
    await f.exec(`CREATE FUNCTION public.owned_spu_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.spu='insert-change'; RETURN NEW; END $$;
      CREATE TRIGGER owned_spu_insert BEFORE INSERT ON public.store_product FOR EACH ROW EXECUTE FUNCTION public.owned_spu_insert()`);
    await f.withWriter(async runtime => { wiring.container = runtime.container; const body = await createBody(1); await rollsBack(() => conflict(body)); });
  });

  it('rolls back a later SKU author rewriting a newly generated SPU', async () => {
    await f.exec(`CREATE FUNCTION public.owned_spu_sku() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.store_product SET spu='sku-change' WHERE id=NEW.product_id; RETURN NULL; END $$;
      CREATE TRIGGER owned_spu_sku AFTER INSERT ON public.store_product_attr_value FOR EACH ROW EXECUTE FUNCTION public.owned_spu_sku()`);
    await f.withWriter(async runtime => { wiring.container = runtime.container; const body = await createBody(1); await rollsBack(() => conflict(body)); });
  });

  it('settles deferred constraints before checking the final generated SPU', async () => {
    await f.exec(`CREATE FUNCTION public.owned_spu_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.store_product SET spu='deferred' WHERE id=NEW.id; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER owned_spu_deferred AFTER INSERT ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_spu_deferred()`);
    await f.withWriter(async runtime => { wiring.container = runtime.container; const body = await createBody(1); await rollsBack(() => conflict(body)); });
  });

  it('rolls back later description mutation of a preserved historical SPU', async () => {
    await f.db.update(storeProduct).set({ spu: 'old-SPU' }).where(eq(storeProduct.id, 80));
    await f.exec(`CREATE FUNCTION public.owned_spu_description() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.store_product SET spu='edit-change' WHERE id=NEW.product_id; RETURN NULL; END $$;
      CREATE TRIGGER owned_spu_description AFTER INSERT OR UPDATE ON public.store_product_description FOR EACH ROW EXECUTE FUNCTION public.owned_spu_description()`);
    await f.withWriter(async runtime => { wiring.container = runtime.container; const body = await f.body({ spu: 'forged-description-edit' }); await rollsBack(() => conflict(body, 80)); });
  });
});
