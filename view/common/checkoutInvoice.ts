import { buyerInvoiceQuery, parseBuyerInvoicePage, type BuyerInvoicePage, type BuyerInvoiceQuery, type BuyerInvoiceTitle } from './buyerInvoices';
import type { BuyerInvoiceSession } from './buyerInvoiceFlow';
export interface CheckoutInvoiceState { page: BuyerInvoicePage | null; selected: BuyerInvoiceTitle | null; required: boolean; loading: boolean; error: string; canBack: boolean }
export const initialCheckoutInvoice = (): CheckoutInvoiceState => ({ page: null, selected: null, required: false, loading: false, error: '', canBack: false });
export function createCheckoutInvoice(state: CheckoutInvoiceState, dep: {
  capture(): BuyerInvoiceSession; canEdit(): boolean; page(query: BuyerInvoiceQuery): Promise<unknown>;
}) {
  let epoch = 0, cursor: string | null = null, history: Array<string | null> = [];
  function clear(preserveChoice = false) {
    epoch++; state.page = null; state.selected = null; state.loading = false; state.error = ''; state.canBack = false;
    if (!preserveChoice) state.required = false;
  }
  const session = () => { const s = dep.capture(), generation = epoch; return { ...s, current: () => generation === epoch && s.current() }; };
  const authenticated = (s: BuyerInvoiceSession) => Number.isInteger(s.uid) && s.uid > 0 && !!s.token && s.current();
  function titles() { return state.page?.query.kind === 'titles' ? state.page.items as BuyerInvoiceTitle[] : []; }
  async function load(nextCursor: string | null = null) {
    clear(true); cursor = nextCursor; state.canBack = history.length > 0;
    const s = session(); if (!authenticated(s)) return;
    const query = buyerInvoiceQuery('titles', cursor); state.loading = true;
    try { const page = parseBuyerInvoicePage(await dep.page(query), query, s.uid); if (s.current()) state.page = page; }
    catch (e) { if (s.current()) state.error = e instanceof Error ? e.message : '发票抬头读取失败，请重试'; }
    finally { if (s.current()) state.loading = false; }
  }
  function select(title: BuyerInvoiceTitle | null) {
    if (!dep.canEdit() || state.loading || !authenticated(session())) return;
    if (title && (!titles().includes(title) || !state.page?.capabilities.enabled || title.type === 2 && !state.page.capabilities.special)) return;
    state.required = !!title; state.selected = title;
  }
  const ready = () => !state.required || !!state.selected && authenticated(session()) && titles().includes(state.selected)
    && !!state.page?.capabilities.enabled && (state.selected.type !== 2 || state.page.capabilities.special);
  const options = () => state.required && ready() && state.selected ? { invoiceId: state.selected.id, invoiceRevision: state.selected.revision } : {};
  async function refresh() { history = []; await load(); }
  async function next() { const n = state.page?.nextCursor; if (!n || state.loading || !dep.canEdit() || history.includes(n) || history.length >= 100) return; history.push(cursor); await load(n); }
  async function back() { if (!history.length || state.loading || !dep.canEdit()) return; await load(history.pop() ?? null); }
  return { clear, load: refresh, next, back, select, titles, ready, options };
}
