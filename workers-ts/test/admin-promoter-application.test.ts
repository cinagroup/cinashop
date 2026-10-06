import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { promoterApply, systemLog, user } from '../src/models/schema';
import { PromoterApplicationService } from '../src/services/agent/PromoterApplicationService';
import { SmsVerificationService } from '../src/services/message/SmsVerificationService';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { promoterApplicationFixture } from './helpers/promoterApplicationFixture';

describe('Admin promoter application review contract on SQL', () => {
  let f: Awaited<ReturnType<typeof promoterApplicationFixture>>;
  beforeEach(async () => { f = await promoterApplicationFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const decision = async (status: 1 | 2, revision?: string, reason?: string) =>
    f.request(`examine/101/11/${status}`, { method: 'POST', body: { revision: revision ?? await f.revision(),
      ...(reason === undefined ? {} : { refusal_reason: reason }) } });

  it('paginates stable snapshots with old list fields, literal search and an opaque revision', async () => {
    await f.db.insert(promoterApply).values(Array.from({ length: 35 }, (_, n) => ({ id: n + 201, uid: n + 1001,
      nickname: n === 0 ? '百分%会员' : n === 1 ? 'under_score' : n === 2 ? 'back\\slash' : `合成昵称${n}`,
      realName: `实名${n}`, phone: `1234567${n}`, status: n % 3, isDel: n === 34 ? 1 : 0 })));
    const ids: number[] = [];
    for (const page of [1, 2, 3]) {
      const { response, body } = await f.request(`list?page=${page}`);
      expect(body.status, body.msg).toBe(200);
      expect(body.data).toMatchObject({ count: 35, page, limit: 15 });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      ids.push(...body.data.list.map((row: { id: number }) => row.id));
      expect(body.data.list.every((row: { revision: string }) => /^[a-f0-9]{64}$/.test(row.revision))).toBe(true);
    }
    expect(ids).toEqual([...Array.from({ length: 34 }, (_, n) => 234 - n), 101]);
    for (const [keyword, id] of [['%', 201], ['_', 202], ['\\', 203]] as const) {
      const data = (await f.request(`list?keyword=${encodeURIComponent(keyword)}`)).body.data;
      expect(data.count).toBe(1); expect(data.list[0].id).toBe(id);
    }
    const original = (await f.request('list?keyword=13800138000')).body.data.list[0];
    expect(original).toMatchObject({ id: 101, uid: 11, nickname: '申请昵称', real_name: '申请实名', phone: '13800138000',
      status: 0, add_time: '2023-11-14 22:13:20', status_time: '', refusal_reason: '' });
    expect(original).not.toHaveProperty('version');
    const pending = (await f.request('list?status=0&limit=100')).body.data;
    expect(pending.count).toBe(13);
    expect(pending.list.every((row: { status: number }) => row.status === 0)).toBe(true);
    expect((await f.request('list?page=101&limit=100')).body.data).toMatchObject({ count: 35, list: [] });
  });

  it('rejects malformed, unknown, duplicate, overflowing and wildcard-control list input', async () => {
    for (const query of ['page=', 'page=0', 'page=-1', 'page=1e2', 'page=01', 'page=1.1', 'limit=0', 'limit=101',
      'page=102&limit=100', 'status=3', 'status=01', 'page=1&page=2', 'status=1&status=1',
      'keyword=a&keyword=b', 'extra=1', 'keyword=%00', 'keyword=%0A', `keyword=${'字'.repeat(101)}`]) {
      const { response, body } = await f.request(`list?${query}`);
      expect(body.status, query).toBe(400);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect((await f.request('list?status=')).body.data).toEqual((await f.request('list?status=all')).body.data);
  });

  it('keeps read and manage authorization on both route families and both review methods', async () => {
    const menuService = new AdminPermissionService(f.container);
    expect(JSON.stringify(menuService.buildMenus(new Set(['distribution.view'])))).toContain('/agent/promoter-applications');
    expect(JSON.stringify(menuService.buildMenus(new Set(['product.view'])))).not.toContain('/agent/promoter-applications');
    const revision = await f.revision();
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('POST', `${prefix}/promoter/apply/examine/101/11/1`)).toBe('distribution.manage');
      expect((await f.request('list', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      for (const token of ['', f.tokens.unrelated]) expect((await f.request('list', { prefix, token })).body.status).not.toBe(200);
      for (const token of ['', f.tokens.reader, f.tokens.unrelated]) {
        for (const method of ['GET', 'POST']) expect((await f.request('examine/101/11/1', {
          prefix, method, token, ...(method === 'POST' ? { body: { revision } } : {}),
        })).body.status).not.toBe(200);
        expect((await f.request('del/101', { prefix, method: 'DELETE', token, body: { revision } })).body.status).not.toBe(200);
      }
    }
    expect((await f.application()).status).toBe(0);
    expect(await f.db.select().from(systemLog)).toHaveLength(0);
  });

  it('approves pending once, grants promoter once, and replays without changing time or audit', async () => {
    const revision = await f.revision();
    const { response, body } = await decision(1, revision);
    expect(body.status, body.msg).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const after = await f.snapshot();
    expect(after.applications[0]).toMatchObject({ status: 1, refusalReason: '' });
    expect(after.users[0].isPromoter).toBe(1);
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0]).toMatchObject({ adminId: 2, adminName: '', ip: '', method: 'POST', type: 'promoter_application' });
    expect(after.logs[0].action).toContain(`from=${revision}`);
    for (const privateValue of ['申请昵称', '申请实名', '13800138000']) expect(JSON.stringify(after.logs)).not.toContain(privateValue);
    expect((await decision(1, revision)).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
    expect((await decision(2, await f.revision(), '更改审核结果')).body).toMatchObject({ status: 400, msg: '申请已审核，不能更改审核结果' });
    expect(await f.snapshot()).toEqual(after);
  });

  it('requires POST refusal text, preserves it only on the application, and rejects changed replays', async () => {
    const revision = await f.revision();
    expect((await decision(2, revision)).body.status).toBe(400);
    for (const reason of ['', '   ', '字'.repeat(1001), '\u0000']) expect((await decision(2, revision, reason)).body.status).toBe(400);
    expect((await decision(2, revision, '  本次审核原因  ')).body.status).toBe(200);
    const after = await f.snapshot();
    expect(after.applications[0]).toMatchObject({ status: 2, refusalReason: '本次审核原因' });
    expect(after.users[0].isPromoter).toBe(0);
    expect(JSON.stringify(after.logs)).not.toContain('本次审核原因');
    expect((await decision(2, revision, '本次审核原因')).body.status).toBe(200);
    expect((await decision(2, revision, '不同原因')).body.status).toBe(400);
    expect((await decision(1, revision)).body.status).toBe(400);
    expect(await f.snapshot()).toEqual(after);
  });

  it('keeps reasonless legacy GET rejection idempotent and prevents reversing the decision', async () => {
    expect((await f.request('examine/101/11/2')).body.status).toBe(200);
    const after = await f.snapshot();
    expect(after.applications[0]).toMatchObject({ status: 2, refusalReason: '' });
    expect(after.logs[0].method).toBe('GET');
    expect((await f.request('examine/101/11/2')).body.status).toBe(200);
    expect((await f.request('examine/101/11/1')).body.status).toBe(400);
    expect(await f.snapshot()).toEqual(after);
  });

  it.each([{ status: 0 }, { isDel: 1 }, { deleteTime: new Date() }])('rejects inactive applicants: %j', async fields => {
    await f.db.update(user).set(fields).where(eq(user.uid, 11));
    const before = await f.snapshot();
    expect((await decision(1)).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });

  it('validates identity, revision, body and exact decision syntax before writing', async () => {
    const revision = await f.revision(), before = await f.snapshot();
    for (const path of ['examine/101/12/1', 'examine/0101/11/1', 'examine/101/11/01', 'examine/101/11/3',
      'examine/2147483648/11/1', 'examine/101/11/1?refusal_reason=x']) {
      expect((await f.request(path, { method: 'POST', body: { revision } })).body.status).not.toBe(200);
    }
    for (const body of [null, {}, [], { revision: null }, { revision: '' }, { revision, unknown: 1 },
      { revision, refusal_reason: 'approval reason' }, { revision, extra: 'x'.repeat(9000) }]) {
      expect((await f.request('examine/101/11/1', { method: 'POST', body })).body.status).toBe(400);
    }
    for (const query of ['?unknown=1', '?refusal_reason=a&refusal_reason=b']) {
      expect((await f.request(`examine/101/11/2${query}`)).body.status).toBe(400);
    }
    expect(await f.snapshot()).toEqual(before);
  });

  it('rolls back application and promoter changes when the audit insert fails', async () => {
    await f.exec("CREATE FUNCTION fail_promoter_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$; CREATE TRIGGER fail_promoter_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION fail_promoter_audit()");
    const before = await f.snapshot();
    expect((await decision(1)).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.request('del/101', { method: 'DELETE', body: { revision: await f.revision() } })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });

  it('soft-deletes with revision, replays without new audit, and retains existing promoter qualification', async () => {
    expect((await decision(1)).body.status).toBe(200);
    const revision = await f.revision();
    expect((await f.request('del/101', { method: 'DELETE', body: { revision } })).body.status).toBe(200);
    const after = await f.snapshot();
    expect(after.applications[0]).toMatchObject({ isDel: 1, status: 1 });
    expect(after.users[0].isPromoter).toBe(1); expect(after.logs).toHaveLength(2);
    expect((await f.request('list')).body.data.count).toBe(0);
    expect((await f.request('del/101', { method: 'DELETE', body: { revision } })).body.status).toBe(200);
    expect((await f.request('del/101', { method: 'DELETE' })).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
    expect((await decision(1, revision)).body.status).not.toBe(200);
  });

  it('requires revision on JSON DELETE while retaining the explicitly bodyless legacy form', async () => {
    const before = await f.snapshot();
    for (const body of [null, {}, { revision: null }, { revision: '' }, { revision: 'x' }, { unknown: 1 }]) {
      expect((await f.request('del/101', { method: 'DELETE', body })).body.status).toBe(400);
    }
    expect(await f.snapshot()).toEqual(before);
    expect((await f.request('del/101', { method: 'DELETE' })).body.status).toBe(200);
    expect((await f.request('del/101', { method: 'DELETE' })).body.status).toBe(200);
    expect((await f.snapshot()).logs).toHaveLength(1);
  });

  it('invalidates confirmations even when the same pending materials are resubmitted in the same second', async () => {
    vi.spyOn(SmsVerificationService.prototype, 'consumeUserCode').mockResolvedValue('13800138000');
    const revision = await f.revision(), service = new PromoterApplicationService(f.container, f.env);
    const before = await f.application();
    await service.submit(11, 101, { nickname: before.nickname, real_name: before.realName, phone: before.phone, code: 'isolated-code' });
    expect(await f.application()).toEqual(before);
    expect(await f.revision()).not.toBe(revision);
    expect((await decision(1, revision)).body).toMatchObject({ status: 400, msg: '申请已更新，请刷新后重新确认' });
    expect((await f.request('del/101', { method: 'DELETE', body: { revision } })).body.status).toBe(400);
    expect((await f.snapshot()).logs).toHaveLength(0);
    expect((await decision(1)).body.status).toBe(200);
  });

  it('cannot replay a rejected revision after resubmission and another rejection with identical material', async () => {
    vi.spyOn(SmsVerificationService.prototype, 'consumeUserCode').mockResolvedValue('13800138000');
    const oldRevision = await f.revision();
    expect((await decision(2, oldRevision, '相同原因')).body.status).toBe(200);
    const row = await f.application();
    await new PromoterApplicationService(f.container, f.env).submit(11, 101, {
      nickname: row.nickname, real_name: row.realName, phone: row.phone, code: 'isolated-code',
    });
    expect((await decision(2, await f.revision(), '相同原因')).body.status).toBe(200);
    const after = await f.snapshot();
    expect((await decision(2, oldRevision, '相同原因')).body.status).toBe(400);
    expect(await f.snapshot()).toEqual(after);
  });

  it('uses a repeatable-read read-only list snapshot and restores local timeouts', async () => {
    const originalTransaction = f.container.db.transaction.bind(f.container.db);
    let queries = 0;
    const transaction = vi.spyOn(f.container.db, 'transaction').mockImplementation(async callback => originalTransaction(async tx => {
      const select = tx.select.bind(tx);
      tx.select = ((...args: unknown[]) => { queries++; return Reflect.apply(select, tx, args); }) as typeof tx.select;
      const result = await callback(tx);
      const actual = await (tx as any).execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout`);
      expect(actual[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
      return result;
    }));
    expect((await f.request('list')).body.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1); expect(queries).toBe(2);
    transaction.mockRestore();
    const actual = await f.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`);
    expect(actual[0].timeout).toBe('0');
  });
});
