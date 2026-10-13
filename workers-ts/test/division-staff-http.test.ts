import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createToken, md5 } from '@/utils/jwt';
import { DivisionStaffService } from '@/services/division/DivisionStaffService';
import { parseDivisionStaffList } from '@/services/division/DivisionStaffInput';
import { qrcode, user } from '@/models/schema';
import { divisionStaffFixture } from './helpers/divisionStaffFixture';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
type Reply = { status: number; msg: string; data: any };
describe('actual registered employee lifecycle, customer JWT and SQL identity authority', () => {
  let f: Awaited<ReturnType<typeof divisionStaffFixture>>, tokens: Record<number, string>;
  const app = createApp();
  beforeAll(async () => {
    f = await divisionStaffFixture(); wiring.open.mockImplementation(() => f.container);
    tokens = Object.fromEntries(await Promise.all([10, 22, 30, 44, 77].map(async uid =>
      [uid, (await createToken(uid, 'api', md5(f.password), f.env.APP_KEY)).token])));
  }, 30000);
  beforeEach(async () => { await f.seed(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Employee tests forbid provider/production I/O')); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30000);
  async function request(path: string, method = 'GET', body?: unknown, uid = 22, token = tokens[uid], raw?: BodyInit) {
    const response = await app.request(`/api/division/agent/${path}`, { method,
      headers: { 'Authori-zation': `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}) }, f.env);
    return { response, body: await response.json<Reply>() };
  }
  it('projects all old staff fields, exact order/children scopes and historical commission without any write', async () => {
    const before = await f.snapshot(), result = await request('staff_list');
    expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data).toMatchObject({ count: 2, brokerage: '1.50', page: 1, limit: 20,
      agent: { uid: 22, divisionPercent: 40 } });
    expect(result.body.data.list.find((row: any) => row.uid === 44)).toMatchObject({ uid: 44, spread_uid: 22,
      spread_time: '2023/11/15', spreadTime: 1700000000, division_percent: 10, divisionPercent: 10,
      pay_count: 0, childCount: 1, orderCount: 2, numberCount: '30.00' });
    expect(result.body.data.list.every((row: any) => !('pwd' in row) && !('nowMoney' in row) && /^[a-f0-9]{64}$/.test(row.revision))).toBe(true);
    expect(result.response.headers.get('cache-control')).toContain('private, no-store');
    expect(result.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await f.snapshot()).toEqual(before); expect(f.writes).toEqual([]);
  });
  it('supports old date/query caller, inclusive boundaries, literal search and correct pagination', async () => {
    expect((await request('staff_list?start=1700000000&stop=1700000000')).body.data.list.map((row: any) => row.uid)).toEqual([44]);
    expect((await request('staff_list?keyword=%E5%91%98%E5%B7%A5%E4%B9%99')).body.data.list.map((row: any) => row.uid)).toEqual([45]);
    expect((await request('staff_list?limit=1&page=2')).body.data.list.map((row: any) => row.uid)).toEqual([44]);
    expect((await request('staff_list?keyword=%25')).body.data.list).toEqual([]);
  });
  it.each(['GET', 'POST', 'DELETE'])('executes the genuine identity unlink on %s and keeps user account/assets/spread/history intact', async method => {
    const path = method === 'DELETE' ? 'staff/44' : 'del_staff/44';
    const before = await f.snapshot(), result = await request(path, method);
    expect(result.body.status, result.body.msg).toBe(200); expect(result.body.msg).toBe('删除成功');
    const after = await f.snapshot();
    for (const previous of before.users) {
      const current = after.users.find(row => row.uid === previous.uid)!;
      if ([44, 55, 56].includes(previous.uid)) {
        expect(current.divisionChangeTime).toBeGreaterThan(0);
        expect(current).toEqual({ ...previous, divisionName: '', divisionType: 0, divisionStatus: 0, divisionId: 0,
          agentId: 0, staffId: 0, divisionPercent: 0, divisionEndTime: 0, divisionInvite: 0, divisionChangeTime: current.divisionChangeTime });
      } else expect(current).toEqual(previous);
    }
    expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage); expect(after.bills).toEqual(before.bills);
    expect(after.qr).toEqual(before.qr); expect(f.writes).toEqual([]);
    expect((await request('staff_list')).body.data.list.map((row: any) => row.uid)).toEqual([45]);
    expect((await request(path, method)).body.status).not.toBe(200);
  });
  it.each([0, 999])('also resets the explicitly selected old employee when its own staff_id is %i', async staffId => {
    await f.db.update(user).set({ staffId }).where(eq(user.uid, 44));
    expect((await request('del_staff/44')).body.status).toBe(200);
    expect((await f.snapshot()).users.find(row => row.uid === 44)).toMatchObject({ divisionType: 0, agentId: 0, staffId: 0 });
  });
  it('allows zero and strictly lower-than-agent ratios, preserving every unrelated field', async () => {
    const before = await f.snapshot();
    const result = await request('staff_percent', 'POST', { uid: 44, division_percent: 39 }); expect(result.body.status).toBe(200);
    const changed = (await f.snapshot()).users.find(row => row.uid === 44)!;
    expect(changed).toEqual({ ...before.users.find(row => row.uid === 44), divisionPercent: 39, divisionChangeTime: changed.divisionChangeTime });
    expect((await request('staff_percent', 'POST', { uid: 44, division_percent: 40 })).body.status).not.toBe(200);
    expect((await request('staff_percent', 'POST', { uid: 44, division_percent: 0 })).body.status).toBe(200);
  });
  it.each([10, 30, 44, 77])('rejects wrong customer role/agent ownership %i for list/ratio/unlink', async uid => {
    const before = await f.snapshot();
    for (const [path, method, body] of [['staff_list', 'GET', undefined], ['del_staff/44', 'GET', undefined],
      ['staff_percent', 'POST', { uid: 44, division_percent: 1 }]] as const) {
      // Another valid agent can read only its own list, never agent22's rows.
      const result = await request(path, method, body, uid);
      if (uid === 30 && path === 'staff_list') { expect(result.body.status).toBe(200); expect(result.body.data.list).toEqual([]); }
      else { expect(result.body.status).not.toBe(200); expect(result.body.data).toBeNull(); }
    }
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([{ divisionStatus: 0 }, { divisionEndTime: 1 }, { divisionType: 0 }, { status: 0 }, { isDel: 1 }, { deleteTime: new Date() }])('rejects actual current-agent withdrawal %j on every write without mutation', async change => {
    await f.db.update(user).set(change).where(eq(user.uid, 22)); const before = await f.snapshot();
    expect((await request('del_staff/44')).body.status).not.toBe(200);
    expect((await request('staff_percent', 'POST', { uid: 44, division_percent: 1 })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('rejects missing, foreign-type and stale-password JWT before any identity write, with private errors', async () => {
    const before = await f.snapshot();
    for (const token of ['', (await createToken(22, 'admin', md5(f.password), f.env.APP_KEY)).token,
      (await createToken(22, 'api', md5('changed-password'), f.env.APP_KEY)).token]) {
      const result = await request('del_staff/44', 'GET', undefined, 22, token);
      expect(result.body.status).not.toBe(200); expect(result.body.data).toBeNull();
      expect(result.response.headers.get('cache-control')).toContain('no-store');
    }
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(['del_staff/0', 'del_staff/044', 'del_staff/1e2', 'del_staff/2147483648', 'del_staff/44?agent_id=30',
    'staff_list?page=1&page=2', 'staff_list?agent_id=30', 'staff_list?start=2&stop=1'])('fails closed on actual boundary path %s', async path => {
    const before = await f.snapshot(); expect((await request(path)).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
  });
  it.each(['{"uid":44,"uid":45,"division_percent":1}', '{"uid":44,"division_percent":1,"agent_id":30}',
    '{"uid":44,"division_percent":null}', '{"uid":44,"division_percent":1,"padding":"' + 'x'.repeat(2100) + '"}'])('rejects duplicate/forged/oversized actual ratio JSON', async raw => {
    const before = await f.snapshot(); expect((await request('staff_percent', 'POST', {}, 22, tokens[22], raw)).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('rejects a stale modern relationship revision after a true SQL edit for both percentage and removal', async () => {
    const list = await request('staff_list'), old = list.body.data.list.find((row: any) => row.uid === 44);
    await f.db.update(user).set({ divisionPercent: 11 }).where(eq(user.uid, 44)); const before = await f.snapshot();
    expect((await request('staff_percent', 'POST', { uid: 44, division_percent: 5, revision: old.revision })).body.status).not.toBe(200);
    expect((await request('staff/44', 'DELETE', { revision: old.revision })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('resolves an existing QR record ID to the real agent and binds only the authenticated applicant; no UID fallback', async () => {
    const preview = await request('bind_info?agent_code=901', 'GET', undefined, 77); expect(preview.body.status).toBe(200);
    expect(preview.body.data).toMatchObject({ agent: { uid: 22 }, source: 'qrcode', codeId: 901, canBind: true });
    const before = await f.snapshot(), bound = await request('spread', 'POST', { agent_code: 901, invite_revision: preview.body.data.revision }, 77);
    expect(bound.body.status, bound.body.msg).toBe(200); expect(bound.body.msg).toBe('绑定成功');
    const after = await f.snapshot(), previous = before.users.find(row => row.uid === 77)!, current = after.users.find(row => row.uid === 77)!;
    expect(current).toEqual({ ...previous, spreadUid: 22, spreadTime: current.spreadTime, divisionType: 3, divisionStatus: 1,
      divisionId: 10, agentId: 22, staffId: 77, divisionEndTime: before.users.find(row => row.uid === 22)!.divisionEndTime,
      divisionChangeTime: current.divisionChangeTime, divisionPercent: 0, divisionInvite: 0, isPromoter: 1 });
    expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
    expect((await request('spread', 'POST', { agent_code: 901 }, 77)).body.status).not.toBe(200);
  });
  it('preserves the separate genuine old H5 agent_id UID contract', async () => {
    const preview = await request('bind_info?agent_id=22', 'GET', undefined, 77);
    expect(preview.body.data).toMatchObject({ source: 'legacy_h5', agent: { uid: 22 }, codeId: 0 });
    expect((await request('spread', 'POST', { agent_id: 22 }, 77)).body.status).toBe(200);
  });
  it.each([22, 903, 904, 999999])('never interprets an invalid QR record %i as an agent UID', async code => {
    const before = await f.snapshot(); expect((await request('spread', 'POST', { agent_code: code }, 77)).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  });
  it('rejects a true QR remapping/revocation after preview instead of silently binding another real agent', async () => {
    const p = await request('bind_info?agent_code=901', 'GET', undefined, 77);
    await f.db.delete(qrcode).where(eq(qrcode.id, 902));
    await f.db.update(qrcode).set({ thirdId: 30 }).where(eq(qrcode.id, 901)); const before = await f.snapshot();
    expect((await request('spread', 'POST', { agent_code: 901, invite_revision: p.body.data.revision }, 77)).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(qrcode).set({ status: 0 }).where(eq(qrcode.id, 901));
    expect((await request('spread', 'POST', { agent_code: 901 }, 77)).body.status).not.toBe(200);
  });
  it('rejects staff/account/agent scope changes before locked writes and actual expiry after later work', async () => {
    const service = new DivisionStaffService(f.container), before = await f.snapshot();
    await expect(service.remove({ ...f.actor(), expiresAt: 1 }, 44)).rejects.toThrow('登录');
    await expect(service.remove({ ...f.actor(), passwordVersion: 'stale' }, 44)).rejects.toThrow('登录');
    await expect(service.bind(f.actor(22), { agentId: 22, agentCode: 0 })).rejects.toThrow('自己');
    expect(await f.snapshot()).toEqual(before);
  });
  it('does not release a readonly staff list if the account password is revoked after the snapshot', async () => {
    const original = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementation(async (callback, ...options) => {
      const result = await original(callback, ...options);
      await f.db.update(user).set({ pwd: 'revoked-after-read' }).where(eq(user.uid, 22));
      return result;
    });
    await expect(new DivisionStaffService(f.container).list(f.actor(), parseDivisionStaffList({}))).rejects.toThrow('登录状态已变化');
  });
  it('rolls back both selected employee and all related users if a true SQL trigger fails on a descendant', async () => {
    await f.exec("CREATE FUNCTION division_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=55 AND NEW.staff_id=0 THEN RAISE EXCEPTION 'owned descendant failure'; END IF; RETURN NEW; END $$");
    await f.exec('CREATE TRIGGER division_staff_failure BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_failure()');
    try {
      const before = await f.snapshot(); expect((await request('del_staff/44')).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER division_staff_failure ON "user"'); await f.exec('DROP FUNCTION division_staff_failure()'); }
  });
  it.each(['remove', 'percent', 'bind'] as const)('rolls back complete %s identity write when a real BEFORE trigger suppresses it', async kind => {
    const uid = kind === 'bind' ? 77 : 44;
    await f.exec(`CREATE FUNCTION division_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=${uid} THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER division_staff_failure BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_failure()');
    try {
      const before = await f.snapshot();
      const response = kind === 'remove' ? await request('del_staff/44') : kind === 'percent' ? await request('staff_percent', 'POST', { uid: 44, division_percent: 11 }) : await request('spread', 'POST', { agent_code: 901 }, 77);
      expect(response.body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER division_staff_failure ON "user"'); await f.exec('DROP FUNCTION division_staff_failure()'); }
  });
  it.each(['remove', 'percent', 'bind'] as const)('rolls back complete %s facts when a real BEFORE trigger rewrites an authorized role/asset field', async kind => {
    const uid = kind === 'bind' ? 77 : 44, rewrite = kind === 'remove' ? 'NEW.staff_id=44;' : kind === 'percent' ? 'NEW.division_percent=12;' : 'NEW.agent_id=30;';
    await f.exec(`CREATE FUNCTION division_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=${uid} THEN ${rewrite} NEW.now_money=NEW.now_money+1; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER division_staff_failure BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_failure()');
    try {
      const before = await f.snapshot();
      const response = kind === 'remove' ? await request('del_staff/44') : kind === 'percent' ? await request('staff_percent', 'POST', { uid: 44, division_percent: 11 }) : await request('spread', 'POST', { agent_code: 901 }, 77);
      expect(response.body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER division_staff_failure ON "user"'); await f.exec('DROP FUNCTION division_staff_failure()'); }
  });
  it.each(['remove', 'percent', 'bind'] as const)('rolls back complete %s facts after a real AFTER trigger changes the stored row beyond correct RETURNING', async kind => {
    const uid = kind === 'bind' ? 77 : 44;
    await f.exec(`CREATE FUNCTION division_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=${uid} AND pg_trigger_depth()=1 THEN UPDATE "user" SET division_percent=99,integral=integral+1 WHERE uid=${uid}; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER division_staff_failure AFTER UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_failure()');
    try {
      const before = await f.snapshot();
      const response = kind === 'remove' ? await request('del_staff/44') : kind === 'percent' ? await request('staff_percent', 'POST', { uid: 44, division_percent: 11 }) : await request('spread', 'POST', { agent_code: 901 }, 77);
      expect(response.body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER division_staff_failure ON "user"'); await f.exec('DROP FUNCTION division_staff_failure()'); }
  });
  it('rolls back a real AFTER employee trigger that preserves target/agent facts but changes the already locked division parent balance', async () => {
    await f.exec('CREATE FUNCTION division_staff_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=44 AND pg_trigger_depth()=1 THEN UPDATE "user" SET now_money=now_money+1 WHERE uid=10; END IF; RETURN NEW; END $$');
    await f.exec('CREATE TRIGGER division_staff_failure AFTER UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_failure()');
    try { const before = await f.snapshot(); expect((await request('del_staff/44')).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); }
    finally { await f.exec('DROP TRIGGER division_staff_failure ON "user"'); await f.exec('DROP FUNCTION division_staff_failure()'); }
  });
});
