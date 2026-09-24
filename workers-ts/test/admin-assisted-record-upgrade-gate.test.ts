import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import type { Container } from '../src/lib/di';
import { adminAssistedPlaceList } from '../src/controllers/api/v1/AdminController';
import { AdminAssistedOrderService } from '../src/services/admin/AdminAssistedOrderService';

describe('assisted record client protocol gate', () => {
  it('authenticates first, then rejects old/ambiguous paging without constructing a list read', async () => {
    const list = vi.spyOn(AdminAssistedOrderService.prototype, 'placeList');
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.get('/api/admin/order/place/list', async (c, next) => {
      if (c.req.header('Authorization') !== 'Bearer local-valid') {
        return c.json({ status: 410000, msg: '请登录', data: null }, 401);
      }
      c.set('adminInfo', { id: 17, account: 'local', level: 1, roles: '1', realName: 'Local', divisionId: 0 });
      await next();
    }, adminAssistedPlaceList);

    const unauthenticated = await app.request('/api/admin/order/place/list?page=1&limit=10', {}, {} as Env);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ status: 410000 });
    expect(list).not.toHaveBeenCalled();

    for (const query of ['', '?page=1&limit=10', '?paging=page', '?paging=Cursor',
      '?paging=cursor&paging=page', '?paging=cursor&paging=cursor']) {
      const response = await app.request(`/api/admin/order/place/list${query}`,
        { headers: { Authorization: 'Bearer local-valid' } }, {} as Env);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(await response.json()).toEqual({
        status: 400, msg: '客户端版本过低，请升级后查看代客订单记录', data: null,
      });
    }
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
  });

  it('passes one cursor protocol through with the verified actor and private projection', async () => {
    const projection = { list: [{ id: 3, order_id: 'local_order_3', uid: 11, paid: 1,
      pay_price: '1.00', total_num: 1, add_time: 20, pid: 0, _status: { _title: '待发货' } }],
      next_cursor: null, has_more: false };
    const list = vi.spyOn(AdminAssistedOrderService.prototype, 'placeList').mockResolvedValue(projection);
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.get('/api/admin/order/place/list', async (c, next) => {
      c.set('adminInfo', { id: 17, account: 'local', level: 1, roles: '1', realName: 'Local', divisionId: 0 });
      c.set('container', {} as Container);
      await next();
    }, adminAssistedPlaceList);

    const response = await app.request('/api/admin/order/place/list?paging=cursor&cursor=20:3&limit=20', {}, {} as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(await response.json()).toEqual({ status: 200, msg: 'ok', data: projection });
    expect(list).toHaveBeenCalledExactlyOnceWith(17, { paging: 'cursor', cursor: '20:3', limit: '20' });
    list.mockRestore();
  });
});
