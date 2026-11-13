import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdminOrderRemarkInput, parseAdminOrderRemarkValue } from '@/services/admin/AdminOrderRemarkInput';
import { AdminOrderRemarkService } from '@/services/admin/AdminOrderRemarkService';
import { adminOrderRemark, adminLegacyOrderRemark, privateAdminOrderRemarkResponse } from '@/controllers/api/v1/AdminCrudController';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';

afterEach(() => vi.restoreAllMocks());
describe('Admin order remark normalization and distinct route identities', () => {
  it('retains bounded multiline Unicode text and trims only the outside', () => {
    expect(parseAdminOrderRemarkInput({ order_id: 'wx-1', remark: '  第一行\n第二行🛍  ' })).toEqual({ orderId: 'wx-1', remark: '第一行\n第二行🛍' });
    expect(parseAdminOrderRemarkValue('🛍'.repeat(512))).toBe('🛍'.repeat(512));
    expect(parseAdminOrderRemarkValue('00')).toBe('00');
  });
  it.each([undefined, null, 0, false, [], {}, '', ' ', '0', ' 0 ', '\u0000', '\ud800', '\udfff', 'x'.repeat(513), '🛍'.repeat(513)])
  ('rejects malformed or PHP-empty remark %j', value => expect(() => parseAdminOrderRemarkValue(value)).toThrow());
  it.each(['', '../other', 'a'.repeat(33)])('rejects malformed order number %j', order_id =>
    expect(() => parseAdminOrderRemarkInput({ order_id, remark: '有效备注' })).toThrow());

  const actor = { id: 41, authVersion: 'a'.repeat(32), expiresAt: 2_000_000_000 };
  function context(params: Record<string, string>, body: object) {
    const header = vi.fn();
    return { header, c: { header, req: { raw: new Request('https://owned.test/adminapi/order/remark/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), param: (name: string) => params[name] }, get: (name: string) => name === 'container' ? {}
      : ({ adminId: actor.id, socketAuthVersion: actor.authVersion, socketTokenExp: actor.expiresAt } as Record<string, unknown>)[name],
    json: (value: unknown) => Response.json(value) } as never };
  }
  it('takes the modern number from the actual :id route and the actor only from verified context', async () => {
    const save = vi.spyOn(AdminOrderRemarkService.prototype, 'byNumber').mockResolvedValue({ changed: true });
    const x = context({ id: '123456' }, { order_id: 'body-other-order', remark: 'note', admin_id: 999 });
    await adminOrderRemark(x.c);
    expect(save).toHaveBeenCalledWith(actor, { order_id: '123456', remark: 'note', admin_id: 999 });
    expect(x.header).toHaveBeenCalledWith('Cache-Control', expect.stringContaining('private'));
  });
  it('passes the legacy route only to the primary-ID selector', async () => {
    const save = vi.spyOn(AdminOrderRemarkService.prototype, 'byPrimaryId').mockResolvedValue({ changed: true });
    const number = vi.spyOn(AdminOrderRemarkService.prototype, 'byNumber');
    await adminLegacyOrderRemark(context({ id: '123456' }, { order_id: 'different', remark: 'note' }).c);
    expect(save).toHaveBeenCalledWith(actor, '123456', { order_id: 'different', remark: 'note' }); expect(number).not.toHaveBeenCalled();
  });
  it('sets private headers before authentication can reject a request', async () => {
    const x = context({}, {}), next = vi.fn(async () => { expect(x.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0'); });
    await privateAdminOrderRemarkResponse(x.c, next); expect(next).toHaveBeenCalledOnce();
  });
  it.each([
    ['POST', '/adminapi/order/remark/:id'], ['PUT', '/adminapi/order/remark/:id'],
    ['POST', '/api/admin/order/remark'], ['POST', '/api/admin/order/remark/:orderId'],
  ])('requires order.manage for %s %s', (method, route) => expect(requiredAdminPermission(method, route)).toBe('order.manage'));
});
