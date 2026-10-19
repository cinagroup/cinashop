/** Preparing a fresh direct-buy selection does not create or pay an order. */
export interface RepurchaseOrder {
    id: number;
    uid: number;
    order_id: string;
    type: number;
    paid: number;
    status: number;
    refund_status: number;
    supplier_allocation_status: number;
    is_del?: number;
    is_system_del?: number;
    cart_info?: unknown[];
}
export type RepurchaseSurface = 'pc' | 'mobile';

/** Both actual PHP templates mount this action only after receipt/completion. */
export function canRepurchaseOrder(order: RepurchaseOrder | null, _surface: RepurchaseSurface): boolean {
    return !!order && Number.isSafeInteger(order.id) && order.id > 0
        && Number.isSafeInteger(order.uid) && order.uid > 0
        && typeof order.order_id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(order.order_id)
        && order.type === 0 && order.paid === 1 && order.refund_status === 0
        && [2, 3].includes(order.status)
        && [0, 2].includes(order.supplier_allocation_status)
        && (order.is_del === undefined || order.is_del === 0)
        && (order.is_system_del === undefined || order.is_system_del === 0)
        && Array.isArray(order.cart_info) && order.cart_info.length > 0 && order.cart_info.length <= 100;
}

export function orderRepurchaseRequest(orderId: unknown): { uni: string } {
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(orderId)) throw Error('再次购买订单标识无效');
    return { uni: orderId };
}

export function repurchaseCartIds(value: unknown, order: Pick<RepurchaseOrder, 'id' | 'order_id'>): readonly number[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('再次购买响应无效');
    const row = value as Record<string, unknown>, ids = row.cartIds;
    if (row.sourceOrderId !== order.order_id || row.sourceRowId !== order.id
        || !Array.isArray(ids) || !ids.length || ids.length > 100
        || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
        || new Set(ids).size !== ids.length || row.cateId !== ids.join(',')) throw Error('再次购买记录不完整或来源不一致');
    return Object.freeze([...ids]);
}

export function initialOrderRepurchase() {
    return { key: '', sourceRowId: 0, pending: false, opening: false, uncertain: false,
        cartIds: [] as readonly number[], error: '' };
}
type State = ReturnType<typeof initialOrderRepurchase>;
interface Scope { uid: number; current(): boolean }
interface IO {
    key(): string;
    capture(): Scope;
    order(): RepurchaseOrder | null;
    busy(): boolean;
    write(orderId: string): Promise<unknown>;
    open(ids: readonly number[]): Promise<void>;
    isRejected(error: unknown): boolean;
}

export function createOrderRepurchase(state: State, surface: RepurchaseSurface, io: IO) {
    let generation = 0;
    function contextChanged() {
        const key = io.key();
        if (state.key === key) return;
        generation++;
        Object.assign(state, initialOrderRepurchase(), { key });
    }
    function bindOrder() {
        contextChanged();
        if (state.sourceRowId && io.order()?.id !== state.sourceRowId) {
            generation++;
            Object.assign(state, initialOrderRepurchase(), { key: io.key() });
        }
    }
    const owned = (key: string, version: number) => generation === version && state.key === key && io.key() === key;
    async function open() {
        contextChanged();
        const key = state.key, version = generation, scope = io.capture(), order = io.order();
        if (!scope.current() || !order || order.uid !== scope.uid || order.id !== state.sourceRowId
            || io.busy() || state.pending || state.opening || state.uncertain || !state.cartIds.length) return;
        const ids = Object.freeze([...state.cartIds]);
        state.opening = true; state.error = '';
        try { await io.open(ids); }
        catch (error) {
            if (owned(key, version) && scope.current()) state.error = '商品已准备，但结算页未打开，请继续进入结算。'
                + (error instanceof Error ? error.message : '');
        } finally { if (owned(key, version)) state.opening = false; }
    }
    async function prepare() {
        contextChanged();
        const key = state.key, version = generation, scope = io.capture(), order = io.order();
        if (!scope.current() || !canRepurchaseOrder(order, surface) || order!.uid !== scope.uid
            || io.busy() || state.pending || state.opening || state.uncertain) return;
        if (state.cartIds.length) return open();
        const source = { id: order!.id, order_id: order!.order_id };
        state.sourceRowId = source.id; state.pending = true; state.error = '';
        try {
            const result = await io.write(source.order_id);
            if (!owned(key, version)) return;
            state.cartIds = repurchaseCartIds(result, source);
        } catch (error) {
            if (!owned(key, version)) return;
            state.uncertain = !io.isRejected(error);
            state.error = state.uncertain ? '准备结果尚未确认，请勿重复操作；本操作不会创建订单或发起付款。'
                : error instanceof Error ? error.message : '当前商品暂不可再次购买，请重新选择';
        } finally { if (owned(key, version)) state.pending = false; }
        // A hidden/refreshed page may retain the acknowledged IDs, but a late
        // response must never navigate a newer view. Explicit continuation reuses IDs.
        if (owned(key, version) && scope.current() && state.cartIds.length) await open();
    }
    return { prepare, open, contextChanged, bindOrder };
}
