import { ensureAction, ensureCatalog, ensureName, ensureDescription, ensureImage, ensureSort, ensurePreview, ensureObject, ensureOnly, ensureInteger, ensureText, ensurePayloadHash, ensureReceipt, newEnsureValues,
  type EnsureAction, type EnsureCatalog, type EnsureOperation, type EnsurePayload, type EnsureRow } from '../../../common/ensureAuthor';
import { isAxiosError } from 'axios';
interface Category { id: number; pid: number; name: string }
interface ImageOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }
interface Gallery { serial: number; revision: number; request: number; page: number; pid: number; name: string; loading: boolean; error: string; list: ImageOption[]; categories: Category[]; count: number }
interface Editor { serial: number; version: number; row: EnsureRow | null; draft: EnsurePayload; rawSort: string; imagePreview: string; failedPreview: string }
export interface EnsureAuthorDependencies {
 identity(): string; actor(): number; view(): boolean; manage(): boolean;
 read(signal: AbortSignal): Promise<unknown>; write(a: EnsureAction, signal: AbortSignal): Promise<unknown>;
 categories(signal: AbortSignal): Promise<unknown>; options(query: { page: number; limit: number; pid: number; name: string }, signal: AbortSignal): Promise<unknown>;
 receipt(a: EnsureAction, signal: AbortSignal): Promise<unknown>; resolve(a: EnsureAction, signal: AbortSignal): Promise<unknown>;
 changed?(): void;
 readPending(actor: number): unknown; persist(actor: number, a: EnsureAction | null, expected?: EnsureAction): void;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function message(error: unknown): string {
 if (isAxiosError(error)) {
  const body: unknown = error.response?.data;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
   const msg = (body as Record<string, unknown>).msg;
   if (typeof msg === 'string' && msg.trim()) return msg;
  }
 }
 return error instanceof Error ? error.message : '商品保障请求失败';
}
const status = (error: unknown) => Number((error as { status?: unknown; response?: { status?: unknown } })?.status ?? (error as { response?: { status?: unknown } })?.response?.status);
export function ensureAuthorState(deps: EnsureAuthorDependencies, wrap: <T extends object>(v: T) => T = v => v) {
 const state = wrap({ epoch: 0, source: 0, snapshot: null as EnsureCatalog | null, loading: false, busy: false, error: '', notice: '',
  pending: null as EnsureAction | null, pendingError: '', retryReady: false, filters: { draft: '', keyword: '', page: 1 }, editor: null as Editor | null,
  previewErrors: {} as Record<string, boolean>, gallery: null as Gallery | null, confirmation: null as { serial: number; operation: EnsureOperation; id: number; payload: Record<string, unknown>; revision: string } | null });
 let active = false, serial = 0, readSerial = 0, readRequest: AbortController | null = null;
 let galleryRequest: AbortController | null = null;
 const requests = new Set<AbortController>(), stamp = () => ({ identity: deps.identity(), actor: deps.actor(), epoch: state.epoch });
 const owner = (s: ReturnType<typeof stamp>) => active && s.actor > 0 && s.actor === deps.actor() && s.identity === deps.identity() && s.epoch === state.epoch;
 const current = (s: ReturnType<typeof stamp>) => owner(s) && deps.view();
 const controller = () => { const c = new AbortController(); requests.add(c); return c; };
 const writable = () => active && deps.view() && deps.manage() && !!state.snapshot?.write_ready && !state.loading && !state.busy && !state.pending && !state.pendingError && !state.confirmation;
 const viewLocked = () => !state.snapshot || state.loading || state.busy || !!state.pending || !!state.pendingError || !!state.editor || !!state.confirmation;
 function retire() {
  closeGallery();
  state.epoch++; readSerial++; requests.forEach(c => c.abort()); requests.clear(); state.snapshot = null; state.previewErrors = {};
  state.loading = state.busy = false; state.editor = null; state.confirmation = null; state.pending = null;
  state.pendingError = state.error = state.notice = ''; state.retryReady = false; state.filters.draft = ''; state.filters.keyword = ''; state.filters.page = 1;
 }
 async function restore(s: ReturnType<typeof stamp>) {
  try { const raw = deps.readPending(s.actor); if (raw === null || raw === undefined) return;
   const a = ensureAction(raw, s.actor); if (await ensurePayloadHash(a) !== a.payload_hash) throw Error('原保障操作摘要不一致，请保留核对');
   if (owner(s)) { state.pending = a; state.notice = ''; }
  } catch (error) { if (owner(s)) state.pendingError = message(error); }
 }
 async function load() {
  const s = stamp(); if (!current(s) || state.busy) return;
  readRequest?.abort(); const read = ++readSerial, c = controller(); readRequest = c; state.loading = true; closeGallery(); state.source++; state.editor = null; state.confirmation = null; state.error = '';
  try { const result = ensureCatalog(await deps.read(c.signal)); if (current(s) && read === readSerial) { state.snapshot = result; state.source++; state.filters.page = Math.min(state.filters.page, pageCount()); } }
  catch (error) { if (current(s) && read === readSerial) { state.snapshot = null; state.error = message(error); } }
  finally { requests.delete(c); if (current(s) && read === readSerial) state.loading = false; }
 }
 async function activate() { active = true; retire(); const s = stamp(); if (s.actor > 0) await restore(s); if (current(s)) await load(); }
 function dispose() { active = false; retire(); }
 function open(row: EnsureRow | null) {
  if (!writable() || state.editor || !row && !state.snapshot!.can_create) return;
  state.error = state.notice = ''; state.editor = { serial: ++serial, version: 0, row: row ? copy(row) : null, draft: newEnsureValues(row ?? undefined), rawSort: String(row?.sort ?? 0), imagePreview: '', failedPreview: '' };
 }
 function confirm(operation: EnsureOperation, id: number, payload: Record<string, unknown>, guard: () => boolean) {
  if (!writable() || !guard()) return; state.notice = ''; state.confirmation = { serial: ++serial, operation, id, payload: copy(payload), revision: state.snapshot!.revision }; state.editor = null; closeGallery();
 }
 async function completed(raw: unknown, a: EnsureAction, s: ReturnType<typeof stamp>) {
  const receipt = ensureReceipt(raw, a); if (!owner(s)) return;
  deps.persist(s.actor, null, a); state.pending = null; state.editor = null; state.confirmation = null; state.retryReady = false; state.busy = false;
  state.notice = receipt.state === 'committed' ? '商品保障操作已完成' : '原保障操作已封存为未应用，请重新核对后编辑';
  if (receipt.state === 'committed') deps.changed?.();
  await restore(s); if (current(s)) await load();
 }
 async function run(a: EnsureAction) {
  const s = stamp(); if (!current(s) || !deps.manage() || state.busy || JSON.stringify(state.pending) !== JSON.stringify(a)) return;
  const c = controller(); state.busy = true; state.retryReady = false; state.error = state.notice = '';
  try { await completed(await deps.write(a, c.signal), a, s); }
  catch (error) { if (owner(s)) state.error = '提交结果尚未确认。' + message(error); }
  finally { requests.delete(c); if (owner(s)) state.busy = false; }
 }
 async function recover(resolve = false) {
  const s = stamp(), a = state.pending; if (!owner(s) || state.busy || !a) return;
  const c = controller(); state.busy = true; state.error = state.notice = ''; state.retryReady = false;
  try { await completed(await (resolve ? deps.resolve(a, c.signal) : deps.receipt(a, c.signal)), a, s); }
  catch (error) { if (owner(s)) { state.error = status(error) === 404 ? '尚未找到回执，结果仍未知。可主动原样重试，或核对并封存原请求。' : message(error); state.retryReady = !resolve && status(error) === 404 && deps.manage() && deps.view(); } }
  finally { requests.delete(c); if (owner(s)) state.busy = false; }
 }
 function visible() { const keyword = state.filters.keyword.toLocaleLowerCase(); return (state.snapshot?.list ?? []).filter(row => !keyword || (row.name.toLocaleLowerCase().includes(keyword) || String(row.id).includes(keyword))); }
 const pageCount = () => Math.max(1, Math.ceil(visible().length / 15));
 function screen() {
  const s = stamp(), source = state.source, snapshot = state.snapshot, pending = state.pending;
  const admitted = () => current(s) && source === state.source && !viewLocked();
  return { key: state.epoch, refresh: () => { if (current(s) && source === state.source && !state.busy && !state.editor && !state.confirmation) void load(); },
   create: () => { if (admitted()) open(null); },
   keyword: (value: unknown) => { if (current(s) && snapshot === state.snapshot && !viewLocked() && typeof value === 'string' && value !== state.filters.draft) { state.filters.draft = value; state.error = [...value].length > 4096 ? '搜索名称不能超过4096个字符，请缩短后查询' : ''; state.source++; } },
   search: () => { if (admitted()) { if ([...state.filters.draft].length > 4096) { state.error = '搜索名称不能超过4096个字符，请缩短后查询'; return; } state.error = ''; state.filters.keyword = state.filters.draft.trim(); state.filters.page = 1; state.source++; } },
   reset: () => { if (admitted()) { state.filters.draft = ''; state.filters.keyword = ''; state.filters.page = 1; state.source++; } },
   previous: () => { if (admitted() && state.filters.page > 1) { state.filters.page--; state.source++; } },
   next: () => { if (admitted() && state.filters.page < pageCount()) { state.filters.page++; state.source++; } },
   receipt: () => { if (owner(s) && pending === state.pending) void recover(); }, resolve: () => { if (owner(s) && pending === state.pending) void recover(true); },
   retry: () => { if (current(s) && source === state.source && pending === state.pending && state.retryReady && pending) void run(copy(pending)); },
  };
 }
 function rowControls(row: EnsureRow) {
  const s = stamp(), source = state.source, raw = JSON.stringify(row);
  const admitted = () => current(s) && source === state.source && !!state.snapshot?.list.includes(row) && JSON.stringify(row) === raw && !state.editor;
  const imageKey = `${state.epoch}:${source}:${row.id}:${row.image_preview}`;
  return { key: `${state.epoch}:${source}:${row.id}`, row, preview: state.previewErrors[imageKey] ? '' : row.image_preview, imageError: () => { if (admitted()) state.previewErrors[imageKey] = true; }, status: () => { if (admitted()) confirm('status', row.id, { status: row.status === 1 ? 0 : 1 }, admitted); }, edit: () => { if (admitted()) open(row); }, remove: () => { if (admitted()) confirm('delete', row.id, {}, admitted); } };
 }
 function editorControls() {
  const e = state.editor; if (!e) return [];
  const s = stamp(), source = state.source, version = e.version, raw = JSON.stringify({ draft: e.draft, rawSort: e.rawSort });
  const admitted = () => current(s) && source === state.source && state.editor === e;
  function setField(field: 'name' | 'desc', value: unknown) { if (admitted() && !state.gallery && writable() && typeof value === 'string' && value !== e!.draft[field]) { closeGallery(); e!.draft[field] = value; e!.version++; state.error = ''; } }
  const preview = e.row && e.draft.image === e.row.image ? e.row.image_preview : e.imagePreview;
  return [{ key: `${state.epoch}:${e.serial}`, imageKey: `${state.epoch}:${e.serial}:${version}:${preview}`, imageError: () => { if (admitted() && e.version === version) e.failedPreview = preview; }, value: e.draft.name, desc: e.draft.desc, image: e.draft.image, preview: preview === e.failedPreview ? '' : preview, rawSort: e.rawSort, count: [...e.draft.name.trim()].length,
   picker: () => { if (admitted() && writable() && e.version === version) void openGallery(e); },
   set: (value: unknown) => setField('name', value),
   description: (value: unknown) => setField('desc', value),
   sort: (value: unknown) => { if (admitted() && !state.gallery && writable() && typeof value === 'string' && value !== e.rawSort) { closeGallery(); e.rawSort = value; e.version++; state.error = ''; } },
   cancel: () => { if (admitted() && !state.gallery && e.version === version && !state.busy) { closeGallery(); state.editor = null; } },
   submit: () => {
    if (!admitted() || state.gallery || !writable() || e.version !== version || JSON.stringify({ draft: e.draft, rawSort: e.rawSort }) !== raw) return;
    try {
     ensureName(e.draft.name, e.row?.name); ensureDescription(e.draft.desc, e.row?.desc); ensureImage(e.draft.image, e.row?.image);
     if (!/^(?:0|-?[1-9]\d*)$/u.test(e.rawSort)) throw Error('排序须为整数，请完整输入后保存');
     const sort = ensureSort(Number(e.rawSort), e.row?.sort);
     confirm(e.row ? 'update' : 'create', e.row?.id ?? 0, { name: e.draft.name, image: e.draft.image, desc: e.draft.desc, sort }, () => admitted() && e.version === version && JSON.stringify({ draft: e.draft, rawSort: e.rawSort }) === raw);
    }
    catch (error) { state.error = message(error); }
   },
  }];
 }
 function closeGallery() { galleryRequest?.abort(); galleryRequest = null; state.gallery = null; }
 async function loadGallery(e: Editor) {
  const p = state.gallery, s = stamp(), source = state.source, version = e.version, rawEditor = JSON.stringify(e.draft);
  if (!p || !current(s) || !writable() || state.editor !== e) return;
  if ([...p.name].length > 80 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(p.name)) { p.error = '图库名称须为80个字符以内的有效文字'; return; }
  galleryRequest?.abort(); const c = controller(), request = ++p.request, revision = p.revision, q = { page: p.page, limit: 20, pid: p.pid, name: p.name };
  galleryRequest = c; p.loading = true; p.error = ''; p.list = [];
  const valid = () => current(s) && source === state.source && deps.manage() && state.editor === e && e.version === version && JSON.stringify(e.draft) === rawEditor && state.gallery === p && p.request === request && p.revision === revision && !c.signal.aborted;
  try {
   const categories = ensureObject(await deps.categories(c.signal)); ensureOnly(categories, ['list']);
   if (!Array.isArray(categories.list) || categories.list.length > 5000) throw Error('图库分类不完整');
   const ids = new Set<number>(), cats = categories.list.map(value => { const row = ensureObject(value); ensureOnly(row, ['id', 'pid', 'name']); const id = ensureInteger(row.id, 1); if (ids.has(id)) throw Error('图库分类重复'); ids.add(id); return { id, pid: ensureInteger(row.pid), name: ensureText(row.name) }; });
   if (!valid()) return;
   const options = ensureObject(await deps.options(q, c.signal)); ensureOnly(options, ['list', 'count', 'page', 'limit']);
   if (!Array.isArray(options.list) || options.list.length > 20 || options.page !== q.page || options.limit !== 20) throw Error('图库响应与原查询不一致');
   const count = ensureInteger(options.count, 0, 5000), seen = new Set<number>();
   const list = options.list.map(value => {
    const row = ensureObject(value); ensureOnly(row, ['att_id', 'pid', 'real_name', 'reference', 'preview']); const id = ensureInteger(row.att_id, 1);
    if (seen.has(id)) throw Error('图库图片重复'); seen.add(id);
    const reference = ensureImage(row.reference), preview = ensurePreview(row.preview), pid = ensureInteger(row.pid);
    if (reference !== `/api/assets/${id}` || pid !== q.pid || !preview) throw Error('图库稳定引用或预览不完整');
    return { att_id: id, pid, real_name: ensureText(row.real_name), reference, preview };
   });
   if (count < list.length || list.length !== Math.max(0, Math.min(20, count - (q.page - 1) * 20))) throw Error('图库计数不完整');
   if (valid()) { p.categories = cats; p.list = list; p.count = count; }
  } catch (error) { if (valid()) p.error = message(error); }
  finally { requests.delete(c); if (valid()) p.loading = false; }
 }
 async function openGallery(e: Editor) {
  if (!writable() || state.editor !== e || state.gallery) return;
  state.gallery = { serial: ++serial, revision: 0, request: 0, page: 1, pid: 0, name: '', loading: false, error: '', list: [], categories: [], count: 0 }; await loadGallery(e);
 }
 function galleryControls() {
  const p = state.gallery, e = state.editor; if (!p || !e) return [];
  const s = stamp(), source = state.source, version = e.version, rawEditor = JSON.stringify(e.draft), revision = p.revision, request = p.request;
  const context = () => current(s) && source === state.source && deps.manage() && state.gallery === p && state.editor === e && e.version === version && JSON.stringify(e.draft) === rawEditor;
  const admitted = () => context() && p.revision === revision && p.request === request;
  const invalidate = () => { galleryRequest?.abort(); p.request++; p.revision++; p.loading = false; p.list = []; p.count = 0; p.error = ''; };
  const reload = () => { if (admitted()) void loadGallery(e); };
  return [{ key: `${state.epoch}:${e.serial}:${p.serial}`, name: p.name, pid: p.pid, page: p.page, pages: Math.max(1, Math.ceil(p.count / 20)), count: p.count, loading: p.loading, error: p.error, categories: p.categories,
   nameInput: (value: unknown) => { if (context() && typeof value === 'string' && value !== p.name) { invalidate(); p.name = value; p.page = 1; } },
   category: (value: unknown) => { if (!admitted() || typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) return; const id = Number(value); if (id !== 0 && !p.categories.some(row => row.id === id)) return; invalidate(); p.pid = id; p.page = 1; void loadGallery(e); },
   search: reload, refresh: reload,
   previous: () => { if (admitted() && !p.loading && p.page > 1) { p.page--; p.revision++; void loadGallery(e); } },
   next: () => { if (admitted() && !p.loading && p.page < Math.ceil(p.count / 20)) { p.page++; p.revision++; void loadGallery(e); } },
   close: () => { if (context()) closeGallery(); },
   items: p.list.map(row => { const raw = JSON.stringify(row); return { key: `${p.serial}:${revision}:${request}:${row.att_id}`, row,
    error: () => { if (admitted() && p.list.includes(row) && JSON.stringify(row) === raw) row.preview = ''; },
    choose: () => { if (!admitted() || p.loading || !writable() || !p.list.includes(row) || JSON.stringify(row) !== raw || !row.preview) return; e.draft.image = row.reference; e.imagePreview = row.preview; e.failedPreview = ''; e.version++; closeGallery(); },
   }; }),
  }];
 }
 function confirmationControls() {
  const c = state.confirmation; if (!c) return [];
  const s = stamp(), source = state.source, admitted = () => current(s) && source === state.source && state.confirmation === c && !state.busy && deps.manage();
  return [{ key: `${state.epoch}:${c.serial}`, operation: c.operation, id: c.id, payload: c.payload,
   cancel: () => { if (admitted()) state.confirmation = null; },
   confirm: async () => {
    if (!admitted()) return; let dispatched = false; state.busy = true; state.notice = '';
    try { const a: EnsureAction = { operation_id: crypto.randomUUID(), actor_id: s.actor, operation: c.operation, target_id: c.id, revision: c.revision, payload: copy(c.payload), payload_hash: '' };
     a.payload_hash = await ensurePayloadHash(a);
     if (!current(s) || !deps.manage() || state.confirmation !== c || source !== state.source) return;
     deps.persist(s.actor, a); state.pending = copy(a); state.confirmation = null; state.busy = false; dispatched = true; void run(a);
    } catch (error) { if (owner(s)) { state.error = message(error); await restore(s); if (owner(s) && state.pending) state.confirmation = null; } }
    finally { if (owner(s) && !dispatched) state.busy = false; }
   },
  }];
 }
 return { state, writable, viewLocked, activate, dispose, load, screen, visible, pageCount, rowControls, editorControls, confirmationControls, galleryControls };
}
