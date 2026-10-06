import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { systemConfig, systemLog } from '../src/models/schema';
import { AdminPaidMembershipConfigService } from '../src/services/admin/AdminPaidMembershipConfigService';
import { parseAdminPaidMembershipConfigInput, readAdminPaidMembershipConfigBody } from '../src/services/admin/AdminPaidMembershipConfigInput';
import { financePostgres } from './helpers/financePostgres';

const valid = () => ({ member_card_status: 1, svip_price_status: 0, revision: 'a'.repeat(64), request_id: crypto.randomUUID() });
describe('paid membership two-key strict input', () => {
  it.each(['1', '0', true, null, -1, 2, 0.5, NaN])('rejects non-bit input %s for either key', value => {
    for (const key of ['member_card_status', 'svip_price_status']) expect(() => parseAdminPaidMembershipConfigInput({ ...valid(), [key]: value })).toThrow();
  });
  it('requires both switches, UUID and revision and rejects adjacent configuration domains', () => {
    const input = valid(); expect(parseAdminPaidMembershipConfigInput(input)).toEqual(input);
    for (const key of ['member_card_status', 'svip_price_status', 'revision', 'request_id']) {
      const partial: Record<string, unknown> = { ...input }; delete partial[key];
      expect(() => parseAdminPaidMembershipConfigInput(partial)).toThrow();
    }
    for (const key of ['member_func_status', 'level_activate_status', 'member_right', 'now_money', 'order_give_exp'])
      expect(() => parseAdminPaidMembershipConfigInput({ ...input, [key]: 1 })).toThrow('不支持');
    expect(() => parseAdminPaidMembershipConfigInput({ ...input, request_id: 'invalid' })).toThrow();
  });
  it('rejects escaped duplicate JSON keys, malformed JSON and oversized UTF-8 bodies', async () => {
    const request = (body: string) => new Request('https://local/config', { method: 'POST', body });
    await expect(readAdminPaidMembershipConfigBody(request('{"member_card_status":1,"member_card_\\u0073tatus":0}'))).rejects.toThrow('不能重复');
    await expect(readAdminPaidMembershipConfigBody(request('{broken}'))).rejects.toThrow('JSON');
    await expect(readAdminPaidMembershipConfigBody(request(JSON.stringify({ padding: '中'.repeat(23000) })))).rejects.toThrow('64 KiB');
    expect(await readAdminPaidMembershipConfigBody(request(JSON.stringify(valid())))).toHaveProperty('member_card_status', 1);
  });
});

describe('paid membership configuration on actual SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminPaidMembershipConfigService;
  const deleted = vi.fn(async (_key: string): Promise<void> => {});
  beforeEach(async () => {
    f = await financePostgres([systemConfig, systemLog]); deleted.mockReset(); deleted.mockResolvedValue(undefined);
    service = new AdminPaidMembershipConfigService(createContainerFromDb(f.db), { CONFIG_KV: {
      get: async () => { throw Error('Admin must not read KV'); }, put: async () => { throw Error('Admin must not populate KV'); }, delete: deleted,
    } });
  }, 30000);
  afterEach(async () => { await f?.close(); });
  const snapshot = async () => ({ config: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
  const body = async () => ({ ...valid(), revision: (await service.get()).revision });

  it('keeps missing/empty/quoted/malformed values explicit and never creates defaults on GET', async () => {
    const empty = await service.get();
    expect(empty.settings).toEqual({ member_card_status: null, svip_price_status: null });
    expect(empty.missing_keys).toEqual(['member_card_status', 'svip_price_status']);
    expect(empty.issues).toHaveLength(2); expect(await snapshot()).toEqual({ config: [], logs: [] });
    for (const raw of ['', ' ', '"1"', 'on', '2', 'broken']) {
      await f.db.delete(systemConfig);
      await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value: raw });
      const before = await snapshot(), result = await service.get();
      expect(result.settings.member_card_status).toBeNull(); expect(result.raw_values.member_card_status).toBe(raw);
      expect(result.missing_keys).toEqual(['svip_price_status']);
      expect(result.issues[0].message).toContain(raw.trim() === '' ? '已存配置为空' : '历史值不是规范');
      expect(await snapshot()).toEqual(before);
    }
    expect(deleted).not.toHaveBeenCalled();
  });
  it('updates only the hidden global winner, preserves all metadata/losers/stores and inserts the missing second key', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'member_card_status', value: '0', sort: 8, status: 1, type: 'legacy' },
      { id: 101, menuName: 'member_card_status', value: '0', sort: 8, status: 0, type: 'hidden-winner', info: 'keep' },
      { id: 102, menuName: 'member_card_status', value: '0', sort: 999, isStore: 1 },
      { id: 103, menuName: 'member_func_status', value: '1', sort: 99 },
    ]);
    const before = await snapshot(), input = await body(), result = await service.save(input, { id: 7 });
    const after = await snapshot();
    for (const row of before.config) expect(after.config.find(actual => actual.id === row.id)).toEqual(row.id === 101 ? { ...row, value: '1' } : row);
    expect(after.config.filter(row => row.menuName === 'svip_price_status')).toMatchObject([{ value: '0', isStore: 0 }]);
    expect(after.logs).toHaveLength(1); expect(after.logs[0]).toMatchObject({ adminId: 7, type: 'paid_membership_config', method: 'POST' });
    expect(after.logs[0].action.length).toBe(203);
    expect((await service.get()).revision).toBe(result.revision);
    expect(deleted.mock.calls.map(([key]) => key)).toEqual(['cfg_member_card_status', 'cfg_svip_price_status']);
  });
  it('replays a committed UUID before the old revision, binds actor/payload and detects same-value saves and ABA', async () => {
    const first = await body(), receipt = await service.save(first, { id: 7 }), after = await snapshot();
    expect(await service.save(first, { id: 7 })).toEqual(receipt); expect(await snapshot()).toEqual(after);
    await expect(service.save({ ...first, svip_price_status: 1 }, { id: 7 })).rejects.toThrow('请求标识');
    await expect(service.save(first, { id: 8 })).rejects.toThrow('已变化');
    const second = await body(), secondReceipt = await service.save(second, { id: 7 });
    expect(secondReceipt.revision).not.toBe(receipt.revision);
    await expect(service.save({ ...second, request_id: crypto.randomUUID() }, { id: 7 })).rejects.toThrow('已变化');
    await service.save({ ...await body(), member_card_status: 0 }, { id: 7 });
    await service.save(await body(), { id: 7 });
    expect((await service.get()).revision).not.toBe(secondReceipt.revision);
    const latest = await snapshot(); expect(await service.save(first, { id: 7 })).toEqual(receipt);
    expect(await snapshot()).toEqual(latest);
  });
  it('rejects stale raw priority snapshots even when interpreted values are unchanged', async () => {
    await service.save(await body(), { id: 7 });
    const input = await body();
    await f.db.insert(systemConfig).values({ menuName: 'member_card_status', value: '1', sort: 1, status: 0 });
    const before = await snapshot();
    await expect(service.save(input, { id: 7 })).rejects.toThrow('已变化'); expect(await snapshot()).toEqual(before);
  });
  it('rolls back both writes on a late audit SQL error and does not delete caches', async () => {
    await f.exec("ALTER TABLE system_log ADD CONSTRAINT paid_config_fixture_failure CHECK(type <> 'paid_membership_config')");
    const input = await body(), before = await snapshot();
    await expect(service.save(input, { id: 7 })).rejects.toThrow();
    expect(await snapshot()).toEqual(before); expect(deleted).not.toHaveBeenCalled();
  });
  it('keeps committed SQL with pending cache status and retries only cache deletion on an exact replay', async () => {
    deleted.mockImplementation(async key => { if (key === 'cfg_member_card_status') throw Error('Synthetic KV failure'); });
    const input = await body(), receipt = await service.save(input, { id: 7 });
    expect(receipt.cache_status).toBe('pending'); expect(deleted).toHaveBeenCalledTimes(2);
    expect((await service.get()).revision).toBe(receipt.revision); const before = await snapshot();
    deleted.mockReset(); deleted.mockResolvedValue(undefined);
    expect(await service.save(input, { id: 7 })).toEqual({ ...receipt, cache_status: 'cleared' });
    expect(deleted).toHaveBeenCalledTimes(2); expect(await snapshot()).toEqual(before);
  });
  it('rejects malformed input and invalid actors before any writes', async () => {
    const before = await snapshot();
    await expect(service.save({ ...await body(), member_card_status: '1' }, { id: 7 })).rejects.toThrow();
    await expect(service.save(await body(), { id: 0 })).rejects.toThrow('管理员');
    expect(await snapshot()).toEqual(before);
    const count = await f.db.execute(sql`SELECT count(*)::integer AS count FROM system_log`); expect(count[0].count).toBe(0);
  });
});
