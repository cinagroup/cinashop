import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { storeCouponIssue, storeCouponIssueUser, storeCouponUser, systemConfig, systemLog, user, userBill, userMoney } from '../src/models/schema';
import { AdminLevelActivationService } from '../src/services/admin/AdminLevelActivationService';
import { LEVEL_ACTIVATION_KEYS, type LevelActivationInput } from '../src/services/admin/AdminLevelActivationInput';
import { UserLevelService } from '../src/services/user/UserLevelService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { observeCouponTemplateDb, withCouponTemplatePeer, type CouponTemplateRuntimePeer } from './helpers/couponTemplateFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
const actor = { id: 8801 }, uid = 88001, finite = 78001, unlimited = 78002, fixed = 78003;
const logType = 'level_activation_config';
const snapshotTables = ['system_config', 'system_log', 'user', 'user_bill', 'user_money', 'store_coupon_issue',
  'store_coupon_user', 'store_coupon_issue_user', 'store_coupon_product', 'store_product_coupon',
  'store_coupon_template', 'store_coupon_template_issue', 'store_order', 'store_order_cart_info'] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary level activation configuration on formal PG16 and genuine Admin/App LOGINs', () => {
  let f: Fixture;
  const cacheDeletes = vi.fn(async (_key: string): Promise<void> => {});
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    cacheDeletes.mockReset(); cacheDeletes.mockResolvedValue(undefined);
    f = await refundRuntimeFixture();
    // These identities are isolated synthetic business rows. The fixture installs
    // the complete formal chain; no public auth or provider is substituted here.
    await f.db.insert(user).values({ uid, account: 'local-level-activation', nickname: '本机激活用户',
      integral: 10, nowMoney: '1.25', levelStatus: 0, status: 1 });
    const future = new Date(Date.now() + 30 * 86400000);
    const source = { title: '激活赠券', couponTitle: '激活赠券', receiveType: 3, couponType: 0,
      couponPrice: '2.00', useMinPrice: '0.00', status: 1, isDel: 0, day: 7, totalCount: 3, remainCount: 3 };
    await f.db.insert(storeCouponIssue).values([
      { ...source, id: finite },
      { ...source, id: unlimited, isPermanent: 1, totalCount: 0, remainCount: 0 },
      { ...source, id: fixed, day: 0, useStartTime: new Date(Date.now() + 86400000), useEndTime: future },
    ]);
  }, 120000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  const environment = () => ({ ...f.env, CONFIG_KV: { ...f.env.CONFIG_KV, delete: cacheDeletes } });
  const serviceFor = (db: DbClient) => new AdminLevelActivationService(createContainerFromDb(db), environment());
  const consumerFor = (db: DbClient) => new UserLevelService(createContainerFromDb(db), environment());
  async function snapshot() {
    // Complete rows only for these fourteen scenario tables, not all 281 formal
    // tables. PostgreSQL sequence gaps after rollback are intentionally excluded.
    const result: Record<string, unknown> = {};
    for (const table of snapshotTables) result[table] = (await f.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  }
  async function commissioned(run: (admin: CouponTemplateRuntimePeer, app: CouponTemplateRuntimePeer,
    service: AdminLevelActivationService) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.db.execute(sql`SELECT current_database() AS name`);
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test',
        database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const [peer, profile] of [[admin, 'admin'], [app, 'app']] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, profile, names)).toMatchObject({ ready: true, failures: [] });
        expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
        expect((await peer.exec('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user'))[0])
          .toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      }
      await run(admin, app, serviceFor(admin.db));
    }));
  }
  async function body(service: AdminLevelActivationService, overrides: Partial<LevelActivationInput> = {}): Promise<LevelActivationInput> {
    const current = await service.get();
    const options = await service.coupons(new URLSearchParams('limit=100'));
    const ids = overrides.level_give_coupon ?? [];
    const coupons = new Map([...options.list, ...current.selected_coupons].map(row => [row.id, row]));
    return { member_func_status: 1, level_activate_status: 1, level_extend_info: [],
      level_integral_status: 1, level_give_integral: 7, level_money_status: 1, level_give_money: '3',
      level_coupon_status: 1, level_give_coupon: ids, revision: current.revision, request_id: crypto.randomUUID(),
      coupon_revisions: ids.map(id => {
        const row = coupons.get(id); if (!row) throw Error(`Synthetic coupon ${id} has no returned revision`);
        return { id, revision: row.revision };
      }), ...overrides };
  }
  const receipts = () => f.db.select().from(systemLog).where(eq(systemLog.type, logType)).orderBy(systemLog.id);

  it('keeps missing-key reads read-only, uses RR with bounded settings, and denies App configuration writes', async () => {
    await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...LEVEL_ACTIVATION_KEYS]));
    await commissioned(async (admin, app) => {
      const before = await snapshot(), states: unknown[] = []; let commands = 0;
      const observed = serviceFor(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (command === 'execute' && ++commands === 2) states.push((await tx.execute(sql`SELECT
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
          (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
          (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
          (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`))[0]);
      }));
      const current = await observed.get();
      expect(current.missing_keys).toEqual([...LEVEL_ACTIVATION_KEYS]);
      expect(current.settings).toMatchObject({ member_func_status: 0, level_activate_status: 0,
        level_give_integral: 0, level_give_money: '0', level_give_coupon: [], level_extend_info: [] });
      expect(current.profile_options).toHaveLength(6);
      expect(states).toEqual([{ isolation: 'repeatable read', read_only: 'on', statement: 5000, lock: 2000, idle: 5000 }]);
      await expect(app.exec("UPDATE system_config SET value='1' WHERE menu_name='member_func_status'")).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot()).toEqual(before); expect(cacheDeletes).not.toHaveBeenCalled();
    });
  }, 120000);

  it('saves all nine keys under Admin LOGIN and consumes profile, points, whole-yuan money and finite/unlimited/future-start coupons under App LOGIN once', async () => {
    await commissioned(async (_admin, app, service) => {
      const current = await service.get();
      const fields = ['real_name', 'sex', 'birthday'].map(param => {
        const option = current.profile_options.find(row => row.definition?.param === param);
        if (!option) throw Error(`Missing standard profile ${param}`);
        return { field_key: option.field_key, required: 1 as const };
      });
      const input = await body(service, { level_extend_info: fields, level_give_coupon: [finite, unlimited, fixed] });
      const result = await service.save(input, actor);
      expect(result).toMatchObject({ committed: true, request_id: input.request_id, cache_status: 'cleared' });
      const saved = await service.get(); expect(saved.revision).toBe(result.revision);
      expect(saved.settings).toEqual(Object.fromEntries(LEVEL_ACTIVATION_KEYS.map(key => [key, input[key]])));
      const consumer = consumerFor(app.db);
      const profileValues = [
        { info: '姓名', param: 'real_name', value: '张三' }, { info: '性别', param: 'sex', value: '1' },
        { info: '生日', param: 'birthday', value: '2000-02-29' },
      ];
      const gift = await consumer.activateLevel(uid, profileValues);
      expect(gift).toMatchObject({ level_give_integral: 7, level_give_money: 3 });
      expect(gift.level_give_coupon.map(row => row.id)).toEqual([finite, unlimited, fixed]);
      expect((await f.db.select().from(user).where(eq(user.uid, uid)))[0]).toMatchObject({ integral: 17, nowMoney: '4.25',
        levelStatus: 1, realName: '张三', sex: 2, birthday: Math.floor(Date.UTC(2000, 1, 29) / 1000) - 28800 });
      expect(await f.db.select().from(userBill).where(eq(userBill.uid, uid))).toHaveLength(1);
      expect(await f.db.select().from(userMoney).where(eq(userMoney.uid, uid))).toHaveLength(1);
      expect(await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.uid, uid))).toHaveLength(3);
      expect(await f.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.uid, uid))).toHaveLength(3);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, finite)))[0].remainCount).toBe(2);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, unlimited)))[0].remainCount).toBe(0);
      const after = await snapshot(); await expect(consumer.activateLevel(uid, profileValues)).rejects.toThrow('重复激活');
      expect(await snapshot()).toEqual(after);
    });
  }, 120000);

  it('updates only each global winner and preserves losers, store rows, metadata and non-domain configuration', async () => {
    await f.db.insert(systemConfig).values([
      { menuName: 'level_give_money', value: '8', sort: 3, isStore: 0, info: 'winner', status: 0 },
      { menuName: 'level_give_money', value: '99', sort: 2, isStore: 0, info: 'loser' },
      { menuName: 'level_give_money', value: '91', sort: 100, isStore: 1, info: 'store' },
      { menuName: 'level_audit_unrelated', value: 'unchanged', info: 'outside nine keys' },
    ]);
    await commissioned(async (_admin, _app, service) => {
      const rows = await f.db.select().from(systemConfig).orderBy(systemConfig.id);
      const winner = rows.find(row => row.info === 'winner'); if (!winner) throw Error('Missing winner');
      await service.save(await body(service), actor);
      const after = await f.db.select().from(systemConfig).orderBy(systemConfig.id);
      for (const row of rows) {
        const actual = after.find(value => value.id === row.id);
        if (row.id === winner.id) expect(actual).toEqual({ ...row, value: '3' });
        else if (!LEVEL_ACTIVATION_KEYS.includes(row.menuName as typeof LEVEL_ACTIVATION_KEYS[number]) || row.menuName === 'level_give_money') expect(actual).toEqual(row);
      }
      expect((await service.get()).settings.level_give_money).toBe('3');
    });
  }, 120000);

  it('replays the same actor and UUID without writes while refusing payload conflicts and stale configuration or source-template revisions', async () => {
    await commissioned(async (_admin, _app, service) => {
      const input = await body(service), result = await service.save(input, actor), after = await snapshot();
      expect(await service.save(input, actor)).toEqual(result); expect(await snapshot()).toEqual(after);
      await expect(service.save({ ...input, level_give_integral: 9 }, actor)).rejects.toThrow('请求标识');
      await expect(service.save({ ...input, request_id: crypto.randomUUID() }, actor)).rejects.toThrow('已变化');
      const stale = await body(service);
      await f.db.insert(systemConfig).values({ menuName: 'user_extend_info', value: '[]', sort: 100 });
      const modified = await snapshot();
      await expect(service.save(stale, actor)).rejects.toThrow('已变化');
      expect(await snapshot()).toEqual(modified); expect(await receipts()).toHaveLength(1);
    });
  }, 120000);

  it('preserves an already selected safe field when the basic source later becomes ambiguous without enabling a new duplicate', async () => {
    await commissioned(async (_admin, _app, service) => {
      const original = (await service.get()).profile_options.find(option => option.definition?.param === 'real_name');
      if (!original?.definition) throw Error('Missing standard real-name definition');
      const selected = { field_key: original.field_key, required: 1 as const };
      await service.save(await body(service, { level_extend_info: [selected] }), actor);
      const alternative = { ...original.definition, tip: '不同提示仍是同名同映射的歧义来源' };
      for (const [index, definitions] of [[original.definition, original.definition], [original.definition, alternative]].entries()) {
        await f.db.insert(systemConfig).values({ menuName: 'user_extend_info', value: JSON.stringify(definitions), sort: 100 + index });
        const current = await service.get(), keys = current.profile_options.map(option => option.field_key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(current.settings.level_extend_info).toEqual([selected]);
        expect(current.profile_options.find(option => option.field_key === original.field_key))
          .toMatchObject({ source: 'selected_legacy', selectable: true });
        await service.save(await body(service, { level_extend_info: [selected] }), actor);
        const other = current.profile_options.find(option => option.field_key !== original.field_key);
        if (other) {
          expect(other.selectable).toBe(false);
          const invalid = await body(service, { level_extend_info: [selected, { field_key: other.field_key, required: 0 }] });
          const before = await snapshot(); await expect(service.save(invalid, actor)).rejects.toThrow('所选资料定义无效');
          expect(await snapshot()).toEqual(before);
        }
      }
      await service.save(await body(service, { level_extend_info: [] }), actor);
      expect((await service.get()).settings.level_extend_info).toEqual([]);
      const duplicated = JSON.stringify([{ ...original.definition, required: 0 }, { ...original.definition, required: 1 }]);
      await f.db.update(systemConfig).set({ value: duplicated }).where(eq(systemConfig.menuName, 'level_extend_info'));
      const before = await snapshot(), legacy = await service.get();
      expect(legacy.settings.level_extend_info).toBeNull();
      expect(legacy.raw_values.level_extend_info).toBe(duplicated);
      expect(legacy.issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'level_extend_info',
        message: expect.stringContaining('重复定义') })]));
      expect(new Set(legacy.profile_options.map(option => option.field_key)).size).toBe(legacy.profile_options.length);
      expect(await snapshot()).toEqual(before);
    });
  }, 120000);

  it('serializes different UUIDs from the same revision on the real configuration fence and accepts only one writer', async () => {
    await commissioned(async (admin, _app, service) => withCouponTemplatePeer(admin, async peer => {
      const firstBody = await body(service), secondBody = { ...firstBody, request_id: crypto.randomUUID(), level_give_integral: 9 };
      let release!: () => void, entered!: () => void, paused = false;
      const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
      const firstService = serviceFor(observeCouponTemplateDb(admin.db, async (tx, command) => {
        if (!paused && command === 'execute') {
          const [row] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
            AND relation='system_config'::regclass AND mode='ShareRowExclusiveLock' AND granted) AS locked`);
          if (row.locked === true) { paused = true; entered(); await gate; }
        }
      }));
      const first = outcome(firstService.save(firstBody, actor));
      await Promise.race([held, first.then(result => { throw Error(`Writer ended before lock barrier: ${JSON.stringify(result)}`); })]);
      const second = outcome(serviceFor(peer.db).save(secondBody, actor));
      try { await waitForFinanceBlock(f.db, peer.pid, admin.pid); } finally { release(); }
      expect((await first).ok).toBe(true); const other = await second;
      expect(other.ok).toBe(false); if (!other.ok) expect(String(other.error)).toContain('已变化');
      expect(await receipts()).toHaveLength(1); expect((await service.get()).settings.level_give_integral).toBe(7);
    }));
  }, 120000);

  it('rolls back all nine writes on a real late audit primary-key failure and performs no cache invalidation', async () => {
    await commissioned(async (_admin, _app, service) => {
      const input = await body(service);
      const [probe] = await f.db.insert(systemLog).values({ adminId: actor.id, type: 'level_config_fixture', path: '/local-only', action: 'existing audit identity' }).returning();
      await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('system_log','id'),${probe.id},false)`);
      const before = await snapshot();
      await expect(service.save(input, actor)).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(await snapshot()).toEqual(before); expect(cacheDeletes).not.toHaveBeenCalled();
    });
  }, 120000);

  it('reports committed cache failure, attempts all nine keys, and retries only invalidation when explicitly replayed', async () => {
    await commissioned(async (_admin, _app, service) => {
      cacheDeletes.mockImplementation(async key => { if (key === 'cfg_level_give_money') throw Error('Synthetic cache unavailable'); });
      const input = await body(service), result = await service.save(input, actor);
      expect(result).toMatchObject({ committed: true, cache_status: 'pending' });
      expect(cacheDeletes.mock.calls.map(([key]) => key).sort()).toEqual(LEVEL_ACTIVATION_KEYS.map(key => `cfg_${key}`).sort());
      expect((await service.get()).revision).toBe(result.revision); const after = await snapshot();
      cacheDeletes.mockClear(); cacheDeletes.mockResolvedValue(undefined);
      expect(await service.save(input, actor)).toEqual({ ...result, cache_status: 'cleared' });
      expect(cacheDeletes).toHaveBeenCalledTimes(9); expect(await snapshot()).toEqual(after);
    });
  }, 120000);

  it('refuses unavailable gifted options and negative days on enabling while preserving existing invalid IDs during removal or unrelated edits', async () => {
    await f.db.insert(storeCouponIssue).values([
      { id: 78101, title: '负有效日', day: -1, receiveType: 3, remainCount: 3, useEndTime: new Date(Date.now() + 86400000) },
      { id: 78102, title: '已关闭', day: 7, receiveType: 3, remainCount: 3, status: 0 },
      { id: 78103, title: '有限零库存', day: 7, receiveType: 3, remainCount: 0 },
      { id: 78104, title: '非赠送', day: 7, receiveType: 1, remainCount: 3 },
    ]);
    await commissioned(async (_admin, _app, service) => {
      expect((await service.coupons(new URLSearchParams('limit=100'))).list.map(row => row.id).sort()).toEqual([finite, unlimited, fixed]);
      await service.save(await body(service), actor);
      await f.db.update(systemConfig).set({ value: '[78101,78102]' }).where(eq(systemConfig.menuName, 'level_give_coupon'));
      // Still enabled: retain one unchanged invalid identity, remove another,
      // and add a currently selectable source without silently dropping either.
      const keep = await body(service, { level_give_coupon: [finite, 78102] });
      await service.save(keep, actor);
      expect((await service.get()).settings.level_give_coupon).toEqual([finite, 78102]);
      await service.save(await body(service, { level_coupon_status: 0, level_give_coupon: [finite, 78102] }), actor);
      const before = await snapshot();
      await expect(service.save(await body(service, { level_give_coupon: [finite, 78102] }), actor)).rejects.toThrow('当前不能');
      expect(await snapshot()).toEqual(before);
      for (const id of [78101, 78103, 78104]) {
        await f.db.update(systemConfig).set({ value: JSON.stringify([id]) }).where(eq(systemConfig.menuName, 'level_give_coupon'));
        const baseline = await snapshot();
        await expect(service.save(await body(service, { level_give_coupon: [id] }), actor)).rejects.toThrow('当前不能');
        expect(await snapshot()).toEqual(baseline);
      }
    });
  }, 120000);

  it('rechecks the coupon after its actual row-lock wait and never emits ownership or claim evidence for a newly negative day', async () => {
    await commissioned(async (_admin, app, service) => {
      await service.save(await body(service, { level_give_coupon: [finite] }), actor);
      await f.withPeer!(async maintenance => {
        await maintenance.exec('BEGIN');
        await maintenance.db.execute(sql`SELECT id FROM store_coupon_issue WHERE id=${finite} FOR UPDATE`);
        const activation = outcome(consumerFor(app.db).activateLevel(uid, []));
        try {
          await waitForFinanceBlock(f.db, app.pid, maintenance.pid);
          await maintenance.db.update(storeCouponIssue).set({ day: -1, useEndTime: new Date(Date.now() + 86400000) }).where(eq(storeCouponIssue.id, finite));
        } finally { await maintenance.exec('COMMIT'); }
        const result = await activation; expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.level_give_coupon).toEqual([]);
      });
      expect(await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.uid, uid))).toEqual([]);
      expect(await f.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.uid, uid))).toEqual([]);
      expect((await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, finite)))[0].remainCount).toBe(3);
      expect((await f.db.select().from(user).where(eq(user.uid, uid)))[0]).toMatchObject({ levelStatus: 1, integral: 17, nowMoney: '4.25' });
    });
  }, 120000);

  it('rolls back activation profile, balances, points, coupon stock and evidence on a real late owned-coupon insert failure', async () => {
    await commissioned(async (_admin, app, service) => {
      await service.save(await body(service, { level_give_coupon: [finite] }), actor);
      const [probe] = await f.db.insert(storeCouponUser).values({ uid: 0, issueCouponId: finite, couponTitle: '既有领取标识' }).returning();
      await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('store_coupon_user','id'),${probe.id},false)`);
      const before = await snapshot();
      await expect(consumerFor(app.db).activateLevel(uid, [])).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(await snapshot()).toEqual(before);
      expect((await service.get()).settings.level_give_coupon).toEqual([finite]);
    });
  }, 120000);
});
