import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { systemGroup, systemGroupData } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { parseRechargeQuota } from '../src/services/user/UserFinanceService';
import { applyRechargePayment } from '../src/services/payment/RechargePaymentService';
import { quotaInput, quotaValue, rechargeQuotaFixture } from './helpers/rechargeQuotaFixture';

describe('Admin recharge quotas on SQL', () => {
  let f: Awaited<ReturnType<typeof rechargeQuotaFixture>>;
  beforeEach(async () => { f = await rechargeQuotaFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const input = (extra: Record<string, unknown> = {}) => ({ ...quotaInput, request_id: crypto.randomUUID(), ...extra });

  it('lists every scoped row with stable ordering, bounded pages, status filters and full revisions', async () => {
    const first = await f.request('?page=1&limit=1');
    expect(first.response.headers.get('cache-control')).toBe('private, no-store');
    expect(first.body.data).toMatchObject({ count: 2, page: 1, limit: 1, list: [{ id: 102, price: '200.00', give_money: '30.00', valid: true, status: 0 }] });
    expect(first.body.data.list[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.request('?page=2&limit=1')).body.data.list[0]).toMatchObject({ id: 101, add_time: '2023-11-14 22:13:20' });
    expect((await f.request('?status=1')).body.data.count).toBe(1);
    expect((await f.request('?status=')).body.data.count).toBe(2);
    expect(await f.publicQuotas()).toEqual([{ id: 101, price: '100.00', give_money: '10.00' }]);
    await f.db.update(systemGroupData).set({ status: 1 }).where(eq(systemGroupData.id, 102));
    expect((await f.publicQuotas()).map(row => row.id)).toEqual([102, 101]);
  });

  it('rejects duplicate, unknown and unbounded query/detail parameters', async () => {
    for (const query of ['page=0', 'page=1e1', 'page=01', 'page=1&page=2', 'limit=101', 'page=102&limit=100', 'status=2', 'status=1&status=0', 'gid=62']) {
      expect((await f.request(`?${query}`)).body.status).not.toBe(200);
    }
    for (const path of ['/103', '/0', '/01', '/101?gid=77']) expect((await f.request(path)).body.status).not.toBe(200);
  });

  it('enforces independent permissions and menu visibility on both route families', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/marketing/recharge-quotas`)).toBe('recharge_quota.view');
      expect(requiredAdminPermission('PUT', `${prefix}/marketing/recharge-quotas/101/status`)).toBe('recharge_quota.manage');
      expect((await f.request('', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      expect((await f.request('', { prefix, method: 'POST', token: f.tokens.reader, body: input() })).body.status).not.toBe(200);
      expect((await f.request('', { prefix, token: f.tokens.other })).body.status).not.toBe(200);
      expect((await f.request('', { prefix, method: 'POST', token: f.tokens.other, body: input() })).body.status).not.toBe(200);
    }
    const svc = new AdminPermissionService(f.container);
    expect(svc.buildMenus(new Set(['recharge_quota.view']))).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/marketing/recharge-options' })]));
  });

  it('writes fixed nested values under dynamic group IDs, permits duplicate prices and replays exactly once', async () => {
    const before = await f.snapshot(); const body = input({ price: '100', give_money: '0' });
    const created = (await f.request('', { method: 'POST', body })).body;
    expect(created.status).toBe(200);
    const after = await f.snapshot();
    const row = after.quotas.find(row => row.id === created.data.id)!;
    expect(row).toMatchObject({ gid: 77, status: 1, sort: 1 });
    expect(JSON.parse(row.value!)).toEqual({ price: { type: 'input', value: '100.00' }, give_money: { type: 'input', value: '0.00' } });
    expect(after.groups).toEqual(before.groups); expect(after.users).toEqual(before.users); expect(after.orders).toEqual([]);
    expect(after.logs).toHaveLength(1); expect(after.logs[0].action).toMatch(/^create;id=\d+;payload=[a-f0-9]{64}$/);
    expect(JSON.stringify(after.logs)).not.toContain('give_money');
    expect((await f.request('', { method: 'POST', body })).body).toEqual(created);
    expect(await f.snapshot()).toEqual(after);
  });

  it('binds request replay to admin, operation, target, content and revision, even after deletion', async () => {
    const body = input(), created = (await f.request('', { method: 'POST', body })).body.data;
    expect((await f.request('', { method: 'POST', body: { ...body, give_money: '11.00' } })).body.status).not.toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { request_id: body.request_id, revision: await f.revision(), status: 0 } })).body.status).not.toBe(200);
    expect((await f.request('', { method: 'POST', body, token: f.tokens.second })).body.status).toBe(200);
    const deletion = { request_id: crypto.randomUUID(), revision: await f.revision(created.id) };
    expect((await f.request(`/${created.id}`, { method: 'DELETE', body: deletion })).body.status).toBe(200);
    const after = await f.snapshot();
    expect((await f.request('', { method: 'POST', body })).body.data).toEqual(created);
    expect((await f.request(`/${created.id}`, { method: 'DELETE', body: deletion })).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
  });

  it('strictly validates decimal strings, cents, amounts and the dedicated body fields', async () => {
    const before = await f.snapshot();
    const bad = [{ price: 100 }, { price: '0' }, { price: '100000.01' }, { price: '1e2' }, { price: '01' }, { price: '1.001' },
      { price: ' 1' }, { give_money: '-1' }, { give_money: '' }, { give_money: null }, { give_money: '100000000.00' }, { give_money: '1.001' },
      { status: 2 }, { sort: 1.2 }, { sort: -1 }, { sort: 2147483648 }, { gid: 62 }, { config_name: 'other_data' }, { value: '{}' }, { request_id: '' }];
    for (const extra of bad) expect((await f.request('', { method: 'POST', body: input(extra) })).body.status).not.toBe(200);
    expect((await f.request('', { method: 'POST', body: { ...input(), note: 'x'.repeat(5000) } })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
    const boundary = (await f.request('', { method: 'POST', body: input({ price: '100000.00', give_money: '99999999.99', sort: 2147483647 }) })).body;
    expect(boundary.status).toBe(200);
    expect(parseRechargeQuota(boundary.data.id, quotaValue('100000.00', '99999999.99'))).toMatchObject({ price: '100000.00', give_money: '99999999.99' });
    for (const value of [quotaValue('100000.01'), quotaValue('1', '100000000'), quotaValue('1.001'), '[]', 'null']) expect(parseRechargeQuota(1, value)).toBeNull();
  });

  it('requires fresh versions for edits/show/delete while identical old-version retries do not write again', async () => {
    const revision = await f.revision(), body = input({ revision, price: '123.45' });
    expect((await f.request('/101', { method: 'PUT', body })).body.status).toBe(200);
    const after = await f.snapshot();
    for (const [path, method, data] of [['/101', 'PUT', { ...body, request_id: crypto.randomUUID() }],
      ['/101/status', 'PUT', { revision, status: 0, request_id: crypto.randomUUID() }], ['/101', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body: data })).body.msg).toContain('已更新');
    }
    expect((await f.request('/101', { method: 'PUT', body })).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after); expect(after.quotas[0].addTime).toBe(1_700_000_000);
  });

  it('rejects other groups for every operation without changing their data', async () => {
    const before = await f.snapshot(); const revision = await f.revision();
    for (const [path, method, body] of [['/103', 'PUT', input({ revision })], ['/103/status', 'PUT', { revision, status: 0, request_id: crypto.randomUUID() }],
      ['/103', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) expect((await f.request(path, { method, body })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });

  it('keeps malformed rows visible to admins for repair, hide or delete, but prevents purchase/show', async () => {
    await f.db.update(systemGroupData).set({ value: '{bad', status: 1 }).where(eq(systemGroupData.id, 101));
    expect((await f.request('/101')).body.data).toMatchObject({ valid: false, price: '', give_money: '' });
    expect((await f.request()).body.data.count).toBe(2); expect(await f.publicQuotas()).toEqual([]);
    await expect(f.finance.recharge(10, 1, 'h5', 101)).rejects.toThrow('下架');
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), status: 0, request_id: crypto.randomUUID() } })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), status: 1, request_id: crypto.randomUUID() } })).body.msg).toContain('修复');
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision() }) })).body.status).toBe(200);
    expect((await f.request('/101')).body.data.valid).toBe(true);
    await f.db.update(systemGroupData).set({ value: 'bad' }).where(eq(systemGroupData.id, 102));
    expect((await f.request('/102', { method: 'DELETE', body: { revision: await f.revision(102), request_id: crypto.randomUUID() } })).body.status).toBe(200);
  });

  it('counts hidden rows in the 20-entry create cap but permits editing and recovery', async () => {
    await f.db.insert(systemGroupData).values(Array.from({ length: 18 }, (_, n) => ({ id: 200 + n, gid: 77, value: quotaValue(), status: 0 })));
    expect((await f.request('', { method: 'POST', body: input() })).body.msg).toContain('最多20');
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision() }) })).body.status).toBe(200);
    expect((await f.request('/102', { method: 'DELETE', body: { revision: await f.revision(102), request_id: crypto.randomUUID() } })).body.status).toBe(200);
    expect((await f.request('', { method: 'POST', body: input() })).body.status).toBe(200);
    expect((await f.request('?limit=100')).body.data.list).toHaveLength(20);
  });

  it('fails visibly for overfull public configuration and prevents hiding recovery from being undone past its cap', async () => {
    await f.db.insert(systemGroupData).values(Array.from({ length: 20 }, (_, n) => ({ id: 200 + n, gid: 77, value: quotaValue(), status: 1 })));
    await expect(f.publicQuotas()).rejects.toThrow('超过20');
    expect((await f.request('?limit=100')).body.data.count).toBe(22);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), status: 0, request_id: crypto.randomUUID() } })).body.status).toBe(200);
    expect(await f.publicQuotas()).toHaveLength(20);
    expect((await f.request('/102/status', { method: 'PUT', body: { revision: await f.revision(102), status: 1, request_id: crypto.randomUUID() } })).body.msg).toContain('最多显示20');
  });

  it.each(['missing', 'duplicate'] as const)('fails closed for %s configuration groups without creating or guessing one', async mode => {
    if (mode === 'missing') await f.db.delete(systemGroup).where(eq(systemGroup.id, 77));
    else { await f.exec('DROP INDEX IF EXISTS system_group_config_name_uq'); await f.db.insert(systemGroup).values({ id: 78, configName: 'user_recharge_quota' }); }
    const before = await f.snapshot();
    expect((await f.request()).body.msg).toContain(mode === 'missing' ? '不存在' : '重复');
    expect((await f.request('', { method: 'POST', body: input() })).body.status).not.toBe(200);
    if (mode === 'missing') expect(await f.publicQuotas()).toEqual([]);
    else await expect(f.publicQuotas()).rejects.toThrow('配置组');
    await expect(f.finance.recharge(10, 1, 'h5', 101)).rejects.toThrow('配置组');
    expect(await f.snapshot()).toEqual(before);
    expect((await f.finance.recharge(10, 1.23, 'h5')).price).toBe('1.23'); // custom cash does not depend on quotas
  });

  it('rolls back all writes when the atomic audit fails', async () => {
    await f.exec("CREATE FUNCTION reject_quota_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END $$ LANGUAGE plpgsql; CREATE TRIGGER quota_audit_fail BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_quota_audit()");
    const before = await f.snapshot(), revision = await f.revision();
    for (const [path, method, body] of [['', 'POST', input()], ['/101', 'PUT', input({ revision })],
      ['/101/status', 'PUT', { revision, status: 0, request_id: crypto.randomUUID() }], ['/101', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body })).body.status).toBe(500); expect(await f.snapshot()).toEqual(before);
    }
  });

  it('settles an in-flight order from the original amount/gift snapshot after edit, hide and delete', async () => {
    const order = await f.finance.recharge(10, 0.01, 'h5', 101);
    expect(order.price).toBe('100.00'); // client cannot choose the package amount
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), price: '500', give_money: '90' }) })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), status: 0, request_id: crypto.randomUUID() } })).body.status).toBe(200);
    await expect(f.finance.recharge(10, 1, 'h5', 101)).rejects.toThrow('下架');
    expect((await f.request('/101', { method: 'DELETE', body: { revision: await f.revision(), request_id: crypto.randomUUID() } })).body.status).toBe(200);
    const payment = { orderId: order.order_id, payType: 'weixin' as const, tradeNo: 'quota-snapshot-proof', expectedAmountCents: 10000, now: 1700000100 };
    expect((await applyRechargePayment(f.container, payment)).outcome).toBe('paid');
    expect((await applyRechargePayment(f.container, payment)).outcome).toBe('already-paid');
    const after = await f.snapshot(); expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ price: '100.00', givePrice: '10.00', paid: 1 });
    expect(after.users[0].nowMoney).toBe('115.00'); expect(after.bills).toHaveLength(1);
  });

  it('preserves custom cash amount/channel guards and rolls back failed package persistence', async () => {
    for (const amount of [0, -1, 100000.01, 0.001]) await expect(f.finance.recharge(10, amount, 'h5')).rejects.toThrow();
    await expect(f.finance.recharge(10, 1, 'bad')).rejects.toThrow('不支持');
    expect((await f.finance.recharge(10, 2.34, 'h5')).price).toBe('2.34');
    await f.exec("CREATE FUNCTION reject_quota_order() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture order unavailable'; END $$ LANGUAGE plpgsql; CREATE TRIGGER quota_order_fail BEFORE INSERT ON user_recharge FOR EACH ROW EXECUTE FUNCTION reject_quota_order()");
    const before = await f.snapshot(); await expect(f.finance.recharge(10, 1, 'h5', 101)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  });

  it('uses one read-only repeatable-read list snapshot with bounded transaction-local deadlines', async () => {
    const run = f.container.db.transaction.bind(f.container.db);
    const spy = vi.spyOn(f.container.db, 'transaction').mockImplementation(async callback => run(async tx => {
      const result = await callback(tx);
      const settings = await (tx as any).execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
      expect(settings[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' }); return result;
    }));
    expect((await f.request()).body.status).toBe(200); expect(spy).toHaveBeenCalledTimes(1); spy.mockRestore();
    expect((await f.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`))[0].timeout).toBe('0');
  });
});
