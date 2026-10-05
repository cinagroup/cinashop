import { and, asc, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeDeliveryOrder as delivery, storeOrder as order, systemStore as store, systemSupplier as supplier } from '@/models/schema';
import { NotFoundException } from '@/utils/errors';
import { cityDeliveryDistance, cityDeliveryLike, cityDeliveryMoney, cityDeliveryRecordFilters, cityDeliveryRecordId, cityDeliveryStoreFilters } from './AdminCityDeliveryRecordInput';

export interface CityDeliveryRecord {
  id: number; type: number; relation_id: number; uid: number; oid: number; station_type: number;
  provider_label: string; status: number; status_label: string; order_id: string; delivery_no: string; add_time: number;
  from_address: string; to_address: string; mark: string;
  owner: { kind: 'platform' | 'store' | 'supplier' | 'unknown'; id: number | null; label: string; image: string | null; is_show: number | null; is_del: number | null };
  origin_order: null | { id: number; order_id: string; pid: number; status: number; is_del: number };
  distance_meters: number | null; distance_km: string | null; cargo_price: string | null; fee: string | null; deduct_fee: string | null;
  invalid_values: Record<string, string>; issues: string[];
}
const statusLabels: Record<number, string> = { 0: '初始记录', 1: '历史状态 1（含义待核实）', 2: '待取货', 3: '配送中', 4: '已完成',
  '-1': '已取消', 9: '物品返回中', 10: '物品返回完成', 100: '骑士到店' };
const ownerMatches = or(
  and(eq(delivery.type, 1), sql`${order.storeId} > 0`, eq(order.storeId, delivery.relationId)),
  and(eq(delivery.type, 2), eq(order.storeId, 0), sql`${order.supplierId} > 0`, eq(order.supplierId, delivery.relationId)),
  and(eq(delivery.type, 0), eq(delivery.relationId, 0), eq(order.storeId, 0), eq(order.supplierId, 0)),
)!;
// The legacy create() selects store_id first, supplier_id second, else platform.
// store_order.type describes promotions and never participates in owner matching.
const originMatches = and(eq(order.id, delivery.oid), sql`${delivery.uid} > 0`, eq(order.uid, delivery.uid), ownerMatches)!;
const columns = {
  id: delivery.id, type: delivery.type, relationId: delivery.relationId, uid: delivery.uid, oid: delivery.oid,
  stationType: delivery.stationType, status: delivery.status, orderId: delivery.orderId, deliveryNo: delivery.deliveryNo, addTime: delivery.addTime,
  fromAddress: delivery.fromAddress, toAddress: delivery.toAddress, mark: delivery.mark, distance: delivery.distance,
  cargoPrice: delivery.cargoPrice, fee: delivery.fee, deductFee: delivery.deductFee,
  storeId: store.id, storeName: store.name, storeImage: store.image, storeShow: store.isShow, storeDel: store.isDel,
  supplierId: supplier.id, supplierName: supplier.supplierName, supplierImage: supplier.avatar, supplierShow: supplier.isShow, supplierDel: supplier.isDel,
  originId: order.id, originNumber: order.orderId, originPid: order.pid, originStatus: order.status, originDel: order.isDel,
  originExists: sql<boolean>`EXISTS (SELECT 1 FROM store_order origin WHERE origin.id=${delivery.oid})`,
  originUidMatches: sql<boolean>`EXISTS (SELECT 1 FROM store_order origin WHERE origin.id=${delivery.oid} AND origin.uid=${delivery.uid} AND ${delivery.uid}>0)`,
  originOwnerUnverified: sql<boolean>`EXISTS (SELECT 1 FROM store_order origin WHERE origin.id=${delivery.oid} AND origin.uid=${delivery.uid}
    AND ${delivery.type}=0 AND ${delivery.relationId}=0 AND origin.supplier_id=0 AND origin.store_id>0)`,
};
type RecordRow = { [K in keyof typeof columns]: K extends 'originExists' | 'originUidMatches' | 'originOwnerUnverified' ? boolean :
  K extends 'orderId' | 'deliveryNo' | 'fromAddress' | 'toAddress' | 'mark' | 'cargoPrice' | 'fee' | 'deductFee' ? string :
  K extends 'storeName' | 'storeImage' | 'supplierName' | 'supplierImage' | 'originNumber' ? string | null : number | null };
function project(row: RecordRow): CityDeliveryRecord {
  const issues: string[] = [], invalid: Record<string, string> = {};
  let owner: CityDeliveryRecord['owner'];
  if (row.type === 0) {
    owner = { kind: 'platform', id: 0, label: '平台', image: null, is_show: null, is_del: null };
    if (row.relationId !== 0) issues.push('owner_relation_invalid');
  } else if (row.type === 1 || row.type === 2) {
    const isStore = row.type === 1, id = isStore ? row.storeId : row.supplierId;
    const name = isStore ? row.storeName : row.supplierName;
    owner = { kind: isStore ? 'store' : 'supplier', id: row.relationId, label: name || `${isStore ? '门店' : '供应商'} #${row.relationId}`,
      image: id === null ? null : (isStore ? row.storeImage : row.supplierImage),
      is_show: id === null ? null : (isStore ? row.storeShow : row.supplierShow), is_del: id === null ? null : (isStore ? row.storeDel : row.supplierDel) };
    if (row.relationId === null || row.relationId <= 0) issues.push('owner_relation_invalid');
    if (id === null) issues.push('owner_missing'); else {
      if (!name) issues.push('owner_label_empty');
      if (owner.is_show !== 1) issues.push('owner_hidden');
      if (owner.is_del !== 0) issues.push('owner_deleted');
    }
  } else { owner = { kind: 'unknown', id: row.relationId, label: `未知归属 (${row.type})`, image: null, is_show: null, is_del: null }; issues.push('owner_type_unknown'); }
  if (row.stationType !== 1 && row.stationType !== 2) issues.push('provider_unknown');
  if (!(row.status! in statusLabels)) issues.push('status_unknown');
  if (row.status === 1) issues.push('status_ambiguous');
  const origin = row.originId === null ? null : { id: row.originId, order_id: row.originNumber!, pid: row.originPid!, status: row.originStatus!, is_del: row.originDel! };
  if (!row.originExists) issues.push('origin_order_missing');
  else if (!row.originUidMatches) issues.push('origin_uid_mismatch');
  else if (!origin) issues.push(row.originOwnerUnverified ? 'origin_owner_unverified' : 'origin_owner_mismatch');
  if (origin?.is_del !== undefined && origin.is_del !== 0) issues.push('origin_order_deleted');
  const distance = cityDeliveryDistance(row.distance!);
  if (distance.meters === null) { invalid.distance_meters = String(row.distance); issues.push('distance_invalid'); }
  const money = (key: 'cargo_price' | 'fee' | 'deduct_fee', raw: string) => {
    const value = cityDeliveryMoney(raw); if (value === null) { invalid[key] = raw; issues.push(`${key}_invalid`); } return value;
  };
  return { id: row.id!, type: row.type!, relation_id: row.relationId!, uid: row.uid!, oid: row.oid!, station_type: row.stationType!,
    provider_label: row.stationType === 1 ? '达达' : row.stationType === 2 ? 'UU' : `未知平台 (${row.stationType})`,
    status: row.status!, status_label: statusLabels[row.status!] ?? `未知状态 (${row.status})`, order_id: row.orderId, delivery_no: row.deliveryNo, add_time: row.addTime!,
    from_address: row.fromAddress, to_address: row.toAddress, mark: row.mark, owner, origin_order: origin,
    distance_meters: distance.meters, distance_km: distance.km, cargo_price: money('cargo_price', row.cargoPrice), fee: money('fee', row.fee), deduct_fee: money('deduct_fee', row.deductFee), invalid_values: invalid, issues };
}
const contains = (column: SQL | typeof delivery.orderId | typeof delivery.deliveryNo | typeof order.orderId | typeof store.name, keyword: string) =>
  sql`${column} ILIKE ${cityDeliveryLike(keyword)} ESCAPE ${'\\'}`;
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
function joined(tx: DbClient) { return tx.select(columns).from(delivery)
  .leftJoin(store, and(eq(delivery.type, 1), eq(store.id, delivery.relationId)))
  .leftJoin(supplier, and(eq(delivery.type, 2), eq(supplier.id, delivery.relationId)))
  .leftJoin(order, originMatches); }
export class AdminCityDeliveryRecordService {
  constructor(private readonly container: Container) {}
  private read<T>(run: (tx: DbClient) => Promise<T>): Promise<T> { return withTx(this.container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx); return run(tx);
  }); }
  async records(params = new URLSearchParams()) {
    const filters = cityDeliveryRecordFilters(params), predicates: SQL[] = [];
    if (filters.station_type !== null) predicates.push(eq(delivery.stationType, filters.station_type));
    if (filters.status !== null) predicates.push(eq(delivery.status, filters.status));
    if (filters.store_id !== null) predicates.push(and(eq(delivery.type, 1), eq(delivery.relationId, filters.store_id))!);
    if (filters.date_from !== null && filters.date_to !== null) predicates.push(gte(delivery.addTime, filters.date_from), lte(delivery.addTime, filters.date_to));
    if (filters.keyword) predicates.push(or(contains(delivery.orderId, filters.keyword), contains(delivery.deliveryNo, filters.keyword), contains(order.orderId, filters.keyword))!);
    const where = and(...predicates);
    return this.read(async tx => {
      const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(delivery).leftJoin(order, originMatches).where(where);
      const rows = await joined(tx).where(where).orderBy(desc(delivery.addTime), desc(delivery.id)).offset(filters.offset).limit(filters.limit);
      return { items: rows.map(project), total: count.total, page: filters.page, limit: filters.limit };
    });
  }
  async detail(idValue: string) {
    const id = cityDeliveryRecordId(idValue);
    return this.read(async tx => {
      const [row] = await tx.select({ ...columns, cityCode: delivery.cityCode, merId: delivery.merId, mark: delivery.mark, reason: delivery.reason,
        receiverName: delivery.userName, receiverPhone: delivery.receiverPhone }).from(delivery)
        .leftJoin(store, and(eq(delivery.type, 1), eq(store.id, delivery.relationId)))
        .leftJoin(supplier, and(eq(delivery.type, 2), eq(supplier.id, delivery.relationId)))
        .leftJoin(order, originMatches).where(eq(delivery.id, id)).limit(1);
      if (!row) throw new NotFoundException('配送记录不存在');
      return { record: project(row), metadata: { city_code: row.cityCode, mer_id: row.merId, mark: row.mark, reason: row.reason,
        receiver_name: row.receiverName, receiver_phone: row.receiverPhone, from_address: row.fromAddress, to_address: row.toAddress } };
    });
  }
  async stores(params = new URLSearchParams()) {
    const filters = cityDeliveryStoreFilters(params), where = filters.keyword ? contains(store.name, filters.keyword) : undefined;
    return this.read(async tx => {
      const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(store).where(where);
      const rows = await tx.select({ id: store.id, label: store.name, is_show: store.isShow, is_del: store.isDel }).from(store).where(where)
        .orderBy(asc(store.id)).offset(filters.offset).limit(filters.limit);
      return { items: rows.map(row => ({ ...row, label: row.label || `门店 #${row.id}`, issues: [
        ...(row.label ? [] : ['owner_label_empty']), ...(row.is_show === 1 ? [] : ['owner_hidden']), ...(row.is_del === 0 ? [] : ['owner_deleted']),
      ] })), total: count.total, page: filters.page, limit: filters.limit };
    });
  }
}
