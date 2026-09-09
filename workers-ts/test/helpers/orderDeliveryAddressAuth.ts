import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { v1Routes } from '../../src/routes/v1';
import { errorHandler } from '../../src/middleware/error';
import { createToken, md5, type TokenType } from '../../src/utils/jwt';
import * as cache from '../../src/utils/cache';
import { user, storeCart, systemAdmin, systemRole, storeOrderCartInfo, storeOrderStatus, printDocument } from '../../src/models/schema';
import type { AppVariables, Env } from '../../src/env';

/** Actual registered routes, JWT, DB account/role checks, controllers and SQL.
 * Only token-bucket storage, KV and sequence are isolated substitutes. No login/provider I/O. */
export function registerDeliveryAddressAuthTests() {
  describe('delivery address through registered authenticated v1 routes', () => {
    let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
    let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
    let buckets: Map<string, cache.TokenBucket>;
    let secret: string;
    beforeEach(async () => {
      f = await createPcCheckoutQuoteFixture([systemAdmin, systemRole, storeOrderCartInfo, storeOrderStatus, printDocument]);
      buckets = new Map(); secret = crypto.randomUUID();
      for (const key of Object.keys(f.config)) f.config[key] = '0';
      Object.assign(f.env, { APP_KEY: secret, NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated-redis.invalid', UPSTASH_REDIS_TOKEN: 'isolated-test-only',
        SEQUENCE: { idFromName: () => 'isolated-auth', get: () => ({ fetch: async () => new Response('address_auth_order') }) } });
      vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
      vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External requests forbidden in address auth acceptance'); }));
      await f.db.insert(user).values({ uid: 22, account: 'isolated-other-owner' });
      await f.db.insert(systemRole).values({ id: 1, roleName: 'isolated-assisted', rules: 'order.assisted', status: 1 });
      await f.db.insert(systemAdmin).values([
        { id: 7, account: 'isolated-admin', level: 1, roles: '1', status: 1 },
        { id: 8, account: 'isolated-other-admin', level: 1, roles: '1', status: 1 },
      ]);
      app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', f.container); await next(); });
      app.onError(errorHandler);
      app.route('/api', v1Routes);
    }, 30_000);
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await f?.close(); });
    const token = async (id = 11, type: TokenType = 'api', signingKey = secret) => {
      const issued = await createToken(id, type, md5(''), signingKey);
      buckets.set(md5(issued.token), { ...issued, uid: id, type });
      return issued.token;
    };
    const request = async (path: string, bearer: string, body: Record<string, unknown>) => {
      const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`,
        'x-fixture-user': '11', 'x-user-id': '11', 'x-admin-id': '7' }, body: JSON.stringify(body) }, f.env);
      return response.json() as Promise<{ status: number; msg: string; data: { orderKey?: string; quoteToken?: string; result?: { order_id: string } } | null }>;
    };
    const normal = { cartIds: [1], addressId: 11, shippingType: 1 };
    const assisted = { cartId: [1], new: 1, addressId: 11, shipping_type: 1 };
    const confirmPath = '/api/admin/order/confirm/11';

    it('uses the signed user and saved address despite forged body/header identities', async () => {
      const bearer = await token();
      const confirmed = await request('/api/order/confirm', bearer, normal);
      expect((await request(`/api/order/create/${confirmed.data?.orderKey}`, bearer, { ...normal, quoteToken: confirmed.data?.quoteToken, uid: 22, realName: 'override', cityId: 102 })).status).toBe(200);
      expect((await f.snapshot()).orders[0]).toMatchObject({ uid: 11, realName: '本地地址甲', payPostage: '6.00', paid: 0 });
      expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['absent', 'bad_signature', 'revoked', 'bucket_owner', 'wrong_type', 'banned', 'password_changed'] as const)('rejects %s user authentication before quote or order writes', async kind => {
      const bearer = kind === 'absent' ? '' : await token(11, kind === 'wrong_type' ? 'admin' : 'api', kind === 'bad_signature' ? crypto.randomUUID() : secret);
      if (kind === 'revoked') buckets.clear();
      if (kind === 'bucket_owner') buckets.get(md5(bearer))!.uid = 22;
      if (kind === 'banned') await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
      if (kind === 'password_changed') await f.db.update(user).set({ pwd: 'changed-isolated-hash' }).where(eq(user.uid, 11));
      const before = await f.snapshot();
      const bucket = buckets.get(md5(bearer));
      const expectedCode = { absent: 410000, bad_signature: 410001, revoked: 410000, bucket_owner: 410002,
        wrong_type: 410000, banned: 410002, password_changed: 410001 }[kind];
      for (const path of ['/api/order/confirm', '/api/order/create/address_auth']) {
        // The first failed request may revoke the bucket. Exercise each route at the original boundary.
        if (bucket) buckets.set(md5(bearer), { ...bucket });
        expect((await request(path, bearer, normal)).status).toBe(expectedCode);
      }
      expect(await f.snapshot()).toEqual(before); expect(f.writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects another signed owner borrowing this user address even with an owned cart', async () => {
      await f.db.update(storeCart).set({ uid: 22 });
      const before = await f.snapshot();
      expect(await request('/api/order/create/address_auth', await token(22), normal)).toMatchObject({ status: 400, msg: expect.stringContaining('收货地址') });
      expect(await f.snapshot()).toEqual(before);
    });
    it('creates through the restricted assisted role and rechecks role revocation after confirmation', async () => {
      await f.db.update(storeCart).set({ staffId: 7 });
      const bearer = await token(7, 'admin');
      const confirmation = await request(confirmPath, bearer, assisted);
      expect(confirmation.status).toBe(200); expect(confirmation.data?.orderKey).toMatch(/^[a-f0-9]{32}$/);
      const path = `/api/admin/order/create/${confirmation.data!.orderKey}/11`;
      await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
      const before = await f.snapshot(); expect((await request(path, bearer, assisted)).status).toBe(400011);
      expect(await f.snapshot()).toEqual(before);
      await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 1));
      expect((await request(path, bearer, { ...assisted, quoteToken: confirmation.data?.quoteToken })).status).toBe(200);
      expect((await f.snapshot()).orders[0]).toMatchObject({ uid: 11, staffId: 7, isChannel: 2, realName: '本地地址甲', payPostage: '6.00', paid: 0 });
      expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['user_token', 'other_actor', 'no_permission', 'non_platform'] as const)('rejects assisted %s without trusting supplied actor IDs', async kind => {
      await f.db.update(storeCart).set({ staffId: 7 });
      if (kind === 'no_permission') await f.db.update(systemRole).set({ rules: 'order.view' });
      if (kind === 'non_platform') await f.db.update(systemAdmin).set({ adminType: 2 }).where(and(eq(systemAdmin.id, 7), eq(systemAdmin.level, 1)));
      const bearer = await token(kind === 'user_token' ? 11 : kind === 'other_actor' ? 8 : 7, kind === 'user_token' ? 'api' : 'admin');
      const expectedCode = { user_token: 410000, other_actor: 400, no_permission: 400011, non_platform: 410002 }[kind];
      const before = await f.snapshot(); expect((await request(confirmPath, bearer, { ...assisted, adminId: 7 })).status).toBe(expectedCode);
      expect(await f.snapshot()).toEqual(before); expect(f.writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    });
  });
}
