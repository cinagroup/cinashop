import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppVariables, Env } from '../src/env';
import { cartAddNewcomerReplayKey } from '../src/controllers/api/v1/OrderController';

describe('newcomer replay key issuance', () => {
  it('requires identity and issues distinct no-store UUIDv4 keys without a database', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('uid', c.req.header('x-test-user') === '11' ? 11 : 0);
      await next();
    });
    app.get('/api/cart/add/newcomer-replay-key', cartAddNewcomerReplayKey);
    const get = (uid: number) => app.request('/api/cart/add/newcomer-replay-key', {
      headers: { 'x-test-user': String(uid) },
    }, {} as Env);
    const first = await get(11);
    const second = await get(11);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('cache-control')).toBe('private, no-store');
    const a = await first.json() as { status: number; data: { requestKey: string } };
    const b = await second.json() as { status: number; data: { requestKey: string } };
    const key = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.data.requestKey).toMatch(key);
    expect(b.data.requestKey).toMatch(key);
    expect(a.data.requestKey).not.toBe(b.data.requestKey);
    const denied = await get(0);
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    expect(await denied.json()).toMatchObject({ status: 400, data: null });
  });
});
