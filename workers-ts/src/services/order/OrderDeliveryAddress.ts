import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { cityArea, userAddress } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export interface ManualDeliveryAddress {
  realName?: unknown; phone?: unknown; province?: unknown; city?: unknown;
  district?: unknown; street?: unknown; detail?: unknown; cityId?: unknown;
}

/** Assisted clients can still enter an address without saving it to a user's
 * address book, but must select its structured province/city/district region. */
export function assistedDeliveryAddress(body: Record<string, unknown>): ManualDeliveryAddress | undefined {
  const nested = body.manualAddress !== undefined ? body.manualAddress : body.manual_address;
  const freeText = body.address;
  if (nested === undefined && (freeText === undefined || freeText === '')) return undefined;
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested))) {
    throw new ValidateException('收货地址参数无效');
  }
  const value = nested === undefined ? body : nested as Record<string, unknown>;
  return { realName: value.realName ?? value.real_name ?? body.real_name,
    phone: value.phone ?? body.phone, province: value.province, city: value.city,
    district: value.district, street: value.street, detail: value.detail ?? freeText,
    cityId: value.cityId ?? value.city_id };
}
type SavedAddress = typeof userAddress.$inferSelect;
type Region = Pick<typeof cityArea.$inferSelect, 'id' | 'parentId' | 'name' | 'path'>;
export interface DeliveryAddressSnapshot {
  saved: SavedAddress | null;
  fields: { realName: string; phone: string; province: string; city: string; district: string; street: string; detail: string; cityId: number };
  regions: Region[];
}

export function checkoutAddressId(value: unknown, alias?: unknown): number {
  const parse = (input: unknown): number => {
    if (input === undefined) return 0;
    if (typeof input !== 'number' && (typeof input !== 'string' || !/^\d+$/.test(input))) {
      throw new ValidateException('收货地址ID无效');
    }
    const id = Number(input);
    if (!Number.isSafeInteger(id) || id < 0 || id > 2_147_483_647) throw new ValidateException('收货地址ID无效');
    return id;
  };
  const id = parse(value), other = parse(alias);
  if (value !== undefined && alias !== undefined && id !== other) throw new ValidateException('收货地址ID参数冲突');
  return value === undefined ? other : id;
}

function text(value: unknown, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidateException('收货地址信息格式或长度无效');
  }
  const normalized = value.trim();
  if (!optional && !normalized) throw new ValidateException('请填写完整的收货地址、收货人和电话');
  return normalized;
}

export function checkoutContact(realName: unknown, phone: unknown, required: boolean) {
  if (required && (typeof realName !== 'string' || !realName.trim() || typeof phone !== 'string' || !phone.trim())) {
    throw new ValidateException('请填写姓名和电话');
  }
  return { realName: text(realName ?? '', 32, !required), userPhone: text(phone ?? '', 18, !required) };
}

function fields(input: ManualDeliveryAddress): DeliveryAddressSnapshot['fields'] {
  const cityId = checkoutAddressId(input.cityId);
  if (!cityId) throw new ValidateException('请选择收货地址的完整省市区');
  const result = { realName: text(input.realName, 32), phone: text(input.phone, 16),
    province: text(input.province, 64), city: text(input.city, 64), district: text(input.district, 64),
    street: text(input.street, 100, true), detail: text(input.detail, 256), cityId };
  // The persisted order column is narrower than the sum of address-book columns.
  if ([...deliveryAddressText(result)].length > 100) throw new ValidateException('收货地址长度超出订单限制');
  return result;
}

export function deliveryAddressText(value: DeliveryAddressSnapshot['fields']): string {
  return [value.province, value.city, value.district, value.street, value.detail].filter(Boolean).join(' ');
}

function segments(values: readonly string[]): string[] {
  const names = values.map(value => value.trim()).filter(Boolean);
  return names.filter((name, index) => index === 0 || name !== names[index - 1]);
}

const regionColumns = { id: cityArea.id, parentId: cityArea.parentId, name: cityArea.name, path: cityArea.path };
async function readRegions(db: DbClient, value: DeliveryAddressSnapshot['fields']): Promise<Region[]> {
  const [leaf] = await db.select(regionColumns).from(cityArea).where(eq(cityArea.id, value.cityId)).limit(1);
  if (!leaf || leaf.path.length > 128 || !/^\/(?:[1-9]\d*\/)*$/.test(leaf.path)) {
    throw new ValidateException('收货地址区域不存在或层级无效');
  }
  const ancestors = leaf.path.split('/').filter(Boolean).map(Number);
  if (ancestors.some(id => !Number.isSafeInteger(id) || id > 2_147_483_647) || ancestors.length > 4
      || ancestors.includes(leaf.id) || new Set(ancestors).size !== ancestors.length) {
    throw new ValidateException('收货地址区域层级无效');
  }
  const ids = [...ancestors, leaf.id];
  const rows = await db.select(regionColumns).from(cityArea).where(inArray(cityArea.id, ids)).orderBy(cityArea.id);
  const ordered = ids.map(id => rows.find(row => row.id === id));
  if (rows.length !== ids.length || ordered.some((row, index) => !row || row.parentId !== (ids[index - 1] ?? 0)
      || row.path !== (index ? `/${ids.slice(0, index).join('/')}/` : '/'))) {
    throw new ValidateException('收货地址区域层级已变化');
  }
  if (JSON.stringify(segments(ordered.map(row => row!.name))) !== JSON.stringify(segments([
    value.province, value.city, value.district, value.street,
  ]))) throw new ValidateException('收货地址区域与省市区不一致');
  return rows;
}

/** The caller chooses preview vs create, not the request body. An explicit bad
 * address is never changed into a default or address-free quote. */
export async function resolveDeliveryAddress(db: DbClient, input: {
  uid: number; addressId?: unknown; addressAlias?: unknown;
  manual?: ManualDeliveryAddress; assisted: boolean; required: boolean;
}): Promise<DeliveryAddressSnapshot | null> {
  const id = checkoutAddressId(input.addressId, input.addressAlias);
  if (input.manual !== undefined && (!input.manual || typeof input.manual !== 'object' || Array.isArray(input.manual))) {
    throw new ValidateException('收货地址参数无效');
  }
  if (input.manual !== undefined && (!input.assisted || id > 0)) throw new ValidateException('收货地址来源冲突');
  let saved: SavedAddress | null = null;
  if (id) {
    if (input.uid <= 0) throw new ValidateException('游客不能使用用户收货地址');
    const [row] = await db.select().from(userAddress).where(and(
      eq(userAddress.id, id), eq(userAddress.uid, input.uid), eq(userAddress.isDel, 0),
    )).limit(1);
    if (!row) throw new ValidateException('收货地址不存在或不属于当前用户');
    saved = row;
  } else if (input.manual === undefined) {
    if (input.required) throw new ValidateException('请选择完整的收货地址');
    return null;
  }
  const resolved = fields(saved ?? input.manual!);
  return { saved, fields: resolved, regions: await readRegions(db, resolved) };
}

/** No reverse-order wait after order/cart/inventory locks. Known address writers
 * need not adopt an advisory-lock convention: PostgreSQL row locks protect them.
 * Compare only delivery fields; changing default/metadata is harmless. */
export async function assertDeliveryAddressSnapshot(tx: DbClient, expected: DeliveryAddressSnapshot): Promise<void> {
  try {
    if (expected.saved) {
      const [current] = await tx.select().from(userAddress).where(and(eq(userAddress.id, expected.saved.id),
        eq(userAddress.uid, expected.saved.uid), eq(userAddress.isDel, 0))).limit(1).for('share', { noWait: true });
      if (!current || JSON.stringify(fields(current)) !== JSON.stringify(expected.fields)) {
        throw new ValidateException('收货地址已变化，请刷新后重试');
      }
    }
    const regions = await tx.select(regionColumns).from(cityArea)
      .where(inArray(cityArea.id, expected.regions.map(row => row.id))).orderBy(cityArea.id).for('share', { noWait: true });
    if (JSON.stringify(regions) !== JSON.stringify(expected.regions)) throw new ValidateException('收货地址区域已变化，请刷新后重试');
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('收货地址正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
