import { orderDetailId } from './orderDetailIdentity';

export type OrderListFilter = 0 | 1 | 2 | 3 | 4 | undefined;
export interface OrderListRow {
  id: number; uid: number; order_id: string; paid: number; status: number; pay_price: string;
  add_time: number; cart_info?: unknown[]; pid: number; supplier_allocation_status: number;
  shipping_type: number; delivery_type: string; refund_status: number; pay_type?: string;
}
export function orderListFilter(value: unknown): OrderListFilter {
  if (value === undefined) return undefined;
  if ((typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4)
    || (typeof value === 'string' && /^[0-4]$/.test(value))) return Number(value) as OrderListFilter;
  throw Error('订单筛选链接无效，请选择列表状态');
}
export function orderListQuery(query: { status?: unknown; type?: unknown }): OrderListFilter {
  if (query.status !== undefined && query.type !== undefined) throw Error('订单筛选参数重复，请重新选择状态');
  return orderListFilter(query.status !== undefined ? query.status : query.type);
}
export function orderListHash(hash: string): { status: OrderListFilter } | null {
  const value = hash.replace(/^#/, ''), index = value.indexOf('?');
  if ((index < 0 ? value : value.slice(0, index)) !== '/pages/order/list') return null;
  if (hash.length > 8192) throw Error('订单筛选链接无效');
  const query = new URLSearchParams(index < 0 ? '' : value.slice(index + 1));
  if (query.getAll('status').length > 1 || query.getAll('type').length > 1) throw Error('订单筛选参数重复');
  return { status: orderListQuery({ status: query.has('status') ? query.get('status') : undefined, type: query.has('type') ? query.get('type') : undefined }) };
}

export interface OrderListState<T> {
  rows: T[]; status: OrderListFilter; page: number; hasMore: boolean; loading: boolean;
  ready: boolean; error: string; revision: number; refreshRequired: boolean;
}
export function initialOrderList<T>(): OrderListState<T> {
  return { rows: [], status: undefined, page: 0, hasMore: true, loading: false, ready: false, error: '', revision: 0, refreshRequired: false };
}
interface Transport<T> {
  capture(): { uid: number; current(): boolean };
  read(params: { status: OrderListFilter; page: number; limit: number }): Promise<T[]>;
}
const message = (error: unknown) => error instanceof Error ? error.message : '订单读取失败，请重试';

/** Page advances only after validated success. No Vue dependency or cross-account singleton. */
export function createOrderList<T extends OrderListRow>(state: OrderListState<T>, io: Transport<T>, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('订单分页大小无效');
  function clear() {
    state.revision++; state.rows = []; state.page = 0; state.hasMore = true;
    state.loading = false; state.ready = false; state.error = ''; state.refreshRequired = false;
  }
  async function readPage(page: number) {
    if (state.loading || state.refreshRequired) return;
    const owner = io.capture(), revision = state.revision, status = state.status;
    const current = () => owner.current() && state.revision === revision && state.status === status;
    if (!owner.current() || !Number.isSafeInteger(owner.uid) || owner.uid <= 0) { state.error = '请登录后重新加载订单'; return; }
    state.loading = true; state.error = '';
    try {
      const rows = await io.read({ status, page, limit });
      if (!current()) return;
      if (!Array.isArray(rows) || rows.length > limit) throw Error('订单列表响应无效，请重试');
      const ids = new Set<number>(), orderIds = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id <= 0 || row.uid !== owner.uid
          || ![0,1].includes(row.paid) || !Number.isSafeInteger(row.status) || !Number.isSafeInteger(row.add_time) || row.add_time < 0
          || typeof row.pay_price !== 'string' || !/^\d+\.\d{2}$/.test(row.pay_price) || !Number.isSafeInteger(Number(row.pay_price.replace('.', '')))
          || !Array.isArray(row.cart_info)) throw Error('订单列表与当前账号不一致或响应无效，请重新加载');
        orderDetailId(row.order_id);
        if (ids.has(row.id) || orderIds.has(row.order_id)) throw Error('订单列表包含重复记录，请刷新列表');
        ids.add(row.id); orderIds.add(row.order_id);
      }
      if (state.rows.some(row => ids.has(row.id) || orderIds.has(row.order_id))) {
        state.refreshRequired = true;
        throw Error('订单列表已变化，请刷新列表后继续，避免重复或遗漏');
      }
      state.rows = [...state.rows, ...rows]; state.page = page; state.hasMore = rows.length === limit; state.ready = true;
    } catch (error) { if (current()) state.error = message(error); }
    finally { if (current()) state.loading = false; }
  }
  async function refresh(status: OrderListFilter) { clear(); state.status = orderListFilter(status); await readPage(1); }
  async function more() { if (state.hasMore) await readPage(state.page + 1); }
  function owns(row: T) { return state.ready && !state.loading && io.capture().current() && state.rows.includes(row); }
  return { clear, refresh, more, owns };
}

export function customerOrderStatus(order: OrderListRow): string {
  if (order.status === -2) return '已取消';
  if (order.refund_status === 2) return '已退款';
  if ([1,4].includes(order.refund_status)) return '退款处理中';
  if (order.paid === 0) return order.pay_type === 'offline' ? '待线下付款确认' : '待支付';
  if (order.supplier_allocation_status === 1) return '订单分配中';
  if (order.pid === -1) return '已拆分，请查看履约包裹';
  if (order.shipping_type === 2 && [0,5].includes(order.status)) return order.status === 5 ? '部分核销' : '待到店核销';
  if (order.delivery_type === 'send' && [1,5].includes(order.status)) return order.status === 5 ? '部分送达核销' : '配送中，待核销';
  if (order.delivery_type === 'fictitious' && order.status >= 1) return '虚拟商品已交付';
  return ({0:'待发货',1:'待收货',2:'待评价',3:'已完成',4:'部分发货',5:'部分核销'} as Record<number,string>)[order.status] ?? '处理中';
}
export function canReceiveOrder(order: OrderListRow): boolean {
  return order.paid === 1 && order.status === 1 && order.pid !== -1 && order.supplier_allocation_status !== 1
    && order.shipping_type !== 2 && order.delivery_type !== 'send';
}
export function canTrackOrder(order: OrderListRow): boolean {
  return order.paid === 1 && order.status >= 1 && order.delivery_type === 'express' && order.pid !== -1 && order.supplier_allocation_status !== 1;
}
export function canReviewOrder(order: OrderListRow): boolean {
  return order.paid === 1 && order.status === 2 && order.pid !== -1 && order.supplier_allocation_status !== 1;
}
