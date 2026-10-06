import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeActivity, storeSeckill, storeSeckillTime, systemAttachment } from '../src/models/schema';
import { AdminPermissionService, requiredAdminPermission } from '../src/services/admin/AdminPermissionService';
import { AdminSeckillTimeService } from '../src/services/admin/AdminSeckillTimeService';
import { seckillDayStart } from '../src/services/activity/SeckillScheduleService';
import { seckillTimeFixture, seckillTimeInput } from './helpers/seckillTimeFixture';

// PGlite proves business SQL only. SECURITY DEFINER identity/catalog/LOGIN
// boundaries are exercised without this mock in the native PostgreSQL suite.
vi.mock('../src/migrations/seckillTimeReferenceLock', async importOriginal => {
  const original = await importOriginal<typeof import('../src/migrations/seckillTimeReferenceLock')>();
  return { ...original, acquireSeckillTimeReferenceLock: process.env.TEST_FINANCE_POSTGRES_URL ? original.acquireSeckillTimeReferenceLock :
    async (tx: any) => tx.execute(sql`LOCK TABLE store_activity, store_seckill IN EXCLUSIVE MODE`) };
});

describe('Admin seckill times on disposable SQL', () => {
  let f: Awaited<ReturnType<typeof seckillTimeFixture>>;
  beforeEach(async () => { f = await seckillTimeFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await f?.close(); });
  const input = (extra: Record<string, unknown> = {}) => ({ ...seckillTimeInput, request_id: crypto.randomUUID(), ...extra });
  const remove = async (id = 101) => f.request(`/${id}`, { method: 'DELETE', body: { revision: await f.revision(id), request_id: crypto.randomUUID() } });

  it('lists hidden and legacy HHmm rows with stable chronological pages, literal search and signed previews', async () => {
    const first = await f.request('?limit=1');
    expect(first.response.headers.get('cache-control')).toBe('private, no-store');
    expect(first.body.data).toMatchObject({ count: 2, page: 1, limit: 1, list: [{ id: 101, start_time: '09:00', end_time: '11:00', valid: true, pic: '/api/assets/41' }] });
    expect(first.body.data.list[0].pic_preview).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
    expect(first.body.data.list[0].revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.request('?page=2&limit=1')).body.data.list[0].id).toBe(102);
    expect((await f.request()).body.data.limit).toBe(20);
    expect((await f.request('?status=0')).body.data.count).toBe(1);
    await f.db.update(storeSeckillTime).set({ title: 'literal%_\\name' }).where(eq(storeSeckillTime.id, 101));
    expect((await f.request('?title=%25_')).body.data.list.map((row: any) => row.id)).toEqual([101]);
    expect((await f.request('?title=%25')).body.data.count).toBe(1);
  });

  it('rejects duplicate, unknown and unbounded queries and ambiguous IDs', async () => {
    for (const query of ['page=0', 'page=01', 'page=1e1', 'page=1&page=2', 'limit=101', 'page=102&limit=100', 'status=2', 'status=0&status=1', 'gid=62', 'title=a&title=b']) {
      expect((await f.request(`?${query}`)).body.status).not.toBe(200);
    }
    for (const path of ['/0', '/01', '/999', '/101?status=1']) expect((await f.request(path)).body.status).not.toBe(200);
  });

  it('requires independent read/manage permissions on both registered route families', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect(requiredAdminPermission('GET', `${prefix}/activity/seckill-times`)).toBe('seckill_time.view');
      expect(requiredAdminPermission('PUT', `${prefix}/activity/seckill-times/101/status`)).toBe('seckill_time.manage');
      expect((await f.request('', { prefix, token: f.tokens.reader })).body.status).toBe(200);
      expect((await f.request('', { prefix, method: 'POST', body: input(), token: f.tokens.reader })).body.status).not.toBe(200);
      expect((await f.request('', { prefix, token: f.tokens.other })).body.status).not.toBe(200);
    }
    expect(new AdminPermissionService(f.container).buildMenus(new Set(['seckill_time.view'])))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/activity/seckill-times' })]));
  });

  it('writes only a slot and atomic redacted audit; exact same-key retries do not rewrite it', async () => {
    const body = input({ title: '  下午场  ', pic: '/api/assets/42?expires=1&signature=old' });
    const before = await f.snapshot(), created = (await f.request('', { method: 'POST', body })).body;
    expect(created.status).toBe(200);
    const after = await f.snapshot(); expect(after.slots.find(row => row.id === created.data.id)).toMatchObject({ title: '下午场', startTime: '14:00', endTime: '16:00', pic: '/api/assets/42' });
    expect(after.parents).toEqual(before.parents); expect(after.children).toEqual(before.children); expect(after.logs).toHaveLength(1);
    expect(after.logs[0].action).toMatch(/^create;id=\d+;payload=[a-f0-9]{64}$/); expect(JSON.stringify(after.logs)).not.toContain('下午场');
    expect((await f.request('', { method: 'POST', body })).body).toEqual(created); expect(await f.snapshot()).toEqual(after);
  });

  it('binds replay to actor/content/operation/target/version, including after deletion', async () => {
    const body = input(), result = (await f.request('', { method: 'POST', body })).body.data;
    expect((await f.request('', { method: 'POST', body: { ...body, title: 'changed' } })).body.status).not.toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: body.request_id, status: 0 } })).body.status).not.toBe(200);
    // Different actor cannot replay another actor's journal; overlap still rejects this new create.
    expect((await f.request('', { method: 'POST', body, token: f.tokens.second })).body.status).not.toBe(200);
    const deletion = { revision: await f.revision(result.id), request_id: crypto.randomUUID() };
    expect((await f.request(`/${result.id}`, { method: 'DELETE', body: deletion })).body.status).toBe(200);
    const after = await f.snapshot();
    expect((await f.request('', { method: 'POST', body })).body.data).toEqual(result);
    expect((await f.request(`/${result.id}`, { method: 'DELETE', body: deletion })).body.status).toBe(200);
    expect(await f.snapshot()).toEqual(after);
  });

  it('rejects invalid time, crossed midnight, unsafe image refs and unsupported body fields', async () => {
    const before = await f.snapshot();
    for (const extra of [{ start_time: '1400' }, { start_time: '4:00' }, { start_time: '24:00' }, { end_time: '24:01' },
      { end_time: '14:00' }, { start_time: '23:00', end_time: '01:00' }, { title: '' }, { title: 'x'.repeat(256) },
      { describe: '' }, { describe: 'a\nb' }, { pic: 'javascript:alert(1)' }, { pic: '//example.invalid/a.png' },
      { pic: 'http://example.invalid/a.png' }, { pic: 'https://user:pass@example.invalid/a.png' }, { pic: '/\\evil' },
      { pic: '/api/assets/2147483648' }, { pic: '/api/assets/99999999999999999999' },
      { status: 2 }, { status: '1' }, { time_id: '101' }, { request_id: 'not-uuid' }]) {
      expect((await f.request('', { method: 'POST', body: input(extra) })).body.status).not.toBe(200);
    }
    expect((await f.request('', { method: 'POST', body: input({ title: 'x'.repeat(9000) }) })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
    expect((await f.request('', { method: 'POST', body: input({ start_time: '23:00', end_time: '24:00' }) })).body.status).toBe(200);
  });

  it('counts hidden intervals when rejecting overlap but permits adjacent endpoints', async () => {
    for (const [start_time, end_time] of [['10:00', '12:00'], ['10:00', '10:30'], ['08:00', '14:00'], ['12:00', '14:00']]) {
      expect((await f.request('', { method: 'POST', body: input({ start_time, end_time, status: 0 }) })).body.msg).toContain('不可重叠');
    }
    expect((await f.request('', { method: 'POST', body: input({ start_time: '13:00', end_time: '14:00' }) })).body.status).toBe(200);
  });

  it('invalidates full-row+xmin revisions for external rewrites and stale confirmations', async () => {
    const revision = await f.revision();
    await f.db.update(storeSeckillTime).set({ title: '早场' }).where(eq(storeSeckillTime.id, 101)); // same content still changed xmin
    for (const [path, method, body] of [['/101', 'PUT', input({ revision, start_time: '07:00', end_time: '08:00' })],
      ['/101/status', 'PUT', { revision, request_id: crypto.randomUUID(), status: 0 }], ['/101', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body })).body.msg).toContain('已更新');
    }
    expect((await f.snapshot()).logs).toHaveLength(0);
  });

  it('protects the existing 1000-visible consumer cap while allowing hidden creation, edits and recovery', async () => {
    await f.db.insert(storeSeckillTime).values(Array.from({ length: 999 }, (_, n) => ({ id: 200 + n, title: '旧可见样本',
      startTime: '00:00', endTime: '00:01', pic: '/images/legacy.png', describe: '隔离样本', status: 1 })));
    expect((await f.request('', { method: 'POST', body: input() })).body.msg).toContain('最多显示1000');
    const hidden = (await f.request('', { method: 'POST', body: input({ status: 0 }) })).body;
    expect(hidden.status).toBe(200);
    expect((await f.request(`/${hidden.data.id}/status`, { method: 'PUT', body: { revision: await f.revision(hidden.data.id), request_id: crypto.randomUUID(), status: 1 } })).body.msg).toContain('最多显示1000');
    expect((await f.request('/102', { method: 'PUT', body: input({ revision: await f.revision(102), start_time: '11:00', end_time: '13:00', status: 1 }) })).body.msg).toContain('最多显示1000');
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), start_time: '07:00', end_time: '08:00', status: 1 }) })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    expect((await f.request('/102/status', { method: 'PUT', body: { revision: await f.revision(102), request_id: crypto.randomUUID(), status: 1 } })).body.status).toBe(200);
    expect((await f.request('?status=1&limit=100')).body.data.count).toBe(1000);
  });

  it('surfaces malformed times for hide/repair/delete, and blocks status-only show', async () => {
    await f.db.update(storeSeckillTime).set({ startTime: 'bad', pic: 'javascript:alert(1)' }).where(eq(storeSeckillTime.id, 101));
    expect((await f.request('/101')).body.data).toMatchObject({ valid: false, pic: '', pic_preview: '', start_time: 'bad' });
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 1 } })).body.status).not.toBe(200);
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), start_time: '07:00', end_time: '08:00' }) })).body.status).toBe(200);
    await f.db.update(storeSeckillTime).set({ endTime: 'bad' }).where(eq(storeSeckillTime.id, 102));
    expect((await remove(102)).body.status).toBe(200);
  });

  it('presents invalid legacy flags as hidden without losing original revisions or blocking the whole list', async () => {
    await f.db.update(storeSeckillTime).set({ status: 2 }).where(eq(storeSeckillTime.id, 101));
    await f.db.update(storeSeckillTime).set({ status: -1 }).where(eq(storeSeckillTime.id, 102));
    const list = (await f.request()).body;
    expect(list.status).toBe(200); expect(list.data.list.map((row: any) => ({ id: row.id, status: row.status, valid: row.valid })))
      .toEqual([{ id: 101, status: 0, valid: false }, { id: 102, status: 0, valid: false }]);
    expect((await f.request('/101')).body.data).toMatchObject({ status: 0, valid: false });
    expect((await f.snapshot()).slots.map(row => row.status)).toEqual([2, -1]);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    expect((await f.request('/101')).body.data).toMatchObject({ status: 0, valid: true });
    expect((await f.request('/102', { method: 'PUT', body: input({ revision: await f.revision(102), start_time: '11:00', end_time: '13:00', status: 0 }) })).body.status).toBe(200);
    expect((await f.request('/102')).body.data).toMatchObject({ status: 0, valid: true });
  });

  it('repairs multiple referenced damaged intervals only through explicit hidden, nonoverlapping updates', async () => {
    await f.db.update(storeSeckillTime).set({ startTime: 'bad' });
    const today = Math.floor(seckillDayStart(new Date()) / 1000);
    await f.db.insert(storeActivity).values({ id: 1, type: 1, status: 1, timeId: '101,102', startDay: today, endDay: today + 86400 });
    expect((await remove()).body.status).not.toBe(200);
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), start_time: '07:00', end_time: '08:00' }) })).body.status).not.toBe(200);
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), start_time: '07:00', end_time: '08:00', status: 0 }) })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 1 } })).body.status).not.toBe(200);
    expect((await f.request('/102', { method: 'PUT', body: input({ revision: await f.revision(102), start_time: '07:30', end_time: '09:00', status: 0 }) })).body.msg).toContain('不可重叠');
    expect((await f.request('/102', { method: 'PUT', body: input({ revision: await f.revision(102), start_time: '08:00', end_time: '09:00', status: 0 }) })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 1 } })).body.status).toBe(200);
  });

  it.each(['future', 'today', 'hidden', 'legacy-pair', 'whitespace'] as const)('protects not-ended parent references including %s', async kind => {
    const today = Math.floor(seckillDayStart(new Date()) / 1000);
    await f.db.insert(storeActivity).values({ id: 1, type: 1, status: kind === 'hidden' ? 0 : 1, isDel: 0,
      startDay: kind === 'future' ? today + 86400 : today, endDay: kind === 'future' ? today + 172800 : today,
      timeId: kind === 'legacy-pair' ? '999' : kind === 'whitespace' ? '\t\u00a0101\n\ufeff' : '101',
      startTime: kind === 'legacy-pair' ? 900 : 0, endTime: kind === 'legacy-pair' ? 1100 : 0 });
    const before = await f.snapshot(); expect((await remove()).body.msg).toContain('父活动'); expect(await f.snapshot()).toEqual(before);
    // Existing references do not prevent edit/hide; no parent/child cascade is exposed.
    expect((await f.request('/101', { method: 'PUT', body: input({ revision: await f.revision(), start_time: '07:00', end_time: '08:00' }) })).body.status).toBe(200);
    expect((await f.request('/101/status', { method: 'PUT', body: { revision: await f.revision(), request_id: crypto.randomUUID(), status: 0 } })).body.status).toBe(200);
    expect((await f.snapshot()).parents).toEqual(before.parents);
  });

  it.each(['child-only', 'hidden', 'parent-mismatch', 'midnight', 'nonfinite'] as const)('protects existing child references including %s', async kind => {
    const today = seckillDayStart(new Date());
    await f.db.insert(storeSeckill).values({ id: 1, activityId: kind === 'parent-mismatch' ? 99 : 0, timeId: '\t101\u00a0',
      status: kind === 'hidden' ? 0 : 1, isShow: kind === 'hidden' ? 0 : 1, isDel: 0,
      stopTime: kind === 'midnight' ? new Date(today) : null });
    if (kind === 'nonfinite') await f.exec("UPDATE store_seckill SET stop_time='-infinity'");
    const before = await f.snapshot(); expect((await remove()).body.msg).toContain('商品'); expect(await f.snapshot()).toEqual(before);
  });

  it('allows unrelated, already-deleted and actually ended references without ID substring confusion', async () => {
    const today = Math.floor(seckillDayStart(new Date()) / 1000);
    await f.db.insert(storeActivity).values([{ id: 1, timeId: '1010', startDay: today, endDay: today + 86400 },
      { id: 2, timeId: '101', isDel: 1, startDay: today, endDay: today + 86400 }, { id: 3, timeId: '101', startDay: today - 172800, endDay: today - 86400 }]);
    await f.db.insert(storeSeckill).values([{ id: 1, timeId: '1010' }, { id: 2, timeId: '101', isDel: 1 },
      { id: 3, timeId: '101', stopTime: new Date(Date.now() - 3600000) }]);
    expect((await remove()).body.status).toBe(200);
  });

  it('refuses canonical references from user/kefu/supplier/video or missing metadata and never signs them on read', async () => {
    await f.db.insert(systemAttachment).values([
      { attId: 51, type: 3, relationId: 10, moduleType: 3, fileType: 1, attDir: '/api/assets/51' },
      { attId: 52, type: 1, relationId: 8, moduleType: 2, fileType: 1, attDir: '/api/assets/52' },
      { attId: 53, type: 4, relationId: 9, moduleType: 1, fileType: 1, attDir: '/api/assets/53' },
      { attId: 54, type: 1, relationId: 0, moduleType: 1, fileType: 2, attDir: '/api/assets/54' },
    ]);
    for (const id of [51, 52, 53, 54, 55]) {
      expect((await f.request('', { method: 'POST', body: input({ pic: `/api/assets/${id}` }) })).body.msg).toContain('平台');
      await f.db.update(storeSeckillTime).set({ pic: `/api/assets/${id}` }).where(eq(storeSeckillTime.id, 101));
      expect((await f.request('/101')).body.data).toMatchObject({ pic: '', pic_preview: '', valid: false });
      expect((await f.public.seckillTimes()).seckillTime.find(row => row.id === 101)!.pic).toBe('');
    }
  });

  it('publishes signed canonical slot images after create/edit/show and excludes hidden rows', async () => {
    const created = (await f.request('', { method: 'POST', body: input() })).body.data;
    const row = (await f.public.seckillTimes()).seckillTime.find(row => row.id === created.id)!;
    expect(row).toMatchObject({ title: '下午场', start_time: '14:00', end_time: '16:00' }); expect(row.pic).toMatch(/^\/api\/assets\/42\?expires=/);
    const publicRoute = await (await f.app.request('/api/seckill/index', {}, f.env)).json<{ status: number; data: { seckillTime: Array<{ id: number; pic: string }> } }>();
    expect(publicRoute.status).toBe(200); expect(publicRoute.data.seckillTime.find(row => row.id === created.id)?.pic).toMatch(/^\/api\/assets\/42\?expires=/);
    expect((await f.request(`/${created.id}/status`, { method: 'PUT', body: { request_id: crypto.randomUUID(), revision: await f.revision(created.id), status: 0 } })).body.status).toBe(200);
    expect((await f.public.seckillTimes()).seckillTime.map(row => row.id)).not.toContain(created.id);
  });

  it('keeps static images usable without APP_KEY and requires signing only for admitted canonical media', async () => {
    await f.db.update(storeSeckillTime).set({ pic: '/images/static.png' }).where(eq(storeSeckillTime.id, 101));
    const service = new AdminSeckillTimeService(f.container);
    expect((await service.detail(101)).pic_preview).toBe('/images/static.png');
    expect((await service.list(new URLSearchParams())).count).toBe(2);
  });

  it('rolls back every mutation when audit insert fails', async () => {
    await f.exec("CREATE FUNCTION reject_slot_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END $$ LANGUAGE plpgsql; CREATE TRIGGER slot_audit_fail BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_slot_audit()");
    const before = await f.snapshot(), revision = await f.revision();
    for (const [path, method, body] of [['', 'POST', input()], ['/101', 'PUT', input({ revision, start_time: '07:00', end_time: '08:00' })],
      ['/101/status', 'PUT', { revision, request_id: crypto.randomUUID(), status: 0 }], ['/101', 'DELETE', { revision, request_id: crypto.randomUUID() }]] as const) {
      expect((await f.request(path, { method, body })).body.status).toBe(500); expect(await f.snapshot()).toEqual(before);
    }
  });

  it('uses a read-only repeatable-read list snapshot with transaction-local deadline settings', async () => {
    const run = f.container.db.transaction.bind(f.container.db);
    const spy = vi.spyOn(f.container.db, 'transaction').mockImplementation(async callback => run(async tx => {
      const result = await callback(tx);
      const rows = await (tx as any).execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS statement,
        current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle`);
      expect(rows[0]).toMatchObject({ isolation: 'repeatable read', readonly: 'on', statement: '5s', lock: '2s', idle: '5s' });
      return result;
    }));
    expect((await f.request()).body.status).toBe(200); expect(spy).toHaveBeenCalledTimes(1);
  });
});
