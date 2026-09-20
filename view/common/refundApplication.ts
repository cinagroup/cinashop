import { assertOrderDetailIdentity, orderDetailId } from './orderDetailIdentity';
export interface RefundOrder {
    id: number;
    uid: number;
    order_id: string;
    paid: number;
    pay_price: string;
    status: number;
    pid: number;
    supplier_allocation_status: number;
    product_type: number;
    cart_info?: unknown[];
    refund_eligibility?: {
        allowed: boolean;
        reason: string;
    };
}
export interface RefundItem {
    id: number;
    name: string;
    sku: string;
    quantity: number;
    refundable: boolean;
}
export interface RefundForm {
    applyType: number;
    refundReason: string;
    refundExplain: string;
}
export interface RefundBody extends RefundForm {
    cartIds: number[];
}
export function initialRefundApplication<T extends RefundOrder>() {
    return { order: null as T | null, items: [] as RefundItem[], selectedIds: [] as number[],
        form: { applyType: 1, refundReason: '', refundExplain: '' } as RefundForm,
        loading: false, submitting: false, loadError: '', submitError: '', uncertain: false, refundId: 0, revision: 0 };
}
export type RefundState<T extends RefundOrder> = ReturnType<typeof initialRefundApplication<T>>;
export function refundHashId(hash: string): string | null {
    const route = hash.replace(/^#/, ''), index = route.indexOf('?');
    if ((index < 0 ? route : route.slice(0, index)) !== '/pages/order/refundApply')
        return null;
    const ids = new URLSearchParams(index < 0 ? '' : route.slice(index + 1)).getAll('orderId');
    if (hash.length > 8192 || ids.length !== 1)
        throw Error('退款订单链接无效');
    return orderDetailId(ids[0]);
}
function itemsFor(order: RefundOrder): RefundItem[] {
    if (!Array.isArray(order.cart_info) || order.cart_info.length === 0)
        throw Error('订单缺少商品快照，请查看订单核对');
    const ids = new Set<number>();
    return order.cart_info.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw Error('退款商品响应无效');
        const row = value as Record<string, unknown>;
        if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || ids.has(Number(row.id)) || row.oid !== order.id
            || ![row.cart_num, row.refund_num, row.write_times, row.write_surplus_times].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
            || Number(row.cart_num) <= 0 || Number(row.refund_num) > Number(row.cart_num) || (row.is_support_refund !== 0 && row.is_support_refund !== 1))
            throw Error('退款商品与当前订单不一致或响应无效');
        ids.add(Number(row.id));
        let snapshot = row.cart_info;
        if (typeof snapshot === 'string') {
            if (snapshot.length > 262144)
                throw Error('订单商品快照过大');
            snapshot = JSON.parse(snapshot);
        }
        const info = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
        const product = info.product as Record<string, unknown> | undefined, sku = info.sku as Record<string, unknown> | undefined;
        return { id: Number(row.id), name: typeof product?.storeName === 'string' ? product.storeName : '订单商品', sku: typeof sku?.suk === 'string' ? sku.suk : '',
            quantity: Number(row.cart_num), refundable: row.is_support_refund === 1 && Number(row.refund_num) < Number(row.cart_num) && Number(row.write_times) <= Number(row.write_surplus_times) };
    });
}
export function refundBlockReason(order: RefundOrder | null): string {
    if (!order)
        return '请先加载订单';
    if (order.paid !== 1)
        return '订单尚未支付，不能申请退款';
    if (order.status === -2)
        return '订单已取消';
    if (order.pid === -1)
        return '请从拆分后的履约子单申请售后';
    if (order.supplier_allocation_status === 1)
        return '订单正在按供应商分配，请稍后刷新';
    if (order.product_type === 1 && order.refund_eligibility?.allowed !== true)
        return order.refund_eligibility?.reason || '卡密商品退款状态无法确认，请查看订单核对';
    return '';
}
export function createRefundApplication<T extends RefundOrder>(state: RefundState<T>, io: {
    capture(): {
        id: string;
        uid: number;
        current(): boolean;
    };
    read(id: string): Promise<T>;
    write(id: string, body: RefundBody): Promise<unknown>;
    isRejected(error: unknown): boolean;
}) {
    function clear(preserveOutcome = false) {
        const outcome = { uncertain: state.uncertain, refundId: state.refundId, submitError: state.submitError };
        state.revision++;
        state.order = null;
        state.items = [];
        state.selectedIds = [];
        state.loading = false;
        state.submitting = false;
        state.loadError = '';
        state.submitError = '';
        state.uncertain = false;
        state.refundId = 0;
        Object.assign(state.form, { applyType: 1, refundReason: '', refundExplain: '' });
        if (preserveOutcome)
            Object.assign(state, outcome);
    }
    async function load() {
        if (state.loading || state.submitting)
            return;
        clear(true);
        const owner = io.capture(), version = state.revision;
        const current = () => version === state.revision && owner.current();
        if (!owner.current() || !Number.isSafeInteger(owner.uid) || owner.uid <= 0) {
            state.loadError = '请登录后重新加载退款订单';
            return;
        }
        state.loading = true;
        try {
            orderDetailId(owner.id);
            const order = await io.read(owner.id);
            if (!current())
                return;
            assertOrderDetailIdentity(order, owner.id, owner.uid);
            if (![order.id, order.pid, order.supplier_allocation_status, order.product_type, order.status].every(Number.isSafeInteger) || order.id <= 0)
                throw Error('订单退款状态响应无效');
            const items = itemsFor(order);
            state.order = order;
            state.items = items;
        }
        catch (error) {
            if (current())
                state.loadError = error instanceof Error ? error.message : '退款订单读取失败，请重试';
        }
        finally {
            if (current())
                state.loading = false;
        }
    }
    function canSubmit() { return !!state.order && !refundBlockReason(state.order) && !state.loading && !state.submitting && !state.uncertain && !state.refundId && io.capture().current(); }
    function toggle(item: RefundItem) {
        if (!canSubmit() || !state.items.includes(item) || !item.refundable)
            return;
        state.selectedIds = state.selectedIds.includes(item.id) ? state.selectedIds.filter(id => id !== item.id) : [...state.selectedIds, item.id];
    }
    async function submit() {
        if (!canSubmit())
            return;
        const owner = io.capture(), version = state.revision, current = () => version === state.revision && owner.current();
        let body: RefundBody;
        try {
            const ids = [...state.selectedIds];
            if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !state.items.some(item => item.id === id && item.refundable)))
                throw Error('请选择当前订单可退款商品');
            const { applyType } = state.form, refundReason = state.form.refundReason.trim(), refundExplain = state.form.refundExplain.trim();
            if (![1, 2].includes(applyType) || ([1, 3, 4].includes(state.order!.product_type) && applyType !== 1))
                throw Error('该订单退款类型无效');
            if (!refundReason || refundReason.length > 255 || refundExplain.length > 255)
                throw Error('请填写退款原因，原因和说明均不能超过255字');
            body = { applyType, refundReason, refundExplain, cartIds: ids };
        }
        catch (error) {
            state.submitError = error instanceof Error ? error.message : '申请内容无效';
            return;
        }
        state.submitting = true;
        state.submitError = '';
        try {
            const result = await io.write(owner.id, body);
            if (!current())
                return;
            if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isSafeInteger((result as {
                refundId?: unknown;
            }).refundId) || Number((result as {
                refundId?: unknown;
            }).refundId) <= 0)
                throw Error('退款申请回执无效');
            state.refundId = Number((result as {
                refundId: number;
            }).refundId);
        }
        catch (error) {
            if (current()) {
                state.uncertain = !io.isRejected(error);
                const message = error instanceof Error ? error.message : '提交失败';
                state.submitError = state.uncertain ? `申请结果尚未确认，请先核对退款记录，勿重复提交。${message}` : message;
            }
        }
        finally {
            if (current())
                state.submitting = false;
        }
    }
    return { clear, load, canSubmit, toggle, submit };
}
