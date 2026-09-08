import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPcSeckillFixture } from './helpers/pcSeckillFixture';
import { parseSeckillIndex, parseSeckillList, parseSeckillSelection, seckillCartInput, seckillId, seckillImage, seckillOpen } from '../../view/common/seckillPurchase';

describe('PC seckill selection contract with real disposable HTTP/SQL', () => {
  let f: Awaited<ReturnType<typeof createPcSeckillFixture>>;
  beforeAll(async () => { f = await createPcSeckillFixture(); }, 30000);
  afterAll(async () => { await f?.close(); });
  const get = async (path: string) => (await (await f.app.request(`/api${path}`, {}, f.env)).json() as { status: number; data: unknown }).data;
  const read = async () => parseSeckillSelection(await get('/seckill/detail/20?view=skus'), 20);
  it('uses index object and numeric slot IDs, keeping child activity identity separate from base product', async () => {
    const before = await f.snapshot();
    const index = parseSeckillIndex(await get('/seckill/index'));
    expect(index.seckillTime.map(slot => slot.id)).toEqual([4, 8]);
    expect(index.seckillTime[0]).toMatchObject({ start_time: '00:00', end_time: '24:00', status: 1 });
    const first = parseSeckillList(await get('/seckill/list/4?page=1&limit=20'));
    const second = parseSeckillList(await get('/seckill/list/8?page=1&limit=20'));
    expect(first).toMatchObject([{ id: 20, product_id: 70, title: '秒杀红蓝双规格', price: 6.25 }]);
    expect(second).toMatchObject([{ id: 21, product_id: 70 }]);
    expect(parseSeckillList(await get('/seckill/list/4?page=2&limit=20'))).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
  });
  it('round-trips chosen activity unique to a new owner-scoped base-SKU cart without stock reservation', async () => {
    const detail = await read(), before = await f.snapshot();
    expect(detail.skus).toMatchObject([
      { unique: 'actred20', catalog_price: '6.25', max_quantity: 3 },
      { unique: 'actblu20', catalog_price: '8.75', max_quantity: 2 },
    ]);
    const input = seckillCartInput(detail, 'actblu20', 2);
    expect(input).toEqual({ productId: 70, activityId: 20, type: 1, unique: 'actblu20', cartNum: 2, new: 1 });
    const response = await f.app.request('/api/cart/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authori-zation': 'Bearer isolated-seckill-session' }, body: JSON.stringify(input) }, f.env);
    expect(await response.json()).toMatchObject({ status: 200, data: { cartNum: 2 } });
    const after = await f.snapshot();
    expect(after.carts).toMatchObject([{ uid: 11, activityId: 20, type: 1, productAttrUnique: 'qablue01', cartNum: 2, isNew: 1 }]);
    expect(after.products).toEqual(before.products); expect(after.skus).toEqual(before.skus); expect(after.orders).toEqual([]);
    await f.clearCarts();
  });
  it('rejects stale active catalogue after parent stop, retaining no new cart or inventory effects', async () => {
    const input = seckillCartInput(await read(), 'actred20', 1);
    await f.setActive(false);
    try {
      const before = await f.snapshot();
      const detail = await read(); expect(detail.schedule.state).toBe('unavailable');
      expect(() => seckillCartInput(detail, 'actred20', 1)).toThrow('不可购买');
      const response = await f.app.request('/api/cart/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authori-zation': 'Bearer isolated-seckill-session' }, body: JSON.stringify(input) }, f.env);
      expect(await response.json()).toMatchObject({ status: 400 }); expect(await f.snapshot()).toEqual(before);
    } finally { await f.setActive(true); }
  });
  it('requires explicit available selection, integer quantity and inclusive-start/exclusive-end window', async () => {
    const detail = await read(), { starts_at, ends_at } = detail.schedule;
    expect(seckillOpen(detail, Date.parse(starts_at!))).toBe(true);
    expect(seckillOpen(detail, Date.parse(ends_at!))).toBe(false);
    for (const quantity of [0, -1, 1.5, NaN, Infinity, 3]) expect(() => seckillCartInput(detail, 'actblu20', quantity)).toThrow();
    for (const key of ['', 'qablue01', 'sku00001']) expect(() => seckillCartInput(detail, key, 1)).toThrow();
  });
  it('rejects legacy raw detail, wrong activity, duplicate identities, bad money and impossible quantities', async () => {
    const raw = await get('/seckill/detail/20?view=skus') as Record<string, unknown>;
    for (const change of [{ selection_only: false }, { seckill_id: 21 }, { type: 0 }, { schedule: {} }, { product_id: 0 }, { once_limit: 0 }])
      expect(() => parseSeckillSelection({ ...raw, ...change }, 20)).toThrow();
    const rows = raw.skus as Array<Record<string, unknown>>;
    for (const change of [{ unique: '' }, { base_unique: 'bad key' }, { stock: -1 }, { max_quantity: 4 }, { catalog_price: '6.2' }])
      expect(() => parseSeckillSelection({ ...raw, skus: [{ ...rows[0], ...change }] }, 20)).toThrow();
    expect(() => parseSeckillSelection({ ...raw, skus: [rows[0], rows[0]] }, 20)).toThrow();
    expect(() => parseSeckillSelection({ id: 20, productId: 70 }, 20)).toThrow();
  });
  it('rejects old time arrays and invalid IDs while preserving literal titles and safe images', async () => {
    expect(() => parseSeckillIndex([{ id: 4, startTime: '0000' }])).toThrow();
    expect(parseSeckillIndex({ seckillTime: [], seckillTimeIndex: -1 })).toEqual({ seckillTime: [], seckillTimeIndex: -1 });
    expect(() => parseSeckillIndex({ seckillTime: [], seckillTimeIndex: 0 })).toThrow();
    for (const id of ['0', '01', '1/2', '-1', '1e2', '2147483648', 20, undefined]) expect(() => seckillId(id)).toThrow();
    expect(seckillId('20')).toBe(20);
    for (const url of ['//evil.test/a', 'javascript:alert(1)', 'http://evil.test/a', 'https://a:b@evil.test/a']) expect(seckillImage(url)).toBe('');
    expect(seckillImage('/image.svg')).toBe('/image.svg');
    expect(parseSeckillList([{ id: 20, product_id: 70, title: '<script>text</script>', image: '', price: 6.25, ot_price: 10 }])[0].title).toBe('<script>text</script>');
  });
});
