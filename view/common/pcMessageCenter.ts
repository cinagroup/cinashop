/** Pure PC inbox contract and causal state. No client network, auth or Vue imports. */
export const PC_MESSAGE_PAGE_SIZE = 7 as const;
export const PC_MESSAGE_MAX_INTEGER = 2147483647;
const MAX_BYTES = 1024 * 1024;
export interface PcMessageRow { id: number; title: string; content: string; add_time: number }
export interface PcInboxRow extends PcMessageRow { read_before: boolean }
export interface PcMessageSummary { version: 1; owner_uid: number; unread: number }
export interface PcMessagePage { version: 1; owner_uid: number; query: { page: number; limit: 7 }; list: PcInboxRow[]; count: number; page_count: number; unread_before: number; unread_after: number }
export interface PcMessageDetail { owner_uid: number; id: number; message: PcMessageRow | null; service_num: number }
const invalid = (): never => { throw Error('站内信资料不完整，请重新读取'); };
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid(); return v as Record<string, unknown>; }
function exact(v: Record<string, unknown>, names: string[]) { if (Object.keys(v).sort().join(',') !== [...names].sort().join(',')) invalid(); }
export function pcMessageInteger(v: unknown, minimum = 0): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < minimum || v > PC_MESSAGE_MAX_INTEGER) return invalid(); return v; }
export function pcMessagePageNumber(v: unknown): number { return pcMessageInteger(v, 1); }
function text(v: unknown, maximum: number): string {
  if (typeof v !== 'string' || v.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) return invalid();
  return v;
}
function bounded(value: unknown) { if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw Error('站内信超过完整读取容量'); }
function owned(v: Record<string, unknown>, uid: number) { if (pcMessageInteger(uid, 1) !== v.owner_uid) invalid(); }
function row(value: unknown, inbox = false): PcMessageRow {
  const r = object(value); exact(r, ['id', 'title', 'content', 'add_time', ...(inbox ? ['read_before'] : [])]);
  return { id: pcMessageInteger(r.id, 1), title: text(r.title, 256), content: text(r.content, 65536), add_time: pcMessageInteger(r.add_time) };
}
export function normalizePcMessageSummary(value: unknown, uid: number): PcMessageSummary {
  const v = object(value); bounded(v); exact(v, ['version', 'owner_uid', 'unread']); owned(v, uid); if (v.version !== 1) invalid();
  return { version: 1, owner_uid: uid, unread: pcMessageInteger(v.unread) };
}
export function normalizePcMessagePage(value: unknown, uid: number, page: number): PcMessagePage {
  pcMessagePageNumber(page); const v = object(value); bounded(v); exact(v, ['version', 'owner_uid', 'query', 'list', 'count', 'page_count', 'unread_before', 'unread_after']); owned(v, uid);
  const q = object(v.query); exact(q, ['page', 'limit']); if (v.version !== 1 || q.page !== page || q.limit !== PC_MESSAGE_PAGE_SIZE) invalid();
  const count = pcMessageInteger(v.count), pages = pcMessageInteger(v.page_count), before = pcMessageInteger(v.unread_before), after = pcMessageInteger(v.unread_after);
  if (pages !== Math.ceil(count / PC_MESSAGE_PAGE_SIZE) || !Array.isArray(v.list) || v.list.length !== Math.min(PC_MESSAGE_PAGE_SIZE, Math.max(0, count - (page - 1) * PC_MESSAGE_PAGE_SIZE))) invalid();
  const list = (v.list as unknown[]).map(value => { const r = object(value); if (typeof r.read_before !== 'boolean') invalid(); return { ...row(r, true), read_before: r.read_before as boolean }; });
  if (new Set(list.map(r => r.id)).size !== list.length || list.some((r, i) => i > 0 && !(list[i - 1]!.add_time > r.add_time || list[i - 1]!.add_time === r.add_time && list[i - 1]!.id > r.id))) invalid();
  // A concurrently published message can increase unread_after. It is a fresh
  // server fact, not a client subtraction from the observed page.
  return { version: 1, owner_uid: uid, query: { page, limit: PC_MESSAGE_PAGE_SIZE }, list, count, page_count: pages, unread_before: before, unread_after: after };
}
export function normalizePcMessageDetail(value: unknown, uid: number, id: number): PcMessageDetail {
  pcMessageInteger(id, 1); const v = object(value); bounded(v); exact(v, ['owner_uid', 'id', 'message', 'service_num']); owned(v, uid); if (v.id !== id) invalid();
  const message = v.message === null ? null : row(v.message); if (message && message.id !== id) invalid();
  return { owner_uid: uid, id, message, service_num: pcMessageInteger(v.service_num) };
}
export interface PcMessageBadgeState { unread: number | null; loading: boolean; error: string }
export interface PcMessageOwner { uid: number; token: string | null; generation: number }
interface BadgeTicket { owner: number; causal: number; serial: number; kind: 'summary' | 'consume' }
export function pcMessageBadgeState(): PcMessageBadgeState { return { unread: null, loading: false, error: '' }; }
/** Consuming GETs fence both earlier and overlapping summary snapshots. */
export function createPcMessageBadgeFlow(state: PcMessageBadgeState) {
  let identity = '', owner = 0, causal = 0, serial = 0, consuming = false;
  function clear() { causal++; serial++; consuming = false; Object.assign(state, pcMessageBadgeState()); }
  function bind(value: PcMessageOwner) { const next = JSON.stringify([value.uid, value.token, value.generation]); if (identity !== next) { identity = next; owner++; clear(); } }
  const current = (t: BadgeTicket) => t.owner === owner && t.causal === causal && t.serial === serial;
  function retireSummary() { if (!consuming) { serial++; state.loading = false; } }
  function beginSummary(): BadgeTicket | null { if (consuming || state.loading) return null; state.loading = true; state.error = ''; return { owner, causal, serial: ++serial, kind: 'summary' }; }
  function summary(t: BadgeTicket, unread: number | null, error = '') { if (!current(t) || t.kind !== 'summary' || consuming) return; state.loading = false; if (unread !== null) state.unread = pcMessageInteger(unread); state.error = error; }
  function beginConsume(): BadgeTicket { causal++; consuming = true; state.loading = false; state.error = ''; return { owner, causal, serial: ++serial, kind: 'consume' }; }
  function consumed(t: BadgeTicket, unread: number | null) { if (!current(t) || t.kind !== 'consume') return; causal++; serial++; consuming = false; state.unread = unread === null ? null : pcMessageInteger(unread); state.error = unread === null ? '阅读结果未确认，可只读核对未读数' : ''; }
  return { bind, clear, retireSummary, beginSummary, summary, beginConsume, consumed };
}
export interface PcMessagePageState { result: PcMessagePage | null; loading: boolean; requestedPage: number; failedPage: number; error: string; detailId: number; detail: PcMessageRow | null; detailLoading: boolean; detailLoaded: boolean; detailError: string }
export function pcMessagePageState(): PcMessagePageState { return { result: null, loading: false, requestedPage: 1, failedPage: 0, error: '', detailId: 0, detail: null, detailLoading: false, detailLoaded: false, detailError: '' }; }
/** Replacement pagination keeps the last successful page while a target fails. */
export function createPcMessagePageFlow(state: PcMessagePageState) {
  let epoch = 0, detailEpoch = 0;
  function closeDetail() { detailEpoch++; Object.assign(state, { detailId: 0, detail: null, detailLoading: false, detailLoaded: false, detailError: '' }); }
  function clear() { epoch++; closeDetail(); Object.assign(state, pcMessagePageState()); }
  function beginPage(page: number) { pcMessagePageNumber(page); if (state.loading || state.detailLoading) return null; closeDetail(); state.loading = true; state.requestedPage = page; state.failedPage = 0; state.error = ''; return { epoch: ++epoch, page }; }
  function pageCurrent(t: { epoch: number }) { return t.epoch === epoch; }
  function pageSuccess(t: { epoch: number; page: number }, data: PcMessagePage) { if (pageCurrent(t)) { state.result = data; state.loading = false; state.failedPage = 0; state.error = ''; } }
  function pageFailure(t: { epoch: number; page: number }, error: string) { if (pageCurrent(t)) { state.loading = false; state.failedPage = t.page; state.error = error; } }
  function beginDetail(id: number) { pcMessageInteger(id, 1); if (state.loading || state.detailLoading || state.error || !state.result?.list.some(r => r.id === id)) return null; closeDetail(); state.detailId = id; state.detailLoading = true; return { epoch, detailEpoch: ++detailEpoch, id }; }
  const detailCurrent = (t: { epoch: number; detailEpoch: number; id: number }) => t.epoch === epoch && t.detailEpoch === detailEpoch && t.id === state.detailId;
  function detailSuccess(t: { epoch: number; detailEpoch: number; id: number }, value: PcMessageRow | null) { if (detailCurrent(t)) { state.detail = value; state.detailLoading = false; state.detailLoaded = true; } }
  function detailFailure(t: { epoch: number; detailEpoch: number; id: number }, error: string) { if (detailCurrent(t)) { state.detail = null; state.detailLoading = false; state.detailLoaded = false; state.detailError = error; } }
  return { clear, closeDetail, beginPage, pageCurrent, pageSuccess, pageFailure, beginDetail, detailCurrent, detailSuccess, detailFailure };
}
