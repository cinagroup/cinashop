import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { legacyCache } from '@/models/schema';
import { getProductDraft, saveProductDraft, deleteProductDraft } from '@/controllers/api/v1/AdminLegacyContentController';
import { PRODUCT_DRAFT_TTL_SECONDS } from '@/services/system/LegacyContentService';
import { financePostgres } from './helpers/financePostgres';

/** Actual controller/body/cache SQL path. The administrator context is a
 * synthetic middleware boundary here; this suite makes no JWT/ACL claim. */
describe('Admin unfinished product draft SQL round trips', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres([legacyCache]); }, 30000);
  beforeEach(async () => { await f.reset(); });
  afterAll(async () => { await f?.close(); });
  function http(adminId = 42) {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('adminId', adminId); c.set('container', createContainerFromDb(f.db)); await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.get('/cache', getProductDraft); app.post('/cache', saveProductDraft); app.delete('/cache', deleteProductDraft);
    return async (method: string, value?: unknown) => {
      const response = await app.request('/cache', { method, ...(value === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      }) });
      return response.json<{ status: number; msg: string; data: { info: Record<string, unknown> | [] } | null }>();
    };
  }
  it('restores all limit modes and zero/off values from persisted JSON after a fresh controller instance', async () => {
    for (const limits of [
      { is_limit: true, limit_type: 1, limit_num: 2 },
      { is_limit: 1, limit_type: 2, limit_num: 999 },
      { is_limit: false, limit_type: 0, limit_num: 0 },
    ]) {
      // A draft is deliberately unfinished: final save validation must not
      // prevent users preserving empty names or partially entered SKU values.
      const draft = { store_name: '', attrs: [{ price: '', stock: '' }], ...limits };
      expect((await http()('POST', draft)).status).toBe(200);
      expect((await http()('GET')).data?.info).toEqual(draft);
      const [stored] = await f.db.select().from(legacyCache).where(eq(legacyCache.key, '42_product_data'));
      expect(JSON.parse(stored.result!)).toEqual(draft);
      expect(stored.expireTime - stored.addTime).toBe(PRODUCT_DRAFT_TTL_SECONDS);
      expect(await f.db.select().from(legacyCache)).toHaveLength(1);
    }
  });
  it('keeps nested system-form schemas and source editor metadata without accepting arbitrary authority fields', async () => {
    const draft = { store_name: '完整草稿', custom_form: { field01: { name: 'texts', titleConfig: { value: '留言' } } },
      custom_form_info: [{ id: 'field01', type: 'texts', title: '留言' }],
      presale_time: ['2026-10-17 08:00:00', '2026-10-18 08:00:00'],
      auto_on_time: '2026-10-16 08:00:00', is_limit: 1, limit_type: 2, limit_num: 3 };
    expect((await http()('POST', { ...draft, relation_id: 99, is_verify: 1, unknown: 'drop' })).data?.info).toEqual(draft);
    expect((await http()('GET')).data?.info).toEqual(draft);
  });
  it('isolates administrators and performs expiry filtering and explicit deletion without deleting a peer draft', async () => {
    await http(42)('POST', { store_name: '甲', is_limit: 1, limit_type: 1, limit_num: 2 });
    await http(43)('POST', { store_name: '乙', is_limit: 0 });
    await f.db.update(legacyCache).set({ expireTime: Math.floor(Date.now() / 1000) - 1 }).where(eq(legacyCache.key, '42_product_data'));
    const expiredRows = await f.db.select().from(legacyCache);
    expect((await http(42)('GET')).data?.info).toEqual([]);
    expect(await f.db.select().from(legacyCache)).toEqual(expiredRows);
    expect((await http(43)('GET')).data?.info).toEqual({ store_name: '乙', is_limit: 0 });
    expect((await http(42)('DELETE')).status).toBe(200);
    const remaining = await f.db.select().from(legacyCache);
    expect(remaining.map(row => row.key)).toEqual(['43_product_data']);
    expect(JSON.parse(remaining[0].result!)).toEqual({ store_name: '乙', is_limit: 0 });
  });
  it('rejects an oversized actual request and leaves the prior complete draft untouched', async () => {
    await http()('POST', { store_name: '保留草稿', is_limit: 1, limit_type: 2, limit_num: 5 });
    const before = await f.db.select().from(legacyCache);
    const result = await http()('POST', { description: '中'.repeat(180000) });
    expect(result.status).toBe(400); expect(result.msg).toContain('512');
    expect(await f.db.select().from(legacyCache)).toEqual(before);
  });
});
