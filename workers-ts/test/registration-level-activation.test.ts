import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import type { Env } from '../src/env';
import { LoginService } from '../src/services/user/LoginService';
import { WechatAuthService, type SocialUserType } from '../src/services/wechat/WechatAuthService';
import { OutUserService } from '../src/services/out/OutUserService';
import { readRegistrationLevelStatus } from '../src/services/user/RegistrationLevelActivation';
import { setTokenBucket } from '../src/utils/cache';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { communityUser, outUserWriteReplay, storeCouponIssue, storeCouponIssueUser,
  storeCouponUser, systemConfig, systemUserLevel, user, userBill, userLabelRelation,
  userLevel, userMoney, wechatUser } from '../src/models/schema';

// Only the external bearer store is replaced. Identity inputs below are already
// verified test identities; provider/SMS verification and HTTP auth are NOT tested.
vi.mock('../src/utils/cache', async (original) => ({
  ...await original<typeof import('../src/utils/cache')>(),
  setTokenBucket: vi.fn(async () => true),
}));

const phone = '13910000001';
const openid = 'registration-level-fixture';
const outAccount = { id: 1, appid: 'fixture', title: 'Fixture only', rules: [] };
const outKey = '71efb2f8-07ce-4a18-9035-c204af955f47';
const flows = ['password', 'mobile', 'wechat', 'routine', 'apple', 'pc', 'social-phone', 'out'] as const;
type Flow = typeof flows[number];

describe('new accounts initialize level activation from current SQL policy', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const kv = new Map<string, string>();
  const get = vi.fn(async (key: string): Promise<string | null> => kv.get(key) ?? '0');
  // Deliberately cached gift/settings flags; membership switches in this map
  // must never be consulted when deciding the new account's level_status.
  const env = {
    APP_KEY: 'local-registration-test-only',
    UPSTASH_REDIS_URL: 'https://unused.invalid', UPSTASH_REDIS_TOKEN: 'unused',
    CONFIG_KV: {
      get: (key: string) => get(key),
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    },
  } as Env;

  beforeAll(async () => {
    f = await financePostgres([user, systemConfig, wechatUser, systemUserLevel,
      userLevel, communityUser, outUserWriteReplay, userLabelRelation,
      userBill, userMoney, storeCouponIssue, storeCouponUser, storeCouponIssueUser]);
    await f.exec('CREATE UNIQUE INDEX fixture_openid_uq ON wechat_user (openid)');
    await f.exec(`CREATE UNIQUE INDEX fixture_phone_uq ON "user" (phone) WHERE phone <> '' AND is_del = 0`);
  }, 60_000);
  afterAll(async () => { await f?.close(); }, 60_000);
  beforeEach(async () => {
    await f.reset(); kv.clear(); vi.clearAllMocks();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'member_func_status', value: '1' },
      { id: 2, menuName: 'level_activate_status', value: '0' },
    ]);
  });

  async function policy(member: string, required: string) {
    await f.db.update(systemConfig).set({ value: member }).where(eq(systemConfig.id, 1));
    await f.db.update(systemConfig).set({ value: required }).where(eq(systemConfig.id, 2));
  }
  async function account(uid: number) {
    const [row] = await f.db.select().from(user).where(eq(user.uid, uid));
    expect(row).toBeDefined();
    return row;
  }
  async function create(flow: Flow, db = f.db): Promise<number> {
    const container = createContainerFromDb(db);
    if (flow === 'out') {
      return (await new OutUserService(container, env).create(outAccount, { phone }, outKey)).uid;
    }
    if (flow !== 'password' && flow !== 'mobile') {
      return new WechatAuthService(container, env).reconcileVerifiedIdentity({
        openid, userType: flow === 'social-phone' ? 'wechat' : flow as SocialUserType,
        ...(flow === 'social-phone' ? { phone } : {}),
      });
    }
    const login = new LoginService(container, env);
    const token = flow === 'password'
      ? await login.register(phone, 'Registration-fixture-pass', 0)
      : await login.loginByMobile(phone, 0, '127.0.0.1');
    expect(token.token).toBeTruthy();
    const [row] = await db.select({ uid: user.uid }).from(user).where(eq(user.phone, phone));
    expect(row).toBeDefined();
    return row.uid;
  }
  function gifts() {
    for (const [key, value] of Object.entries({ newcomer_status: '1',
      register_integral_status: '1', register_give_integral: '7',
      register_money_status: '1', register_give_money: '3',
      register_coupon_status: '1', register_give_coupon: '[1]' })) kv.set(`cfg_${key}`, value);
  }
  async function coupon() {
    await f.db.insert(storeCouponIssue).values({ id: 1, title: 'Fixture coupon',
      status: 1, remainCount: 20, totalCount: 20, day: 7, couponPrice: '2.00' });
  }
  async function noGiftWrites() {
    for (const table of [userBill, userMoney, storeCouponUser, storeCouponIssueUser]) {
      expect(await f.db.select().from(table)).toHaveLength(0);
    }
  }

  for (const flow of flows) {
    it.each([
      ['1', '0', 1], ['1', '1', 0], ['0', '0', 0], ['0', '1', 0],
    ])(`${flow}: member=%s, manual activation=%s -> %s, even without newcomer gifts`, async (member, required, expected) => {
      await policy(String(member), String(required));
      kv.set('cfg_member_func_status', member === '1' ? '0' : '1');
      kv.set('cfg_level_activate_status', required === '1' ? '0' : '1');
      const row = await account(await create(flow));
      expect(row).toMatchObject({ level: 0, levelStatus: expected, isNewcomer: -1,
        isFirstOrder: -1, integral: 0, nowMoney: '0.00', isMoneyLevel: 0 });
      expect(get.mock.calls.flat()).not.toContain('cfg_member_func_status');
      expect(get.mock.calls.flat()).not.toContain('cfg_level_activate_status');
      await noGiftWrites();
    });
  }

  it.each([
    ['"1"', '"0"', 1], ['true', 'false', 1], ['', '0', 0], ['1', '', 1],
  ])('uses the existing manual-activation scalar semantics for %s/%s', async (member, required, expected) => {
    await policy(String(member), String(required));
    expect((await account(await create('password'))).levelStatus).toBe(expected);
  });
  it('missing member configuration keeps registration inactive', async () => {
    await f.db.delete(systemConfig);
    expect((await account(await create('password'))).levelStatus).toBe(0);
  });
  it('missing activation-required switch defaults to automatic when membership is enabled', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2));
    expect((await account(await create('password'))).levelStatus).toBe(1);
  });
  it('honors global sort/id precedence including invisible fields and ignores store overrides', async () => {
    await policy('0', '1');
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'member_func_status', value: '1', sort: 10, status: 0 },
      { id: 4, menuName: 'member_func_status', value: '0', sort: 9 },
      { id: 5, menuName: 'level_activate_status', value: '0', status: 0 },
      { id: 6, menuName: 'member_func_status', value: '0', sort: 999, isStore: 1 },
      { id: 7, menuName: 'level_activate_status', value: '1', sort: 999, isStore: 1 },
    ]);
    expect((await account(await create('password'))).levelStatus).toBe(1);
  });

  it.each(['password', 'mobile', 'wechat', 'out'] as const)('%s commits activation with exactly one set of gifts', async (flow) => {
    gifts(); await coupon();
    const uid = await create(flow);
    expect(await account(uid)).toMatchObject({ levelStatus: 1, integral: 7, nowMoney: '3.00' });
    for (const table of [userBill, userMoney, storeCouponUser, storeCouponIssueUser]) {
      expect(await f.db.select().from(table)).toHaveLength(1);
    }
    expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(19);
    if (flow === 'password') await expect(create(flow)).rejects.toThrow('该手机号已注册');
    else expect(await create(flow)).toBe(uid);
    expect(await f.db.select().from(user)).toHaveLength(1);
    expect(await f.db.select().from(userBill)).toHaveLength(1);
    expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(19);
  });
  it.each(['password', 'mobile', 'wechat', 'out'] as const)('%s rolls back account/activation/gifts on late coupon evidence failure', async (flow) => {
    gifts(); await coupon();
    await f.exec('ALTER TABLE store_coupon_issue_user ADD CONSTRAINT fixture_reject_evidence CHECK (uid < 0)');
    try {
      await expect(create(flow)).rejects.toThrow();
      expect(await f.db.select().from(user)).toHaveLength(0);
      expect(await f.db.select().from(wechatUser)).toHaveLength(0);
      expect(await f.db.select().from(communityUser)).toHaveLength(0);
      expect(await f.db.select().from(outUserWriteReplay)).toHaveLength(0);
      await noGiftWrites();
      expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(20);
      expect(setTokenBucket).not.toHaveBeenCalled();
    } finally {
      await f.exec('ALTER TABLE store_coupon_issue_user DROP CONSTRAINT fixture_reject_evidence');
    }
    expect((await account(await create(flow))).levelStatus).toBe(1);
  });

  it('SQL policy failure cannot create an account using stale KV', async () => {
    kv.set('cfg_member_func_status', '1'); kv.set('cfg_level_activate_status', '0');
    await f.exec('ALTER TABLE system_config RENAME TO fixture_hidden_config');
    try {
      await expect(create('password')).rejects.toThrow();
      expect(await f.db.select().from(user)).toHaveLength(0);
      expect(setTokenBucket).not.toHaveBeenCalled();
    } finally { await f.exec('ALTER TABLE fixture_hidden_config RENAME TO system_config'); }
  });
  it.each(['mobile', 'wechat', 'social-phone', 'out'] as const)('%s login/replay never reactivates an existing disabled account', async (flow) => {
    const uid = await create(flow);
    await f.db.update(user).set({ levelStatus: 0 }).where(eq(user.uid, uid));
    expect(await create(flow)).toBe(uid);
    expect((await account(uid)).levelStatus).toBe(0);
    await noGiftWrites();
  });
  it('password/verified-UID login and social binding to an existing phone leave activation unchanged', async () => {
    await policy('1', '1');
    const uid = await create('password');
    await policy('1', '0');
    const login = new LoginService(createContainerFromDb(f.db), env);
    await login.loginByPassword(phone, 'Registration-fixture-pass', 0, '127.0.0.1');
    await login.loginByVerifiedUid(uid);
    expect(await create('social-phone')).toBe(uid);
    expect((await account(uid)).levelStatus).toBe(0);
    expect(await f.db.select().from(user)).toHaveLength(1);
  });
  it('Out explicit level assignment remains activated even when automatic activation is off', async () => {
    await policy('0', '1');
    await f.db.insert(systemUserLevel).values({ id: 1, name: 'Assigned', discount: '80' });
    const result = await new OutUserService(createContainerFromDb(f.db), env)
      .create(outAccount, { phone, level: 1 }, outKey);
    expect(await account(result.uid)).toMatchObject({ level: 1, levelStatus: 1 });
    expect(await f.db.select().from(userLevel)).toHaveLength(1);
  });
  it('reads both switches with one bounded SQL query and no cache calls', async () => {
    const select = vi.spyOn(f.db, 'select');
    try {
      expect(await readRegistrationLevelStatus(f.db)).toBe(1);
      expect(select).toHaveBeenCalledTimes(1);
      expect(get).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
  });
  it('automatic activation never grants manual-activation rewards', async () => {
    let configId = 10;
    for (const [key, value] of Object.entries({ level_integral_status: '1', level_give_integral: '99',
      level_money_status: '1', level_give_money: '99', level_coupon_status: '1', level_give_coupon: '[1]' })) {
      kv.set(`cfg_${key}`, value);
      await f.db.insert(systemConfig).values({ id: configId++, menuName: key, value });
    }
    await coupon();
    expect(await account(await create('password'))).toMatchObject({ levelStatus: 1, integral: 0, nowMoney: '0.00' });
    await noGiftWrites();
    expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(20);
  });
  it('newcomer rewards do not require automatic level activation', async () => {
    await policy('1', '1'); gifts(); await coupon();
    expect(await account(await create('password'))).toMatchObject({ levelStatus: 0, integral: 7, nowMoney: '3.00' });
    expect(await f.db.select().from(userBill)).toHaveLength(1);
    expect(await f.db.select().from(userMoney)).toHaveLength(1);
    expect(await f.db.select().from(storeCouponIssueUser)).toHaveLength(1);
  });
  it.each(['wechat', 'out'] as const)('%s rolls back activation and gifts when its final identity/replay write fails', async (flow) => {
    gifts(); await coupon();
    const table = flow === 'wechat' ? 'wechat_user' : 'out_user_write_replay';
    const field = flow === 'wechat' ? 'uid' : 'user_id';
    await f.exec(`ALTER TABLE ${table} ADD CONSTRAINT fixture_reject_tail CHECK (${field} < 0)`);
    try {
      await expect(create(flow)).rejects.toThrow();
      expect(await f.db.select().from(user)).toHaveLength(0);
      expect(await f.db.select().from(wechatUser)).toHaveLength(0);
      expect(await f.db.select().from(communityUser)).toHaveLength(0);
      expect(await f.db.select().from(outUserWriteReplay)).toHaveLength(0);
      await noGiftWrites();
      expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(20);
    } finally { await f.exec(`ALTER TABLE ${table} DROP CONSTRAINT fixture_reject_tail`); }
  });

  const postgresIt = process.env.TEST_FINANCE_POSTGRES_URL ? it : it.skip;
  for (const flow of ['password', 'mobile', 'wechat', 'out'] as const) {
    postgresIt.each([0, 1])(`${flow} reads policy after an independently observed identity-lock wait (manual=%s)`, async (required) => {
      await policy('1', String(1 - required));
      await withFinancePeers(f.db, async ([blocker, writer]) => {
        await blocker.exec('BEGIN');
        const lock = flow === 'out' ? sql`SELECT pg_advisory_xact_lock(744240001, 1)`
          : sql`SELECT pg_advisory_xact_lock(hashtext(${flow === 'wechat' ? `social-openid:${openid}` : `user-phone:${phone}`}))`;
        await blocker.db.execute(lock);
        const pending = outcome(create(flow, writer.db));
        try {
          await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
          await policy('1', String(required));
        } finally { await blocker.exec('COMMIT'); }
        const result = await pending;
        if (!result.ok) throw result.error;
        expect((await account(result.value)).levelStatus).toBe(1 - required);
      });
    });
    postgresIt(`${flow} concurrent duplicate creation awards activation and gifts once`, async () => {
      gifts(); await coupon();
      await withFinancePeers(f.db, async ([first, second]) => {
        const results = await Promise.all([outcome(create(flow, first.db)), outcome(create(flow, second.db))]);
        expect(results.filter(result => result.ok)).toHaveLength(flow === 'password' ? 1 : 2);
        if (flow === 'password') {
          const rejected = results.find(result => !result.ok);
          expect(rejected && !rejected.ok && String(rejected.error)).toContain('该手机号已注册');
        } else {
          expect(results[0].ok && results[0].value).toBe(results[1].ok && results[1].value);
        }
        const rows = await f.db.select().from(user);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ levelStatus: 1, integral: 7, nowMoney: '3.00' });
        expect(await f.db.select().from(userBill)).toHaveLength(1);
        expect(await f.db.select().from(userMoney)).toHaveLength(1);
        expect(await f.db.select().from(storeCouponIssueUser)).toHaveLength(1);
        expect((await f.db.select().from(storeCouponIssue))[0].remainCount).toBe(19);
      });
    });
  }
});
