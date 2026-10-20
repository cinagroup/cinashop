/** Small owned column fixture for initial ingress reds. Admin uses mounted
 * production controller/auth with signed JWT; public fixture principal is
 * explicitly synthetic. No full-schema/App/LOGIN or real participation claim. */
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { storeProduct, storeProductAttrValue, systemAdmin, systemRole } from '@/models/schema';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { adminActivitySave, adminBargainSkuOptions } from '@/controllers/api/v1/AdminCrudController';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { createBargainSelectionFixture } from './bargainSelectionFixture';
import { refundEvidenceSequences, refundEvidenceSnapshot } from './refundApplicationEvidence';

export async function bargainShortSkuFixture() {
  const f = await createBargainSelectionFixture([systemAdmin, systemRole]);
  try {
    await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique: 'short7', price: '18.88' }).where(eq(storeProductAttrValue.id, 1));
    const env = { ...f.env, APP_KEY: 'owned-bargain-short-red-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
    await f.db.insert(systemRole).values({ id: 903, rules: 'activity.manage', status: 1 });
    await f.db.insert(systemAdmin).values({ id: 903, account: 'owned-bargain-red', pwd: 'owned-bargain-red-password',
      adminType: 1, level: 1, roles: '903', status: 1, isDel: 0 });
    const token = (await createToken(903, 'admin', md5('owned-bargain-red-password'), env.APP_KEY)).token;
    const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    admin.use('*', async (c, next) => { c.set('container', f.container); await next(); });
    admin.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    admin.get('/adminapi/activity/bargain/sku-options', adminAuthMiddleware(), adminBargainSkuOptions);
    admin.post('/adminapi/activity/save', adminAuthMiddleware(), adminActivitySave);
    const request = async (path: string, body?: unknown) => {
      const response = await admin.request(path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Authori-zation': `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
      return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
    };
    return { ...f, request,
      rawIdentity: async () => (await f.db.execute(sql`SELECT "unique" AS raw_unique,pg_typeof("unique")::text AS storage_type,
        octet_length("unique") AS bytes FROM public.store_product_attr_value WHERE id=1`))[0],
      publicSnapshot: async () => {
        const snapshot = await refundEvidenceSnapshot(f.db);
        const entries = snapshot.store_product_attr_value;
        if (!Array.isArray(entries)) throw Error('Owned SKU snapshot is not an array');
        // Evidence SQL returns {row: to_jsonb(t)}. Expose real selected table
        // rows so the unchanged ingress assertions compare actual base data.
        const rows = entries.map((entry: unknown) => {
          if (!entry || typeof entry !== 'object' || !('row' in entry)) throw Error('Owned SKU snapshot wrapper missing');
          const row = entry.row;
          if (!row || typeof row !== 'object' || Array.isArray(row) || !('id' in row) || typeof row.id !== 'number')
            throw Error('Owned SKU snapshot row identity missing');
          return { ...row, id: row.id };
        });
        if (rows.filter(row => row.id === 1).length !== 1) throw Error('Owned base SKU snapshot missing');
        return { ...snapshot, store_product_attr_value: rows };
      }, publicSequences: () => refundEvidenceSequences(f.db),
      adminInput: () => ({ type: 'bargain', productId: 70, storeName: 'Owned short bargain', stock: 6, quota: 5,
        price: '10.00', minPrice: '2.00', people: 2, startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString(),
        sku: { baseUnique: 'short7' } }),
    };
  } catch (error) { await f.close(); throw error; }
}
