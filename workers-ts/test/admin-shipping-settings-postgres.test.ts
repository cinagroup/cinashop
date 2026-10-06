import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemConfig, systemLog, systemStore } from '../src/models/schema';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { shippingSettingsCanonical, shippingSettingsHash } from '../src/services/admin/AdminShippingSettingsInput';
import { readCheckoutPickupPolicy, lockCheckoutPickupStore } from '../src/services/order/CheckoutPickupPolicy';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { shippingSaveInput, shippingSettingsFixture } from './helpers/shippingSettingsFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native complete legacy shipping-settings contract', () => {
  let f: Awaited<ReturnType<typeof shippingSettingsFixture>>;
  beforeEach(async () => { f = await shippingSettingsFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const actor = { id: 7 };
  const snapshot = async () => ({ config: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    stores: await f.db.select().from(systemStore).orderBy(systemStore.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
  async function input() { return shippingSaveInput((await f.serviceFor().get()).revision); }

  it('reads the newest nondeleted default including hidden rows; exposes no bank fields and makes no writes', async () => {
    const before = await snapshot(), page = await f.serviceFor().get();
    expect(page.settings).toEqual({ whole_free_shipping: 0, store_free_postage: '10000.00', offline_postage: 0, store_self_mention: 1 });
    expect(page.pickup).toMatchObject({ id: 2, name: '最新隐藏默认点', is_show: 0, is_store: 0, address_ids: [10, 11, 12, 13],
      address_labels: ['甲省', '乙市', '丙区', '丁街道'], day_time: ['08:00', '20:00'] });
    expect(JSON.stringify(page)).not.toContain('keep-bank-code'); expect(page.issues).toEqual([]);
    expect(await f.serviceFor().cities('0')).toMatchObject([{ value: 10, level: 1, has_children: true }, { value: 20, level: 1, has_children: true }]);
    expect(await f.serviceFor().cities('13')).toEqual([]);
    await expect(f.serviceFor().cities('999')).rejects.toThrow();
    expect(await snapshot()).toEqual(before); expect(f.cacheDeletes).toEqual([]);
  });
  it('atomically saves all four keys and only the winner/default row, retaining unrelated and financial properties', async () => {
    await f.db.insert(systemConfig).values({ menuName: 'whole_free_shipping', value: '0', sort: 100, status: 0 });
    const before = await snapshot(), body = await input(), receipt = await f.serviceFor().save(body, actor);
    expect(receipt).toEqual({ operation: 'save', request_id: body.request_id, payload_hash: await shippingSettingsHash(shippingSettingsCanonical(body).canonical) });
    const after = await snapshot(), winner = after.config.at(-1)!;
    expect(winner).toMatchObject({ menuName: 'whole_free_shipping', value: '1', sort: 100, status: 0 });
    expect(after.config.find(row => row.id === 1)).toEqual(before.config.find(row => row.id === 1));
    expect(after.config.find(row => row.id === 5)).toEqual(before.config.find(row => row.id === 5));
    expect(after.config.find(row => row.id === 6)).toEqual(before.config.find(row => row.id === 6));
    expect(after.stores[0]).toEqual(before.stores[0]); expect(after.stores[2]).toEqual(before.stores[2]);
    expect(after.stores[1]).toMatchObject({ id: 2, name: '城北提货点', address: '甲省乙市丙区丁街道', detailedAddress: '新路 1/2 号',
      dayTime: '22:00 - 06:00', dayStart: '22:00', dayEnd: '06:00', isShow: 1, isStore: 1,
      bankCode: 'keep-bank-code', image: '/keep-image.png', introduction: 'keep intro' });
    expect(after.logs).toHaveLength(1); expect(f.cacheDeletes.sort()).toEqual(['cfg_whole_free_shipping', 'cfg_store_free_postage', 'cfg_offline_postage', 'cfg_store_self_mention'].sort());
  });
  it('preserves the stored threshold when the switch is off and never erases or hides a pickup store on disable', async () => {
    const before = await snapshot(), body = { ...await input(), whole_free_shipping: 0, store_free_postage: '0.01', store_self_mention: 0, pickup: null };
    await f.serviceFor().save(body, actor);
    expect((await f.serviceFor().get()).settings).toMatchObject({ whole_free_shipping: 0, store_free_postage: '0.01', store_self_mention: 0 });
    expect((await snapshot()).stores).toEqual(before.stores);
  });
  it('keeps missing values diagnostic until explicit save creates four keys and exactly one default store', async () => {
    await f.db.delete(systemConfig); await f.db.delete(systemStore);
    const empty = await f.serviceFor().get();
    expect(empty.settings).toEqual({ whole_free_shipping: null, store_free_postage: null, offline_postage: null, store_self_mention: null });
    expect(empty.missing_keys).toHaveLength(4); expect(empty.pickup).toBeNull();
    expect(await f.db.select().from(systemConfig)).toEqual([]);
    const body = shippingSaveInput(empty.revision); await f.serviceFor().save(body, actor);
    expect(await f.db.select().from(systemConfig)).toHaveLength(4);
    expect(await f.db.select().from(systemStore)).toHaveLength(1);
    const later = await snapshot(); await f.serviceFor().save(body, actor); expect(await snapshot()).toEqual(later);
  });
  it('requires repair for malformed history and rejects cross-parent or absent city IDs without changing data', async () => {
    await f.db.update(systemConfig).set({ value: 'invalid' }).where(eq(systemConfig.id, 2));
    await f.db.update(systemStore).set({ latitude: 'oops', dayTime: 'invalid' }).where(eq(systemStore.id, 2));
    const page = await f.serviceFor().get(); expect(page.settings.store_free_postage).toBeNull(); expect(page.pickup?.day_time).toEqual([]);
    expect(page.issues.length).toBeGreaterThanOrEqual(3);
    const before = await snapshot();
    for (const ids of [[10, 21, 12], [10, 11, 999], [20, 11, 12]]) {
      const body = shippingSaveInput(page.revision); body.pickup.address_ids = ids;
      await expect(f.serviceFor().save(body, actor)).rejects.toThrow(/层级/);
      expect(await snapshot()).toEqual(before);
    }
    await f.serviceFor().save(shippingSaveInput(page.revision), actor); expect((await f.serviceFor().get()).issues).toEqual([]);
  });
  it('detects ABA changes, priority-winner inserts and default-store hidden metadata in CAS', async () => {
    for (const change of ['aba', 'winner', 'store'] as const) {
      const body = await input();
      if (change === 'aba') { await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.id, 1)); await f.db.update(systemConfig).set({ value: '"0"' }).where(eq(systemConfig.id, 1)); }
      if (change === 'winner') await f.db.insert(systemConfig).values({ menuName: 'whole_free_shipping', value: '0', sort: 999 });
      if (change === 'store') await f.db.update(systemStore).set({ introduction: 'another editor' }).where(eq(systemStore.id, 2));
      const before = await snapshot(); await expect(f.serviceFor().save(body, actor)).rejects.toThrow(/已变化/); expect(await snapshot()).toEqual(before);
    }
  });
  it('binds one globally serialized UUID to actor and intent, and keeps receipt corruption distinct from absence', async () => {
    const body = await input(), receipt = await f.serviceFor().save(body, actor);
    await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.id, 1));
    const before = await snapshot(); expect(await f.serviceFor().save(body, actor)).toEqual(receipt); expect(await snapshot()).toEqual(before);
    expect(await f.serviceFor().receipt(body.request_id, actor)).toEqual(receipt);
    await expect(f.serviceFor().save(body, { id: 8 })).rejects.toThrow(/已用于/);
    await expect(f.serviceFor().save({ ...body, offline_postage: 1 }, actor)).rejects.toThrow(/已用于/);
    await expect(f.serviceFor().receipt(body.request_id, { id: 8 })).rejects.toThrow(/不存在/);
    await f.db.insert(systemLog).values({ type: 'shipping_settings', path: `/config/shipping/request/${body.request_id}`, adminId: 7, action: 'bad' });
    await expect(f.serviceFor().receipt(body.request_id, actor)).rejects.toThrow(/异常/);
    await expect(f.serviceFor().save(body, actor)).rejects.toThrow(/已用于/);
  });
  it('rolls back both default-store and config writes when the final receipt fails, while cache failure preserves a committed receipt', async () => {
    const before = await snapshot(), body = await input();
    await f.exec(`CREATE FUNCTION reject_shipping_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipping_settings' THEN RAISE EXCEPTION 'owned late receipt failure'; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER reject_shipping_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_shipping_receipt()');
    await expect(f.serviceFor().save(body, actor)).rejects.toThrow(); expect(await snapshot()).toEqual(before); expect(f.cacheDeletes).toEqual([]);
    await f.exec('DROP TRIGGER reject_shipping_receipt ON system_log'); await f.exec('DROP FUNCTION reject_shipping_receipt()');
    const faultyEnv: typeof f.env = { CONFIG_KV: { ...f.env.CONFIG_KV, delete: async () => { throw Error('owned KV unavailable'); } } };
    const receipt = await f.serviceFor(f.db, faultyEnv).save(body, actor);
    expect(await f.serviceFor().receipt(body.request_id, actor)).toEqual(receipt); expect((await f.serviceFor().get()).settings.store_free_postage).toBe('100.10');
  });
  it.each(['higher-winner', 'new-default'])('waits for an external %s writer and reads fresh state despite a repeatable-read session default', async change => {
    const body = await input();
    await f.withPeer(writer => f.withPeer(async admin => {
      await admin.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await writer.exec('BEGIN');
      if (change === 'higher-winner') await writer.exec("INSERT INTO system_config(menu_name,value,sort) VALUES('whole_free_shipping','0',1000)");
      else await writer.exec("INSERT INTO system_store(name) VALUES('new default from other editor')");
      const pending = outcome(f.serviceFor(admin.db).save(body, actor));
      try { await waitForFinanceBlock(f.db, admin.pid, writer.pid); } finally { await writer.exec('COMMIT'); }
      expect((await pending).ok).toBe(false); expect(await f.db.select().from(systemLog)).toEqual([]);
    }));
  });
  it('linearizes identical submissions on independent sessions and prevents duplicate stores or receipts', async () => {
    await f.db.delete(systemStore); const body = await input();
    await f.withPeer(gate => f.withPeer(first => f.withPeer(async second => {
      await gate.exec('BEGIN'); await gate.exec('LOCK TABLE system_config IN SHARE ROW EXCLUSIVE MODE');
      const a = outcome(f.serviceFor(first.db).save(body, actor)), b = outcome(f.serviceFor(second.db).save(body, actor));
      try { await waitForFinanceBlock(f.db, first.pid, gate.pid); await waitForFinanceBlock(f.db, second.pid, gate.pid); }
      finally { await gate.exec('COMMIT'); }
      const results = await Promise.all([a, b]); expect(results.every(result => result.ok)).toBe(true);
      if (results[0].ok && results[1].ok) expect(results[0].value).toEqual(results[1].value);
      expect(await f.db.select().from(systemStore)).toHaveLength(1); expect(await f.db.select().from(systemLog)).toHaveLength(1);
    })));
  });
  it.each(['city-name', 'city-parent', 'store-name', 'store-hidden'])('holds %s stable to commit, verified by the exact PostgreSQL blocker PID', async change => {
    const body = await input();
    await f.exec(`CREATE FUNCTION shipping_receipt_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='shipping_settings' THEN PERFORM pg_advisory_xact_lock(731699,77); END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER shipping_receipt_gate BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION shipping_receipt_gate()');
    await f.withPeer(gate => f.withPeer(admin => f.withPeer(async external => {
      await gate.exec('BEGIN'); await gate.exec('SELECT pg_advisory_xact_lock(731699,77)');
      const save = outcome(f.serviceFor(admin.db).save(body, actor));
      await waitForFinanceBlock(f.db, admin.pid, gate.pid);
      const query = change === 'city-name' ? "UPDATE city_area SET name='维护重命名' WHERE id=12" : change === 'city-parent'
        ? 'UPDATE city_area SET parent_id=21 WHERE id=12' : change === 'store-name' ? "UPDATE system_store SET name='后续编辑' WHERE id=2" : 'UPDATE system_store SET is_show=0 WHERE id=2';
      const edit = outcome(external.exec(query));
      try { await waitForFinanceBlock(f.db, external.pid, admin.pid); } finally { await gate.exec('COMMIT'); }
      expect((await save).ok).toBe(true); expect((await edit).ok).toBe(true); expect(await f.db.select().from(systemLog)).toHaveLength(1);
    })));
  });
  it('executes with existing nonowner Admin/app LOGIN privileges, real lock-only guards and actual pickup row locks', async () => {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installSlice(app, admin);
      expect((await admin.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: admin.role, session_user: admin.role });
      const body = shippingSaveInput((await f.serviceFor(admin.db).get()).revision), result = await f.serviceFor(admin.db).save(body, actor);
      expect(await f.serviceFor(admin.db).receipt(body.request_id, actor)).toEqual(result);
      expect(await readCheckoutPickupPolicy(app.db, 2)).toMatchObject({ enabled: true, store: { id: 2, name: '城北提货点' } });
      await withTx(createContainerFromDb(app.db), tx => lockCheckoutPickupStore(tx, 2));
      for (const [peer, query] of [[app, "UPDATE system_config SET value='1' WHERE id=1"], [app, 'UPDATE system_store SET id=id+100 WHERE id=2'],
        [admin, 'UPDATE city_area SET id=id+100 WHERE id=10'], [admin, 'CREATE TABLE unauthorized_shipping_ddl(id integer)'],
        [admin, 'UPDATE system_log SET action=action'], [admin, 'DELETE FROM system_log']] as const) {
        await expect(peer.exec(query)).rejects.toMatchObject({ code: '42501' });
      }
      await admin.exec('UPDATE city_area SET id=id WHERE id=10'); await app.exec('UPDATE system_store SET id=id WHERE id=2');
      expect((await f.serviceFor(admin.db).cities('10'))[0]).toMatchObject({ id: 11, label: '乙市' });
    }));
  });
});
