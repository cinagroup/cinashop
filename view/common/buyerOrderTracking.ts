import { orderDetailId } from './orderDetailIdentity';

export interface BuyerTrackingIntent { kind: 'order' | 'refund'; reference: string }
export interface BuyerTrackingTrace { time: string; content: string; status: string }
export interface BuyerTrackingPackage {
  orderId: string; deliveryStatus: string; expressName: string; expressCode: string; expressNo: string;
  trackingState: 'pending' | 'in_transit' | 'delivered' | 'exception' | 'not_configured' | 'temporarily_unavailable';
  trackingSource: 'merchant' | 'carrier' | 'cache'; message: string; lastUpdatedAt: number; traces: BuyerTrackingTrace[];
}
export interface BuyerTrackingItem {
  id: number; name: string; sku: string; image: string; quantity: number | null; unitPrice: string | null;
}
export interface BuyerTrackingContext {
  orderId: string; entityId: number; uid: number;
  recipientName: string; recipientPhone: string; recipientAddress: string;
  merchant: { source: 'store' | 'supplier' | 'platform'; name: string; phone: string; address: string };
  items: BuyerTrackingItem[]; itemsError: string;
}
/** An explicit buyer view. Staff readers keep their existing minimal contract. */
export interface BuyerTrackingResult extends BuyerTrackingPackage {
  version: 1;
  identity: BuyerTrackingIntent & { uid: number; entityId: number; entityNo: string; split: boolean };
  packages: BuyerTrackingPackage[]; contexts: BuyerTrackingContext[];
  express: Array<{ time: string; status: string }>;
  order: { order_id: string; delivery_id: string; delivery_name: string; delivery_code: string; delivery_type: string };
}

export function buyerTrackingIntent(reference: unknown, type?: unknown): BuyerTrackingIntent {
  const id = orderDetailId(reference);
  if (type !== undefined && type !== '' && type !== 'refund') throw Error('物流链接类型无效');
  if (type === 'refund' && (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647)) throw Error('退货物流链接无效，请从退款详情重新进入');
  return { reference: id, kind: type === 'refund' ? 'refund' : 'order' };
}
export function buyerTrackingParameters(params: URLSearchParams): BuyerTrackingIntent {
  for (const key of ['orderId', 'type']) if (params.getAll(key).length > 1) throw Error('物流链接包含重复参数');
  if (params.getAll('orderId').length !== 1) throw Error('物流链接缺少订单标识');
  return buyerTrackingIntent(params.get('orderId'), params.get('type') ?? undefined);
}
const invalid = (): never => { throw Error('物流响应与当前账号或查询不一致，请重新读取'); };
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Record<string, unknown>;
}
function text(raw: unknown, max = 255): string {
  if (typeof raw !== 'string' || raw.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return invalid();
  return raw;
}
function integer(raw: unknown, zero = false): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < (zero ? 0 : 1) || raw > 2147483647) return invalid();
  return raw;
}
function traces(raw: unknown): BuyerTrackingTrace[] {
  if (!Array.isArray(raw) || raw.length > 200) return invalid();
  return raw.map(value => { const row = object(value); return { time: text(row.time, 128), content: text(row.content, 4096), status: text(row.status, 128) }; });
}
function parcel(raw: unknown): BuyerTrackingPackage {
  const row = object(raw), orderId = orderDetailId(row.orderId);
  if (typeof row.trackingState !== 'string' || !['pending', 'in_transit', 'delivered', 'exception', 'not_configured', 'temporarily_unavailable'].includes(row.trackingState)
    || typeof row.trackingSource !== 'string' || !['merchant', 'carrier', 'cache'].includes(row.trackingSource)) return invalid();
  const result = { orderId, deliveryStatus: text(row.deliveryStatus), expressName: text(row.expressName), expressCode: text(row.expressCode, 100),
    expressNo: text(row.expressNo, 100), trackingState: row.trackingState as BuyerTrackingPackage['trackingState'],
    trackingSource: row.trackingSource as BuyerTrackingPackage['trackingSource'], message: text(row.message, 4096),
    lastUpdatedAt: integer(row.lastUpdatedAt, true), traces: traces(row.traces) };
  if ((result.trackingSource === 'merchant' && (result.lastUpdatedAt !== 0 || result.traces.length))
    || (['not_configured', 'temporarily_unavailable'].includes(result.trackingState) && result.traces.length)) return invalid();
  return result;
}
function context(raw: unknown, uid: number): BuyerTrackingContext {
  const row = object(raw), merchant = object(row.merchant), seen = new Set<number>();
  if (row.uid !== uid || typeof merchant.source !== 'string' || !['store', 'supplier', 'platform'].includes(merchant.source) || !Array.isArray(row.items) || row.items.length > 200) return invalid();
  const items = row.items.map(rawItem => {
    const item = object(rawItem), id = integer(item.id), image = text(item.image, 4096);
    if (seen.has(id) || (image && !/^(?:https?:\/\/|\/(?!\/))/.test(image))) return invalid(); seen.add(id);
    if (item.unitPrice !== null && (typeof item.unitPrice !== 'string' || !/^\d{1,10}\.\d{2}$/.test(item.unitPrice))) return invalid();
    return { id, name: text(item.name, 4096), sku: text(item.sku, 4096), image,
      quantity: item.quantity === null ? null : integer(item.quantity), unitPrice: item.unitPrice as string | null };
  });
  return { orderId: orderDetailId(row.orderId), entityId: integer(row.entityId), uid,
    recipientName: text(row.recipientName, 100), recipientPhone: text(row.recipientPhone, 32), recipientAddress: text(row.recipientAddress, 1000),
    merchant: { source: merchant.source as BuyerTrackingContext['merchant']['source'], name: text(merchant.name, 100), phone: text(merchant.phone, 32), address: text(merchant.address, 1000) },
    items, itemsError: text(row.itemsError, 1000) };
}
export function parseBuyerTrackingResult(raw: unknown, intent: BuyerTrackingIntent, uid: number): BuyerTrackingResult {
  integer(uid); const row = object(raw), identity = object(row.identity), primary = parcel(row), order = object(row.order);
  const entityId = integer(identity.entityId), entityNo = orderDetailId(identity.entityNo);
  if (row.version !== 1 || identity.uid !== uid || identity.kind !== intent.kind || identity.reference !== intent.reference
    || typeof identity.split !== 'boolean' || primary.orderId !== entityNo || order.order_id !== entityNo || order.delivery_type !== 'express'
    || (intent.kind === 'refund' ? identity.split || entityId !== Number(intent.reference) : entityNo !== intent.reference)
    || !Array.isArray(row.packages) || row.packages.length > 50 || !Array.isArray(row.contexts) || row.contexts.length !== row.packages.length) return invalid();
  const packages = row.packages.map(parcel), contexts = row.contexts.map(value => context(value, uid));
  if (new Set(packages.map(item => item.orderId)).size !== packages.length || new Set(contexts.map(item => item.entityId)).size !== contexts.length
    || packages.some((item, index) => contexts[index].orderId !== item.orderId)
    || (!identity.split && (packages.length !== 1 || packages[0].orderId !== entityNo || contexts[0].entityId !== entityId))) return invalid();
  if ([['delivery_id', primary.expressNo], ['delivery_name', primary.expressName], ['delivery_code', primary.expressCode]].some(([key, value]) => order[key!] !== value)) return invalid();
  if (!Array.isArray(row.express) || JSON.stringify(row.express) !== JSON.stringify(primary.traces.map(item => ({ time: item.time, status: item.content })))) return invalid();
  if (!identity.split && JSON.stringify(packages[0]) !== JSON.stringify(primary)) return invalid();
  return { ...primary, version: 1, identity: { ...intent, uid, entityId, entityNo, split: identity.split }, packages, contexts,
    express: primary.traces.map(item => ({ time: item.time, status: item.content })),
    order: { order_id: entityNo, delivery_type: 'express', delivery_id: primary.expressNo, delivery_name: primary.expressName, delivery_code: primary.expressCode } };
}

export interface BuyerTrackingState {
  revision: number; loading: boolean; error: string; copyMessage: string;
  result: BuyerTrackingResult | null; selectedPackageId: string; expanded: boolean;
}
export const initialBuyerTracking = (): BuyerTrackingState => ({ revision: 0, loading: false, error: '', copyMessage: '', result: null, selectedPackageId: '', expanded: false });
export function createBuyerTrackingReader(state: BuyerTrackingState, io: {
  capture(): { uid: number; token: string; current(): boolean };
  read(intent: BuyerTrackingIntent): Promise<unknown>;
  copy(value: string): Promise<void>;
}) {
  let intent: BuyerTrackingIntent | null = null;
  function clear(message = '') {
    state.revision++; state.loading = false; state.result = null; state.error = message;
    state.selectedPackageId = ''; state.copyMessage = ''; state.expanded = false;
  }
  function setRoute(reference: unknown, type?: unknown) {
    clear(); intent = null;
    try { intent = buyerTrackingIntent(reference, type); } catch (error) { state.error = (error as Error).message; }
  }
  function capture() {
    const owner = io.capture(), revision = state.revision, expected = intent;
    return { uid: owner.uid, intent: expected, current: () => !!expected && !!owner.token && owner.uid > 0 && owner.current() && state.revision === revision && intent === expected };
  }
  async function load() {
    if (!intent || state.loading) return;
    clear(); const scope = capture();
    if (!scope.current()) { state.error = '请登录后重新查询物流'; return; }
    state.loading = true;
    try {
      const raw = await io.read(scope.intent!);
      if (!scope.current()) return;
      state.result = parseBuyerTrackingResult(raw, scope.intent!, scope.uid);
      state.selectedPackageId = state.result.packages[0]?.orderId ?? '';
    } catch (error) { if (scope.current()) state.error = (error as Error).message || '物流查询失败，请重新读取'; }
    finally { if (scope.current()) state.loading = false; }
  }
  function selected() {
    if (!capture().current() || !state.result) return null;
    return state.result.packages.find(item => item.orderId === state.selectedPackageId) ?? state.result;
  }
  function select(item: BuyerTrackingPackage) {
    if (capture().current() && state.result?.packages.includes(item)) { state.selectedPackageId = item.orderId; state.copyMessage = ''; state.expanded = false; }
  }
  function details() { const item = selected(); return state.result?.contexts.find(row => row.orderId === item?.orderId) ?? null; }
  async function copy() {
    const item = selected(), scope = capture(); if (!item?.expressNo || !scope.current()) return;
    state.copyMessage = '';
    const current = () => scope.current() && selected() === item;
    try { await io.copy(item.expressNo); if (current()) state.copyMessage = '运单号已复制'; }
    catch { if (current()) state.copyMessage = '复制失败，请手动复制当前运单号'; }
  }
  function expand() { if (selected()) state.expanded = !state.expanded; }
  return { clear, setRoute, load, selected, select, details, copy, expand };
}
