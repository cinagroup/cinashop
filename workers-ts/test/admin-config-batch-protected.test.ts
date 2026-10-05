import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { systemConfig, systemLog } from '../src/models/schema';
import { AdminConfigBatchService, normalizeAdminConfigBatch, readAdminConfigBatch } from '../src/services/system/AdminConfigBatchService';
import { financePostgres } from './helpers/financePostgres';

// Intentionally explicit contract list: additions/removals in the production
// domain constants must not silently change what this regression proves.
const protectedKeys = ['member_card_status', 'svip_price_status', 'member_func_status', 'level_activate_status',
  'level_extend_info', 'level_integral_status', 'level_give_integral', 'level_money_status', 'level_give_money',
  'level_coupon_status', 'level_give_coupon'] as const;

describe('generic configuration batch cannot replace controlled membership writers', () => {
  it.each(protectedKeys)('rejects %s alone or anywhere in a mixed batch', key => {
    for (const body of [{ [key]: '0' }, { whole_free_shipping: '1', [key]: '1', ordinary_key: 'value' },
      { [key]: 'legacy-invalid', whole_free_shipping: '1' }])
      expect(() => normalizeAdminConfigBatch(body)).toThrow('专用接口');
  });
  it('rejects escaped JSON aliases and points to the exact dedicated domain', async () => {
    const decoded = await readAdminConfigBatch(new Request('https://local/config/save', {
      method: 'POST', body: '{"whole_free_shipping":"1","member_card_\\u0073tatus":"1"}',
    }));
    expect(() => normalizeAdminConfigBatch(decoded)).toThrow('/config/paid-membership');
    expect(() => normalizeAdminConfigBatch({ level_give_integral: '10' })).toThrow('/config/level-activation');
  });
  it('retains exact-key scope, legacy string bounds and the hundred-key limit for other settings', () => {
    expect(normalizeAdminConfigBatch({ member_card_status_backup: '1', level_money_status_backup: '0',
      order_give_exp: '2', member_price_status: '1' })).toHaveLength(4);
    expect(normalizeAdminConfigBatch({ valid_unicode: '😀'.repeat(5000) })).toHaveLength(1);
    expect(() => normalizeAdminConfigBatch({ valid_unicode: 'a'.repeat(5001) })).toThrow('5000');
    expect(() => normalizeAdminConfigBatch({ ordinary: 1 })).toThrow('字符串');
    expect(() => normalizeAdminConfigBatch({ ' ordinary ': '1' })).toThrow('键名');
    expect(() => normalizeAdminConfigBatch(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`key${i}`, '0'])))).toThrow('100');
  });
});

describe('controlled batch rejection on actual SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const deleted = vi.fn(async (_key: string): Promise<void> => {});
  const environment = { CONFIG_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: deleted } };
  beforeEach(async () => {
    f = await financePostgres([systemConfig, systemLog]); vi.clearAllMocks();
    await f.db.insert(systemConfig).values([
      ...protectedKeys.map(menuName => ({ menuName, value: 'preserve-original' })),
      { menuName: 'whole_free_shipping', value: '0' },
    ]);
  }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const snapshot = async () => ({ configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
  it('rejects every mixed protected batch without entering a SQL transaction or touching KV', async () => {
    const service = new AdminConfigBatchService(createContainerFromDb(f.db), environment), before = await snapshot();
    const transaction = vi.spyOn(f.db, 'transaction');
    for (const key of protectedKeys)
      await expect(service.save({ whole_free_shipping: '1', [key]: '1', ordinary_new: 'value' })).rejects.toThrow('专用接口');
    expect(transaction).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
    for (const operation of Object.values(environment.CONFIG_KV)) expect(operation).not.toHaveBeenCalled();
  });
  it('still commits unrelated settings without altering controlled rows and invalidates only those keys', async () => {
    const before = await snapshot(), service = new AdminConfigBatchService(createContainerFromDb(f.db), environment);
    await service.save({ whole_free_shipping: '1', ordinary_new: 'value' });
    const after = await snapshot();
    for (const row of before.configs) expect(after.configs.find(next => next.id === row.id)).toEqual(
      row.menuName === 'whole_free_shipping' ? { ...row, value: '1' } : row);
    expect(after.configs).toContainEqual(expect.objectContaining({ menuName: 'ordinary_new', value: 'value' }));
    expect(after.logs).toEqual(before.logs); expect(deleted.mock.calls).toEqual([['cfg_whole_free_shipping'], ['cfg_ordinary_new']]);
  });
});
