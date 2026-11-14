import { orderDetailId } from './orderDetailIdentity';
import { buyerInvoiceDraft, buyerInvoiceQuery, parseBuyerInvoiceAck, parseBuyerInvoiceOrder, parseBuyerInvoicePage, validateBuyerInvoiceDraft,
  type BuyerInvoiceAction, type BuyerInvoiceDraft, type BuyerInvoiceOrder, type BuyerInvoicePage, type BuyerInvoiceQuery, type BuyerInvoiceRecord, type BuyerInvoiceTitle } from './buyerInvoices';

export interface BuyerInvoiceSession { uid: number; token: string; current(): boolean }
export interface BuyerInvoiceFlowState {
  page: BuyerInvoicePage | null; order: BuyerInvoiceOrder | null; draft: BuyerInvoiceDraft | null;
  kind: 'titles' | 'records'; loading: boolean; busy: boolean; uncertain: boolean; error: string; message: string;
}
export function initialBuyerInvoiceFlow(): BuyerInvoiceFlowState {
  return { page: null, order: null, draft: null, kind: 'records', loading: false, busy: false, uncertain: false, error: '', message: '' };
}
export function buyerInvoiceReference(value: unknown): string { const id = orderDetailId(value); if (id.length > 50) throw Error('订单链接无效，请返回订单列表'); return id; }
export function buyerInvoiceParameters(params: URLSearchParams, order: boolean): string | null {
  if ([...params.keys()].some(k => k !== 'orderId') || (order ? params.getAll('orderId').length !== 1 : params.size !== 0)) throw Error('发票链接无效，请重新进入');
  return order ? buyerInvoiceReference(params.get('orderId')) : null;
}
export const invoiceStateText = (r: BuyerInvoiceRecord) => r.state === -1 ? '开票被拒绝' : r.state === 1 ? '已开票' : r.paid ? '待开票' : '待支付，待开票';
export const invoiceTypeText = (r: { type: number; headerType: number }) => `${r.headerType === 1 ? '个人' : '企业'} · ${r.type === 2 ? '增值税专用发票' : '普通发票'}`;
interface Dependencies {
  capture(): BuyerInvoiceSession;
  page(query: BuyerInvoiceQuery): Promise<unknown>;
  order(reference: string): Promise<unknown>;
  save(draft: BuyerInvoiceDraft): Promise<unknown>;
  remove(id: number, revision: string): Promise<unknown>;
  setDefault(id: number, revision: string): Promise<unknown>;
  apply(order: BuyerInvoiceOrder, title: BuyerInvoiceTitle): Promise<unknown>;
  confirm(message: string): Promise<boolean>;
}
const message = (e: unknown) => e instanceof Error ? e.message : '发票资料读取失败，请重试';

/** In-memory lifecycle fencing only. No taxpayer, bank or contact data is
 * persisted. A request with no current acknowledgement is never replayed. */
export function createBuyerInvoiceFlow(state: BuyerInvoiceFlowState, dep: Dependencies) {
  let epoch = 0, reference: string | null = null, validRoute = false, cursor: string | null = null, previous: Array<string | null> = [];
  let pending: { inFlight: boolean; uid: number; token: string } | null = null;
  function clear(error = '') {
    epoch++; state.page = null; state.order = null; state.draft = null; state.loading = false; state.busy = false;
    state.uncertain = pending !== null; state.error = error; state.message = '';
  }
  function capture() { const session = dep.capture(), generation = epoch; return { ...session, current: () => validRoute && epoch === generation && session.current() }; }
  function authenticated(s: BuyerInvoiceSession) { return Number.isInteger(s.uid) && s.uid > 0 && !!s.token && s.current(); }
  function setRoute(value: unknown, order: boolean) {
    clear(); cursor = null; previous = []; validRoute = false;
    try { reference = order ? buyerInvoiceReference(value) : null; state.kind = order ? 'titles' : 'records'; validRoute = true; }
    catch (e) { reference = null; state.error = message(e); }
  }
  async function load() {
    if (!validRoute) return; clear(); const s = capture();
    if (!authenticated(s)) { state.error = '请先登录后查看发票'; return; }
    const route = reference, query = buyerInvoiceQuery(route ? 'titles' : state.kind, cursor); state.loading = true;
    try {
      const order = route ? parseBuyerInvoiceOrder(await dep.order(route), route, s.uid) : null;
      if (!s.current()) return;
      const page = !order || order.canApply ? parseBuyerInvoicePage(await dep.page(query), query, s.uid) : null;
      if (!s.current()) return;
      state.order = order; state.page = page;
      if (pending) {
        if (pending.inFlight) { state.uncertain = true; state.message = '上次请求仍在处理中，请稍后刷新核对'; }
        else { pending = null; state.uncertain = false; state.message = '上次请求结果未确认，已重新读取当前资料；请核对后再操作'; }
      }
    } catch (e) { if (s.current()) { state.page = null; state.order = null; state.error = message(e); } }
    finally { if (s.current()) state.loading = false; }
  }
  async function selectKind(kind: 'titles' | 'records') {
    if (reference || state.busy || state.loading || !dep.capture().current()) return;
    state.kind = kind; cursor = null; previous = []; await load();
  }
  async function next() {
    const value = state.page?.nextCursor; if (!value || state.loading || state.busy || previous.includes(value) || previous.length >= 100) return;
    previous.push(cursor); cursor = value; await load();
  }
  async function back() { if (!previous.length || state.loading || state.busy) return; cursor = previous.pop() ?? null; await load(); }
  function titles(): BuyerInvoiceTitle[] { return state.page?.query.kind === 'titles' ? state.page.items as BuyerInvoiceTitle[] : []; }
  function records(): BuyerInvoiceRecord[] { return state.page?.query.kind === 'records' ? state.page.items as BuyerInvoiceRecord[] : []; }
  const ready = () => !state.loading && !state.busy && !state.uncertain && !pending && !!state.page && authenticated(capture());
  function edit(title?: BuyerInvoiceTitle) {
    if (!ready() || (title && !titles().includes(title))) return;
    state.draft = buyerInvoiceDraft(title); state.message = ''; state.error = '';
  }
  function closeForm() { if (!state.busy) state.draft = null; }
  async function write(action: BuyerInvoiceAction, invoke: () => Promise<unknown>, expectedId?: number) {
    if (!ready()) return; const s = capture(); const mark = { inFlight: true, uid: s.uid, token: s.token }; pending = mark;
    epoch++; const generation = epoch;
    // s.current includes the preceding generation; retain the session guard
    // separately after deliberately advancing this write generation.
    const guard = dep.capture(), active = () => validRoute && epoch === generation && guard.uid === s.uid && guard.token === s.token && guard.current();
    state.busy = true; state.error = ''; state.message = '';
    let accepted = false;
    try { parseBuyerInvoiceAck(await invoke(), action, s.uid, expectedId); accepted = true; }
    catch (e) { if (active()) state.error = message(e); }
    finally {
      mark.inFlight = false;
      if (active()) {
        const failure = state.error; state.busy = false; state.draft = null;
        if (accepted) pending = null;
        cursor = null; previous = []; const refresh = load(), refreshEpoch = epoch; await refresh;
        if (epoch === refreshEpoch && guard.current() && validRoute && !state.error) {
          if (accepted) state.message = action === 'apply' ? '开票申请已提交，请以开票记录状态为准' : action === 'save' ? '抬头已保存' : action === 'delete' ? '抬头已删除' : '同类抬头的默认项已更新';
          else state.message = `${failure || '请求结果未确认'}；已重新读取当前资料，请核对后再操作`;
        }
      }
    }
  }
  async function save() {
    if (!ready() || !state.draft) return; let draft: BuyerInvoiceDraft;
    try { draft = validateBuyerInvoiceDraft(state.draft); } catch (e) { state.error = message(e); return; }
    await write('save', () => dep.save(draft), draft.id || undefined);
  }
  async function remove(title: BuyerInvoiceTitle) {
    if (!ready() || !titles().includes(title)) return; const s = capture();
    if (!await dep.confirm(`确认删除抬头“${title.name}”？已有订单的开票快照会保留。`).catch(() => false)) return;
    if (!s.current() || !ready() || !titles().includes(title)) return;
    await write('delete', () => dep.remove(title.id, title.revision), title.id);
  }
  async function setDefault(title: BuyerInvoiceTitle) { if (ready() && titles().includes(title)) await write('default', () => dep.setDefault(title.id, title.revision), title.id); }
  async function apply(title: BuyerInvoiceTitle) {
    const order = state.order;
    if (!ready() || !order?.canApply || !titles().includes(title) || (title.type === 2 && !order.capabilities.special)) return;
    try { validateBuyerInvoiceDraft(buyerInvoiceDraft(title)); } catch (e) { state.error = `请先编辑完整的开票抬头：${message(e)}`; return; }
    const s = capture();
    if (!await dep.confirm(`订单 ${order.orderNo}，金额 ¥${order.amount}，使用抬头“${title.name}”提交开票申请？`).catch(() => false)) return;
    if (!s.current() || !ready() || state.order !== order || !titles().includes(title)) return;
    await write('apply', () => dep.apply(order, title));
  }
  return { clear, setRoute, load, selectKind, next, back, titles, records, edit, closeForm, save, remove, setDefault, apply,
    canBack: () => previous.length > 0, reference: () => reference };
}
