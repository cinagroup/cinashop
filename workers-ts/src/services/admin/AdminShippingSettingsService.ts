import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { cityArea, systemConfig, systemLog, systemStore } from '@/models/schema';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { normalizeConfigScalar } from '@/utils/config';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { SHIPPING_SETTINGS_KEYS, ShippingSettingsStaleVersion, shippingCoordinate, shippingId, shippingMoney, shippingRequestId, shippingSettingsCanonical,
  shippingSettingsHash, type ShippingSettingsKey, type ShippingSettingsReceipt, type ShippingPickupInput } from './AdminShippingSettingsInput';

const LOG_TYPE = 'shipping_settings';
const configColumns = { ...getTableColumns(systemConfig), version: sql<string>`xmin::text` };
const storeColumns = { ...getTableColumns(systemStore), version: sql<string>`xmin::text` };
type ConfigRow = typeof systemConfig.$inferSelect & { version: string };
type StoreRow = typeof systemStore.$inferSelect & { version: string };
const receiptPath = (requestId: string) => `/config/shipping/request/${requestId}`;
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
async function source(tx: DbClient) {
  const winners = await tx.selectDistinctOn([systemConfig.menuName], configColumns).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...SHIPPING_SETTINGS_KEYS])))
    .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id));
  // Legacy getStoreInfo() delegates to getStoreList(is_del=0), ordered id DESC.
  // Hidden/non-pickup rows are still the one default row that enabling repairs.
  const [pickup] = await tx.select(storeColumns).from(systemStore).where(eq(systemStore.isDel, 0)).orderBy(desc(systemStore.id)).limit(1);
  return { rows: new Map(winners.map(row => [row.menuName, row])), pickup };
}
async function revision(rows: Map<string, ConfigRow>, pickup: StoreRow | undefined) {
  // xmin catches ABA and changes to hidden metadata. Full rows are hashed only;
  // payment/bank properties of a legacy store never enter the HTTP projection.
  return shippingSettingsHash({ domain: 'shipping-settings-v1', values: SHIPPING_SETTINGS_KEYS.map(key => ({ key, row: rows.get(key) ?? null })), pickup: pickup ?? null });
}
function receiptFrom(action: string, request_id: string): ShippingSettingsReceipt | null {
  const match = /^save;payload=([a-f0-9]{64})$/.exec(action);
  return match ? { operation: 'save', request_id, payload_hash: match[1] } : null;
}
function actorId(actor: { id: number }): number { return shippingId(actor?.id); }

export class AdminShippingSettingsService {
  constructor(private readonly container: Container, private readonly env: Pick<SystemConfigEnv, 'CONFIG_KV'>) {}

  async get() {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const { rows, pickup } = await source(tx);
      const settings: Record<ShippingSettingsKey, 0 | 1 | string | null> = { whole_free_shipping: null, store_free_postage: null, offline_postage: null, store_self_mention: null };
      const raw_values = Object.fromEntries(SHIPPING_SETTINGS_KEYS.map(key => [key, rows.get(key)?.value ?? null]));
      const issues: { key: string; message: string }[] = [];
      for (const key of SHIPPING_SETTINGS_KEYS) {
        const value = rows.get(key)?.value;
        const normalized = value === undefined ? undefined : normalizeConfigScalar(value);
        try {
          if (normalized === undefined) throw Error('配置缺失');
          if (key === 'store_free_postage') settings[key] = shippingMoney(normalized);
          else if (normalized === '0' || normalized === '1') settings[key] = Number(normalized) as 0 | 1;
          else throw Error('历史值不是整数0或1');
        } catch (error) { issues.push({ key, message: `${key}：${error instanceof Error ? error.message : '历史值异常'}，请明确选择后保存` }); }
      }
      let projected: null | { id: number; name: string; phone: string; address_ids: number[]; address_labels: string[];
        detailed_address: string; day_time: string[]; latitude: string; longitude: string; is_show: number; is_store: number } = null;
      if (pickup) {
        const address_ids = [pickup.province, pickup.city, pickup.area, pickup.street ?? 0].filter(id => id > 0);
        const places = address_ids.length ? await tx.select({ id: cityArea.id, name: cityArea.name, parentId: cityArea.parentId, level: cityArea.level })
          .from(cityArea).where(inArray(cityArea.id, address_ids)).orderBy(asc(cityArea.id)) : [];
        const mapped = new Map(places.map(place => [place.id, place]));
        const validAddress = address_ids.length >= 3 && address_ids.length <= 4 && address_ids.every((id, index) => {
          const place = mapped.get(id); return place?.parentId === (index ? address_ids[index - 1] : 0) && place.level === index + 1;
        });
        if (!validAddress) issues.push({ key: 'pickup', message: '默认提货点历史地区链异常，请重新选择省市区及街道' });
        const day_time = pickup.dayTime.split(/\s*-\s*/);
        const times = day_time.length === 2 && day_time.every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ? day_time : [];
        const latitude = pickup.latitude.trim(), longitude = pickup.longitude.trim();
        try { shippingCoordinate(latitude, 90); shippingCoordinate(longitude, 180); }
        catch { issues.push({ key: 'pickup', message: '默认提货点历史经纬度异常，请修复后开启自提' }); }
        if (!times.length) issues.push({ key: 'pickup', message: '默认提货点历史营业时间异常，请修复后开启自提' });
        if (!/^1[3-9]\d{9}$/.test(pickup.phone.trim()) || !pickup.name.trim() || !pickup.detailedAddress.trim()) {
          issues.push({ key: 'pickup', message: '默认提货点历史名称、手机号或详细地址不完整，请修复后开启自提' });
        }
        projected = { id: pickup.id, name: pickup.name, phone: pickup.phone.trim(), address_ids,
          address_labels: address_ids.map(id => mapped.get(id)?.name ?? ''), detailed_address: pickup.detailedAddress,
          day_time: times, latitude, longitude, is_show: pickup.isShow, is_store: pickup.isStore };
      } else if (settings.store_self_mention === 1) issues.push({ key: 'pickup', message: '自提已开启但默认提货点缺失，请完整填写后保存' });
      return { settings, raw_values, missing_keys: SHIPPING_SETTINGS_KEYS.filter(key => !rows.has(key)), issues, pickup: projected,
        revision: await revision(rows, pickup) };
    });
  }

  async cities(pidValue: unknown) {
    const pid = shippingId(pidValue ?? '0', true);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      let expectedLevel = 1;
      if (pid) {
        const [parent] = await tx.select({ id: cityArea.id, level: cityArea.level }).from(cityArea).where(eq(cityArea.id, pid)).limit(1);
        if (!parent || parent.level < 1 || parent.level > 4) throw new ValidateException('所选地区不存在或层级无效');
        if (parent.level === 4) return [];
        expectedLevel = parent.level + 1;
      }
      const rows = await tx.select({ id: cityArea.id, label: cityArea.name, pid: cityArea.parentId, level: cityArea.level })
        .from(cityArea).where(eq(cityArea.parentId, pid)).orderBy(asc(cityArea.snum), asc(cityArea.id)).limit(1001);
      if (rows.length > 1000) throw new ValidateException('地区子节点超过安全上限');
      if (rows.some(row => row.level !== expectedLevel || !row.label.trim())) throw new ValidateException('地区子节点层级或名称异常');
      const ids = rows.map(row => row.id);
      const childRows = ids.length ? await tx.selectDistinct({ parentId: cityArea.parentId }).from(cityArea)
        .where(inArray(cityArea.parentId, ids)).limit(1001) : [];
      const hasChildren = new Set(childRows.map(row => row.parentId));
      return rows.map(row => ({ value: row.id, ...row, has_children: row.level < 4 && hasChildren.has(row.id) }));
    });
  }

  async receipt(value: unknown, actor: { id: number }): Promise<ShippingSettingsReceipt> {
    const request_id = shippingRequestId(value), id = actorId(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.type, LOG_TYPE), eq(systemLog.path, receiptPath(request_id)), eq(systemLog.adminId, id))).limit(2);
      if (!rows.length) throw new NotFoundException('配送设置操作回执不存在');
      const result = rows.length === 1 ? receiptFrom(rows[0].action, request_id) : null;
      if (!result) throw new ValidateException('配送设置操作回执异常，无法确认结果');
      return result;
    });
  }

  private async checkedAddress(tx: DbClient, pickup: ShippingPickupInput): Promise<string> {
    // Current Admin grants already include UPDATE(id), needed for FOR SHARE.
    // Existing lock-only triggers prohibit semantic city changes by runtime.
    const rows = await tx.select({ id: cityArea.id, name: cityArea.name, parentId: cityArea.parentId, level: cityArea.level })
      .from(cityArea).where(inArray(cityArea.id, pickup.address_ids)).orderBy(asc(cityArea.id)).for('share');
    const mapped = new Map(rows.map(row => [row.id, row]));
    const names = pickup.address_ids.map((id, index) => {
      const row = mapped.get(id);
      if (!row || row.parentId !== (index ? pickup.address_ids[index - 1] : 0) || row.level !== index + 1 || !row.name.trim()) {
        throw new ValidateException('提货点省市区街道层级无效，请重新选择');
      }
      return row.name;
    });
    const address = names.join('');
    if ([...address].length > 255) throw new ValidateException('提货点地区名称过长');
    return address;
  }

  async save(value: unknown, actor: { id: number }): Promise<ShippingSettingsReceipt> {
    const { request_id, canonical } = shippingSettingsCanonical(value), id = actorId(actor);
    const payload_hash = await shippingSettingsHash(canonical);
    const receipt = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await deadlines(tx);
      // Fixed order serializes missing rows, legacy duplicate-winner changes and
      // default-store INSERT/DELETE alongside the separate existing store editor.
      await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE ROW EXCLUSIVE MODE`);
      await tx.execute(sql`LOCK TABLE ${systemStore} IN SHARE ROW EXCLUSIVE MODE`);
      const journal = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, LOG_TYPE), eq(systemLog.path, receiptPath(request_id)))).limit(2);
      if (journal.length) {
        const result = journal.length === 1 ? receiptFrom(journal[0].action, request_id) : null;
        if (!result || journal[0].actor !== id || result.payload_hash !== payload_hash) throw new ValidateException('请求标识已用于其他配送设置操作');
        return result;
      }
      const before = await source(tx);
      if (await revision(before.rows, before.pickup) !== canonical.revision) throw new ShippingSettingsStaleVersion(request_id, payload_hash);
      let expectedPickup: Record<string, string | number> | undefined;
      if (canonical.pickup) {
        const pickup = canonical.pickup, address = await this.checkedAddress(tx, pickup);
        const values = { name: pickup.name, phone: pickup.phone, address,
          province: pickup.address_ids[0], city: pickup.address_ids[1], area: pickup.address_ids[2], street: pickup.address_ids[3] ?? 0,
          detailedAddress: pickup.detailed_address, dayTime: pickup.day_time.join(' - '), dayStart: pickup.day_time[0], dayEnd: pickup.day_time[1],
          latitude: pickup.latitude, longitude: pickup.longitude, isShow: 1, isStore: 1 };
        expectedPickup = values;
        if (before.pickup) await tx.update(systemStore).set(values).where(eq(systemStore.id, before.pickup.id));
        else await tx.insert(systemStore).values({ ...values, addTime: Math.floor(Date.now() / 1000) });
      }
      for (const key of SHIPPING_SETTINGS_KEYS) {
        const raw = String(canonical[key]), winner = before.rows.get(key);
        if (winner) await tx.update(systemConfig).set({ value: raw }).where(eq(systemConfig.id, winner.id));
        else await tx.insert(systemConfig).values({ menuName: key, value: raw, isStore: 0, type: key === 'store_free_postage' ? 'text' : 'radio',
          inputType: key === 'store_free_postage' ? 'number' : '', info: key, configTabId: key === 'whole_free_shipping' ? 26 : 27,
          parameter: key === 'store_free_postage' ? '' : '0=>关闭\n1=>开启', status: 1 });
      }
      const after = await source(tx);
      if (SHIPPING_SETTINGS_KEYS.some(key => after.rows.get(key)?.value !== String(canonical[key]))) throw Error('配送设置回读不一致');
      if (expectedPickup && (!after.pickup || Object.entries(expectedPickup).some(([key, value]) => {
        const actual = (after.pickup as unknown as Record<string, unknown>)[key];
        return typeof value === 'string' && ['phone', 'latitude', 'longitude'].includes(key)
          ? String(actual).trim() !== value : actual !== value;
      }))) {
        throw Error('默认提货点回读不一致');
      }
      await tx.insert(systemLog).values({ adminId: id, type: LOG_TYPE, path: receiptPath(request_id), method: 'POST', page: 'setting-distribution-deliver',
        action: `save;payload=${payload_hash}`, addTime: Math.floor(Date.now() / 1000) });
      return { operation: 'save' as const, request_id, payload_hash };
    });
    // Receipt represents the atomic SQL commit. Cache deletion failures must
    // never pretend that an already committed mutation failed or repeat writes.
    await Promise.allSettled(SHIPPING_SETTINGS_KEYS.map(key => Promise.resolve().then(() => this.env.CONFIG_KV.delete(`cfg_${key}`))));
    return receipt;
  }
}
