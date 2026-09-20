import { parseRefundDetail, parseRefundPage, refundableCancellation, refundQuery,
  type RefundFilter, type RefundQuery, type RefundRecord, type RefundRecordDetail } from './refundRecords';
import { initialReturnState, parseReturnCarriers, parseReturnUpload, prepareReturn, matchesReturned, returnEligible, type ReturnBody } from './refundReturn';

export function initialRefundReader(limit = 20) {
  return { items: [] as RefundRecord[], detail: null as RefundRecordDetail | null, loading: false, ready: false,
    error: '', cursor: null as string | null, filter: 'all' as RefundFilter, q: '', limit, revision: 0,
    operating: false, dispatched: false, operationError: '', cancelOutcome: null as 'unknown' | 'success' | null, shipment: initialReturnState() };
}
export type RefundReaderState = ReturnType<typeof initialRefundReader>;
export function createRefundReader(state: RefundReaderState, mode: 'list' | 'detail', io: {
  capture(): { uid: number; id: number; current(): boolean };
  page(query: RefundQuery): Promise<unknown>; detail(id: number): Promise<unknown>;
  confirm(): Promise<boolean>; cancel(id: number): Promise<unknown>; isRejected(error: unknown): boolean;
  carriers(): Promise<unknown>; returnExpress(body: ReturnBody): Promise<unknown>;
}) {
  function clear(preserveOutcome = false) {
    const outcome = state.dispatched ? 'unknown' : state.cancelOutcome;
    const shipment = state.shipment, returnOutcome = shipment.dispatched ? 'unknown' : shipment.outcome;
    const error = state.dispatched ? '撤销结果尚未确认，请重新读取退款详情，勿重复操作。'
      : shipment.dispatched ? '物流提交结果尚未确认，请重新读取详情，勿重复操作。' : state.operationError;
    state.revision++; state.items = []; state.detail = null; state.loading = false; state.ready = false; state.error = ''; state.cursor = null;
    state.operating = false; state.dispatched = false; state.cancelOutcome = preserveOutcome ? outcome : null; state.operationError = preserveOutcome ? error : '';
    state.shipment = initialReturnState();
    if (preserveOutcome && returnOutcome) { state.shipment.outcome = returnOutcome; state.shipment.pending = shipment.pending; }
  }
  const currentView = () => io.capture().current() && state.ready && !state.loading && !state.error && !state.operating;
  const canOpen = (row: RefundRecord) => mode === 'list' && currentView() && state.items.includes(row);
  const canCancel = () => mode === 'detail' && currentView() && !!state.detail && !state.cancelOutcome && state.shipment.outcome !== 'unknown' && refundableCancellation(state.detail);
  const canReturn = () => mode === 'detail' && currentView() && returnEligible(state.detail) && !state.cancelOutcome
    && !state.shipment.outcome && state.shipment.carriersReady;
  async function load(append = false) {
    if (state.loading || state.operating || (append && (mode !== 'list' || !state.ready || !state.cursor))) return;
    if (!append) clear(true);
    const owner = io.capture(), revision = state.revision, current = () => revision === state.revision && owner.current();
    if (!owner.current() || !Number.isSafeInteger(owner.uid) || owner.uid <= 0) { state.error = '请登录后读取退款记录'; return; }
    state.loading = true; state.error = '';
    try {
      if (mode === 'list') {
        const query = refundQuery(state.filter, state.q, state.limit, append ? state.cursor : null);
        const value = await io.page(query); if (!current()) return;
        const page = parseRefundPage(value, owner.uid, query, append ? state.items : []);
        state.items = append ? [...state.items, ...page.items] : page.items; state.cursor = page.nextCursor;
      } else {
        const value = await io.detail(owner.id); if (!current()) return;
        const detail = parseRefundDetail(value, owner.uid, owner.id); state.detail = detail;
        if (state.cancelOutcome && detail.isCancel === 1) { state.cancelOutcome = 'success'; state.operationError = ''; }
        else if (state.cancelOutcome) state.operationError = '撤销结果尚未在当前记录中确认，请稍后重新读取，勿重复操作。';
        if (state.shipment.pending) {
          if (matchesReturned(detail, state.shipment.pending)) { state.shipment.outcome = 'success'; state.operationError = ''; }
          else { state.shipment.outcome = 'unknown'; state.operationError = '物流提交结果尚未在当前记录中确认，请稍后重新读取，勿重复操作。'; }
        }
        if (returnEligible(detail) && !state.shipment.outcome) {
          try {
            const carriers = await io.carriers(); if (!current()) return;
            state.shipment.carriers = parseReturnCarriers(carriers); state.shipment.carriersReady = true;
            if (!state.shipment.carriers.length) state.shipment.carriersError = '暂无可用快递公司，请联系商家';
          } catch (error) { if (current()) state.shipment.carriersError = error instanceof Error ? error.message : '快递公司读取失败，请重新读取详情'; }
        }
      }
      state.ready = true;
    } catch (error) { if (current()) state.error = error instanceof Error ? error.message : '退款记录读取失败，请重试'; }
    finally { if (current()) state.loading = false; }
  }
  async function uploadImage(pickAndUpload: (current: () => boolean) => Promise<unknown | null>) {
    if (!canReturn() || state.shipment.form.images.length >= 3) return;
    const owner = io.capture(), current = () => owner.current();
    state.operating = true; state.operationError = '';
    try {
      const raw = await pickAndUpload(current); if (!current() || raw === null) return;
      const image = parseReturnUpload(raw);
      if (state.shipment.form.images.some(value => value.url === image.url)) throw Error('该凭证已添加');
      state.shipment.form.images.push(image);
    } catch (error) { if (current()) state.operationError = error instanceof Error ? error.message : '凭证上传失败，请重试'; }
    finally { if (current()) state.operating = false; }
  }
  function removeImage(index: number) {
    if (canReturn() && Number.isInteger(index) && index >= 0 && index < state.shipment.form.images.length) state.shipment.form.images.splice(index, 1);
  }
  async function submitReturn() {
    if (!canReturn()) return;
    const owner = io.capture(), current = () => owner.current();
    state.operationError = '';
    let body: ReturnBody;
    try { body = prepareReturn(state.shipment.form, state.shipment.carriers, state.detail!.id); }
    catch (error) { state.operationError = (error as Error).message; return; }
    state.operating = true; state.shipment.pending = body; state.shipment.dispatched = true;
    let received = false;
    try {
      const result = await io.returnExpress(body); if (!current()) return;
      if (result !== null) throw Error('物流提交回执无效');
      state.shipment.outcome = 'unknown'; received = true;
    } catch (error) { if (current()) {
      if (io.isRejected(error)) { state.shipment.pending = null; state.shipment.outcome = null; }
      else state.shipment.outcome = 'unknown';
      state.operationError = state.shipment.outcome ? '物流提交结果尚未确认，请重新读取详情，勿重复操作。' : error instanceof Error ? error.message : '物流提交失败';
    } } finally { if (current()) { state.operating = false; state.shipment.dispatched = false; } }
    if (received && current()) await load();
  }
  async function cancel() {
    if (!canCancel()) return;
    const owner = io.capture(), revision = state.revision, id = state.detail!.id, current = () => revision === state.revision && owner.current();
    state.operating = true; state.operationError = ''; let confirmed = false;
    try {
      if (!await io.confirm() || !current()) return;
      if (!state.detail || state.detail.id !== id || !refundableCancellation(state.detail)) return;
      state.dispatched = true;
      const result = await io.cancel(id); if (!current()) return;
      if (result !== null) throw Error('撤销回执无效');
      state.cancelOutcome = 'success'; confirmed = true;
    } catch (error) { if (current()) {
      if (state.dispatched && !io.isRejected(error)) state.cancelOutcome = 'unknown';
      const message = error instanceof Error ? error.message : '撤销失败';
      state.operationError = state.cancelOutcome === 'unknown' ? `撤销结果尚未确认，请先重新读取详情，勿重复操作。${message}` : message;
    } } finally { if (current()) { state.operating = false; state.dispatched = false; } }
    if (confirmed && current()) await load();
  }
  return { clear, load, canOpen, canCancel, cancel, currentView, canReturn, uploadImage, removeImage, submitReturn };
}
