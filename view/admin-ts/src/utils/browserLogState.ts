export const BROWSER_LOG_CAPACITY = 500;
export const BROWSER_LOG_LEVELS = ['info', 'success', 'warning', 'error'] as const;
export type BrowserLogLevel = typeof BROWSER_LOG_LEVELS[number];
export type BrowserLogSource = 'application' | 'vue' | 'http' | 'network';
export interface BrowserLogRow {
  id: number; at: number; type: BrowserLogLevel; message: string; page: string;
  path: string; source: BrowserLogSource; httpStatus: number | null; method: string | null;
}
export interface BrowserLogTicket { readonly epoch: number; readonly clear: number; readonly path: string }
export interface BrowserLogView { readonly generation: number }
export interface BrowserLogDependencies {
  valid(): boolean; route(): string | null; now(): number; pages: ReadonlyMap<string, string>;
}
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const messages: Record<BrowserLogLevel, string> = { info: '应用信息记录', success: '操作完成记录', warning: '应用警告记录', error: '应用错误记录' };
export const browserLogLevelLabel = (level: BrowserLogLevel) => ({ info: '信息', success: '成功', warning: '警告', error: '错误' })[level];
export function browserLogLocalTime(at: number) {
  const date = new Date(at), pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function browserLogDetail(row: BrowserLogRow) {
  if (row.source === 'vue') return '页面运行时发生异常。可刷新页面；若刚提交过操作，请先核对结果。';
  if (row.source === 'network') return '请求未完成，操作结果可能尚未确认。请回到原页面核对，避免重复提交。';
  if (row.source === 'http') return `请求返回 HTTP ${row.httpStatus}。请回到原页面处理提示；此记录不代表操作已成功或已回滚。`;
  return '应用主动记录的状态摘要；具体业务结果请以原页面的确认信息为准。';
}

/** Per-tab memory only. Never accepts error messages, URLs, user data or meta. */
export function browserLogState(deps: BrowserLogDependencies, wrap: <T extends object>(value: T) => T = value => value) {
  const pages = new Map([...deps.pages].filter(([path, title]) => typeof path === 'string' && /^\/[A-Za-z0-9_:/().?*-]*$/u.test(path) && !path.includes('*') && typeof title === 'string' && [...title].length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/u.test(title)));
  const state = wrap({ epoch: 0, revision: 0, viewerRevision: 0, enabled: false, rows: [] as BrowserLogRow[], dropped: 0,
    filter: 'all' as BrowserLogLevel | 'all', page: 1, notice: '',
    detail: null as { serial: number; row: BrowserLogRow } | null,
    confirmation: null as { serial: number; lastId: number; count: number } | null });
  let active = true, serial = 0, sequence = 0, clear = 0, viewer: BrowserLogView | null = null;
  const issued = new WeakSet<object>();
  const valid = () => { try { return active && state.enabled && deps.valid(); } catch { return false; } };
  function reset() {
    state.epoch++; state.revision++; clear++; state.rows = []; state.dropped = 0;
    state.filter = 'all'; state.page = 1; state.notice = ''; state.detail = state.confirmation = null;
    try { state.enabled = active && deps.valid(); } catch { state.enabled = false; }
  }
  function begin(): BrowserLogTicket | null {
    if (!valid()) return null;
    let path: string | null; try { path = deps.route(); } catch { return null; }
    if (!path || !pages.has(path)) return null;
    const ticket = Object.freeze({ epoch: state.epoch, clear, path }); issued.add(ticket); return ticket;
  }
  const current = (ticket: BrowserLogTicket | null): ticket is BrowserLogTicket => !!ticket && issued.has(ticket) && valid() && ticket.epoch === state.epoch && ticket.clear === clear;
  function record(ticket: BrowserLogTicket | null, type: unknown, source: unknown, httpStatus: unknown = null, method: unknown = null) {
    if (!current(ticket) || !BROWSER_LOG_LEVELS.includes(type as BrowserLogLevel) || typeof source !== 'string' || !['application', 'vue', 'http', 'network'].includes(source)) return false;
    if (source === 'vue' && ticket.path === '/system/frontend-log') return false;
    if (source === 'http' ? typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599 : httpStatus !== null) return false;
    if (method !== null && (typeof method !== 'string' || !methods.has(method))) return false;
    if ((source === 'application' || source === 'vue') && method !== null) return false;
    let at: number; try { at = deps.now(); } catch { return false; }
    if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000 || sequence >= Number.MAX_SAFE_INTEGER) return false;
    const level = type as BrowserLogLevel, origin = source as BrowserLogSource;
    const row: BrowserLogRow = Object.freeze({ id: ++sequence, at, type: level, source: origin, path: ticket.path, page: pages.get(ticket.path)!,
      message: origin === 'vue' ? '页面运行异常' : origin === 'http' || origin === 'network' ? '数据请求异常' : messages[level], httpStatus: httpStatus as number | null, method: method as string | null });
    state.rows = [...state.rows, row];
    if (state.rows.length > BROWSER_LOG_CAPACITY) { state.rows = state.rows.slice(-BROWSER_LOG_CAPACITY); state.dropped = Math.min(Number.MAX_SAFE_INTEGER, state.dropped + 1); }
    if (state.detail && !state.rows.some(item => item.id === state.detail!.row.id)) state.detail = null;
    state.page = Math.min(state.page, pageCount()); state.notice = ''; state.revision++; return true;
  }
  const filtered = () => state.rows.filter(row => state.filter === 'all' || row.type === state.filter);
  const pageCount = () => Math.max(1, Math.ceil(filtered().length / 20));
  const rows = () => filtered().slice((state.page - 1) * 20, state.page * 20);
  const counts = () => Object.fromEntries(BROWSER_LOG_LEVELS.map(type => [type, state.rows.filter(row => row.type === type).length])) as Record<BrowserLogLevel, number>;
  function openView(): BrowserLogView {
    const lease = Object.freeze({ generation: ++state.viewerRevision }); viewer = lease;
    state.detail = state.confirmation = null; state.filter = 'all'; state.page = 1; state.notice = ''; return lease;
  }
  function closeView(lease: BrowserLogView | null | undefined) {
    if (!lease || viewer !== lease) return;
    viewer = null; state.viewerRevision++; state.detail = state.confirmation = null;
  }
  function pageControls() {
    const epoch = state.epoch, revision = state.revision, view = state.viewerRevision;
    const admitted = () => valid() && epoch === state.epoch && revision === state.revision && view === state.viewerRevision;
    return [{ key: epoch, filter: (value: unknown) => { if (!admitted() || value !== 'all' && !BROWSER_LOG_LEVELS.includes(value as BrowserLogLevel)) return; state.filter = value as typeof state.filter; state.page = 1; state.detail = state.confirmation = null; state.revision++; },
      move: (delta: number) => { if (!admitted() || ![-1, 1].includes(delta)) return; state.page = Math.min(pageCount(), Math.max(1, state.page + delta)); state.detail = state.confirmation = null; state.revision++; },
      clear: () => { if (!admitted() || !state.rows.length) return; state.detail = null; state.confirmation = { serial: ++serial, lastId: state.rows.at(-1)!.id, count: state.rows.length }; } }];
  }
  function rowControls(row: BrowserLogRow) {
    const epoch = state.epoch, revision = state.revision, view = state.viewerRevision;
    return { key: `${epoch}:${row.id}`, row, view: () => { if (valid() && epoch === state.epoch && revision === state.revision && view === state.viewerRevision && state.rows.includes(row)) { state.confirmation = null; state.detail = { serial: ++serial, row: { ...row } }; } } };
  }
  function detailControls() {
    const detail = state.detail, epoch = state.epoch, revision = state.revision, view = state.viewerRevision;
    return detail ? [{ key: `${epoch}:${detail.serial}`, row: detail.row, close: () => { if (valid() && epoch === state.epoch && revision === state.revision && view === state.viewerRevision && state.detail === detail) state.detail = null; } }] : [];
  }
  function confirmationControls() {
    const confirmation = state.confirmation, epoch = state.epoch, revision = state.revision, view = state.viewerRevision;
    const admitted = () => valid() && epoch === state.epoch && revision === state.revision && view === state.viewerRevision && state.confirmation === confirmation;
    return confirmation ? [{ key: `${epoch}:${confirmation.serial}`, count: confirmation.count, cancel: () => { if (admitted()) state.confirmation = null; }, confirm: () => {
      if (!admitted()) return; const count = state.rows.filter(row => row.id <= confirmation.lastId).length;
      state.rows = state.rows.filter(row => row.id > confirmation.lastId); clear++; state.revision++; state.page = 1; state.dropped = 0; state.detail = state.confirmation = null;
      state.notice = `已清除 ${count} 条日志${state.rows.length ? '，较新的记录已保留' : ''}`;
    } }] : [];
  }
  function dispose() { active = false; reset(); }
  reset();
  return { state, reset, dispose, begin, record, current, rows, filtered, counts, pageCount, openView, closeView, pageControls, rowControls, detailControls, confirmationControls };
}
export type BrowserLogModel = ReturnType<typeof browserLogState>;
