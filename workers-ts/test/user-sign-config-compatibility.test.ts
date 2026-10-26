import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import { createContainerFromDb } from '@/lib/di';
import { memberRight, systemConfig, systemSignReward, user, userBill, userSign } from '@/models/schema';
import { UserCenterService } from '@/services/user/UserCenterService';
import { UserSignCompatibilityService } from '@/services/user/UserSignCompatibilityService';
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from '@/migrations/userCenterCompatibility';
import { financePostgres } from './helpers/financePostgres';

const NOW = new Date('2026-10-25T04:00:00.000Z');
const tables = [user, systemConfig, systemSignReward, userSign, userBill, memberRight];
type ConfigRow = { menuName: string; value: string; isStore?: number };
type AliasCase = { name: string; rows: ConfigRow[]; status: number; points: number };
const row = (menuName: string, value: string, isStore = 0): ConfigRow => ({ menuName, value, isStore });
const cases: AliasCase[] = [
  { name: 'alias-only legacy configuration', rows: [row('sign_in_switch', '1'), row('sign_in_integral', '7')], status: 1, points: 7 },
  { name: 'explicit primary zero overrides nonzero aliases', rows: [row('sign_status', '0'), row('sign_in_switch', '1'), row('sign_give_point', '0'), row('sign_in_integral', '7')], status: 0, points: 0 },
  { name: 'nonzero primary values override conflicting aliases', rows: [row('sign_status', '1'), row('sign_in_switch', '0'), row('sign_give_point', '4'), row('sign_in_integral', '9')], status: 1, points: 4 },
  { name: 'only missing point primary falls back', rows: [row('sign_status', '0'), row('sign_in_switch', '1'), row('sign_in_integral', '7')], status: 0, points: 7 },
  { name: 'only missing switch primary falls back', rows: [row('sign_in_switch', '1'), row('sign_give_point', '0'), row('sign_in_integral', '7')], status: 1, points: 0 },
  { name: 'absent primaries and aliases stay disabled with zero reward', rows: [], status: 0, points: 0 },
  { name: 'present empty primaries do not borrow aliases', rows: [row('sign_status', ''), row('sign_in_switch', '1'), row('sign_give_point', ''), row('sign_in_integral', '7')], status: 0, points: 0 },
  { name: 'present malformed primaries do not borrow aliases', rows: [row('sign_status', 'bad'), row('sign_in_switch', '1'), row('sign_give_point', '-1'), row('sign_in_integral', '7')], status: 0, points: 0 },
  { name: 'JSON-encoded alias scalars retain legacy normalization', rows: [row('sign_in_switch', '"1"'), row('sign_in_integral', '"7"')], status: 1, points: 7 },
  { name: 'explicit alias zeros remain zero', rows: [row('sign_in_switch', '0'), row('sign_in_integral', '0')], status: 0, points: 0 },
  { name: 'store primaries cannot suppress platform aliases', rows: [row('sign_status', '0', 1), row('sign_give_point', '999', 1), row('sign_in_switch', '1'), row('sign_in_integral', '7')], status: 1, points: 7 },
  { name: 'store aliases cannot enable absent platform configuration', rows: [row('sign_in_switch', '1', 1), row('sign_in_integral', '7', 1)], status: 0, points: 0 },
  { name: 'maximum bounded alias reward is retained', rows: [row('sign_in_switch', '1'), row('sign_in_integral', '1000000')], status: 1, points: 1_000_000 },
  { name: 'out-of-range alias reward keeps the existing zero fallback', rows: [row('sign_in_switch', '1'), row('sign_in_integral', '1000001')], status: 1, points: 0 },
];

// Real Drizzle/SQL on ordinary CI's PGlite or the explicitly owned native PG16.
// No configuration loader, reward calculation or returned row is stubbed.
describe('customer sign configuration alias compatibility', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => {
    f = await financePostgres(tables);
    const index = /CREATE UNIQUE INDEX IF NOT EXISTS "us_uid_shanghai_day_uq"[\s\S]*?;/.exec(USER_CENTER_COMPATIBILITY_INDEX_SQL)?.[0];
    if (!index) throw Error('Missing production Shanghai sign-day unique index');
    await f.exec(index);
  }, 30_000);
  afterAll(async () => { vi.useRealTimers(); await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.setSystemTime(NOW);
    await f.reset();
    await f.db.insert(user).values([
      { uid: 11, account: 'owned-sign-alias-11', nickname: '签到本人', status: 1, integral: 100, exp: '0.00', levelStatus: 0 },
      { uid: 22, account: 'owned-sign-alias-22', nickname: '其他用户', status: 1, integral: 200, exp: '0.00', levelStatus: 0 },
    ]);
    await settings([]);
  });
  async function settings(rows: ConfigRow[]) {
    if (rows.length) await f.db.insert(systemConfig).values(rows.map(value => ({ ...value, status: 1 })));
    await f.db.insert(systemConfig).values([
      row('sign_mode', '1'), row('sign_give_exp', '0'), row('member_func_status', '1'), row('member_card_status', '0'),
    ]);
  }
  async function snapshot() {
    const state: Record<string, unknown[]> = {};
    for (const table of tables) {
      const name = getTableName(table);
      const [result] = await f.db.execute<{ rows: unknown[] }>(sql`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`);
      state[name] = result.rows;
    }
    const sequences = await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);
    state.__sequences = await f.db.execute(sql.join(sequences.map(({ name }) => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return state;
  }
  it.each(cases)('$name is shared by status, config, month calendar and guest/member home widgets without writes', async example => {
    // Fixed defaults were installed once; case rows contain only the two key pairs.
    if (example.rows.length) await f.db.insert(systemConfig).values(example.rows.map(value => ({ ...value, status: 1 })));
    const container = createContainerFromDb(f.db), service = new UserSignCompatibilityService(container);
    const before = await snapshot();
    const status = await new UserCenterService(container).signStatus(11);
    const config = await service.config(11);
    const calendar = await service.calendar(11, '2026-10');
    const guest = await service.homeDiy(0), member = await service.homeDiy(11);
    expect(status).toEqual({ signedToday: false, continuousDays: 0, cumulativeDays: 0, integral: example.points, exp: 0, enabled: example.status !== 0 });
    expect(config.signStatus).toBe(example.status);
    expect(config.signData).toEqual({ sign_point: example.points, sign_exp: 0 });
    expect(config.signList).toHaveLength(7);
    expect(calendar.signList).toHaveLength(31);
    expect(calendar.today).toBe('2026-10-25');
    for (const item of [...config.signList, ...calendar.signList]) expect(item.point).toBe(example.points);
    for (const home of [guest, member]) {
      expect(home.signStatus).toBe(example.status);
      expect(home.sign_give_point).toBe(example.points);
      expect(home.signList).toHaveLength(1);
      expect(home.signList[0]).toHaveLength(7);
      expect(home.signList[0].every(item => item.point === example.points)).toBe(true);
    }
    expect(Object.keys(config).sort()).toEqual(['checkSign','continuousSignDays','cumulativeSignDays','nextContinuousDays','nextCumulativeDays','signData','signList','signMode','signRemindStatus','signRemindSwitch','signStatus'].sort());
    expect(Object.keys(calendar).sort()).toEqual(['today','w','signList','continuousSignDays','cumulativeSignDays','nextContinuousDays','nextCumulativeDays','checkSign'].sort());
    expect(Object.keys(guest).sort()).toEqual(['signList','nextContinuousSignRewardList','checkSign','signStatus','sign_give_point'].sort());
    expect(await snapshot()).toEqual(before);
  });

  // Native execution, not an emulated lock, proves actual write/status/display
  // agreement and unchanged same-day no-double-award behavior.
  describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native alias write consistency', () => {
    it('awards exactly the alias-only displayed points once and preserves the other account', async () => {
      await f.db.insert(systemConfig).values([row('sign_in_switch', '1'), row('sign_in_integral', '7')]);
      const container = createContainerFromDb(f.db), service = new UserSignCompatibilityService(container), writer = new UserCenterService(container);
      const other = await f.db.select().from(user).where(eq(user.uid, 22));
      expect((await writer.signStatus(11)).integral).toBe(7);
      expect((await service.config(11)).signData.sign_point).toBe(7);
      expect(await writer.sign(11)).toEqual({ point: 7, exp: 0, sign_point: 7, sign_exp: 0, continuousDays: 1, cumulativeDays: 1 });
      expect(await f.db.select({ uid: userSign.uid, point: userSign.number }).from(userSign)).toEqual([{ uid: 11, point: 7 }]);
      expect(await f.db.select({ uid: userBill.uid, number: userBill.number, category: userBill.category }).from(userBill)).toEqual([{ uid: 11, number: '7.00', category: 'integral' }]);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(107);
      expect(await f.db.select().from(user).where(eq(user.uid, 22))).toEqual(other);
      const after = await snapshot();
      expect((await writer.signStatus(11)).signedToday).toBe(true);
      expect((await service.config(11)).checkSign).toBe(true);
      expect((await service.calendar(11, '2026-10')).checkSign).toBe(true);
      await expect(writer.sign(11)).rejects.toThrow('今日已签到');
      expect(await snapshot()).toEqual(after);
    });
    it('preserves a valid zero-point primary reward instead of borrowing the alias at write time', async () => {
      await f.db.insert(systemConfig).values([row('sign_status', '1'), row('sign_give_point', '0'), row('sign_in_integral', '7')]);
      const container = createContainerFromDb(f.db), writer = new UserCenterService(container);
      expect((await new UserSignCompatibilityService(container).config(11)).signData.sign_point).toBe(0);
      expect((await writer.signStatus(11)).integral).toBe(0);
      expect(await writer.sign(11)).toMatchObject({ point: 0, exp: 0, sign_point: 0 });
      expect(await f.db.select({ uid: userSign.uid, point: userSign.number }).from(userSign)).toEqual([{ uid: 11, point: 0 }]);
      expect(await f.db.select().from(userBill)).toEqual([]);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
    });
    it('keeps an existing primary switch zero disabled despite an enabled alias and records no reward', async () => {
      await f.db.insert(systemConfig).values([row('sign_status', '0'), row('sign_in_switch', '1'), row('sign_in_integral', '7')]);
      const container = createContainerFromDb(f.db), before = await snapshot();
      expect((await new UserSignCompatibilityService(container).config(11)).signStatus).toBe(0);
      await expect(new UserCenterService(container).sign(11)).rejects.toThrow('签到功能未开启');
      expect(await snapshot()).toEqual(before);
    });
  });
});
