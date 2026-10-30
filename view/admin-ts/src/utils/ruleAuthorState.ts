import { ruleAction, ruleCatalog, ruleName, ruleSpec, ruleProjection, rulePayload, rulePayloadHash, ruleReceipt,
 type RuleAction, type RuleCatalog, type RuleOperation, type RuleRow, type RuleDimension } from '../../../common/ruleAuthor';
import { isAxiosError } from 'axios';
interface ValueDraft { key: number; value: string }
interface DimensionDraft { key: number; value: string; detail: ValueDraft[] }
interface Editor { serial: number; version: number; structure: number; row: RuleRow | null; name: string; mode: 'preserve' | 'replace'; dimensions: DimensionDraft[] }
export interface RuleAuthorDependencies {
 identity(): string; actor(): number; view(): boolean; manage(): boolean;
 read(signal: AbortSignal): Promise<unknown>; write(a: RuleAction, signal: AbortSignal): Promise<unknown>;
 receipt(a: RuleAction, signal: AbortSignal): Promise<unknown>; resolve(a: RuleAction, signal: AbortSignal): Promise<unknown>;
 changed?(): void;
 readPending(actor: number): unknown; persist(actor: number, a: RuleAction | null, expected?: RuleAction): void;
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
 return error instanceof Error ? error.message : '规格模板请求失败';
}
const status = (error: unknown) => Number((error as { status?: unknown; response?: { status?: unknown } })?.status ?? (error as { response?: { status?: unknown } })?.response?.status);
export function ruleAuthorState(deps: RuleAuthorDependencies, wrap: <T extends object>(v: T) => T = v => v) {
 const state = wrap({ epoch: 0, source: 0, snapshot: null as RuleCatalog | null, loading: false, busy: false, error: '', notice: '',
  pending: null as RuleAction | null, pendingError: '', retryReady: false, filters: { draft: '', keyword: '', page: 1 }, editor: null as Editor | null,
  confirmation: null as { serial: number; operation: RuleOperation; id: number; payload: Record<string, unknown>; revision: string } | null });
 let active = false, serial = 0, readSerial = 0, readRequest: AbortController | null = null;
 const requests = new Set<AbortController>(), stamp = () => ({ identity: deps.identity(), actor: deps.actor(), epoch: state.epoch });
 const owner = (s: ReturnType<typeof stamp>) => active && s.actor > 0 && s.actor === deps.actor() && s.identity === deps.identity() && s.epoch === state.epoch;
 const current = (s: ReturnType<typeof stamp>) => owner(s) && deps.view();
 const controller = () => { const c = new AbortController(); requests.add(c); return c; };
 const writable = () => active && deps.view() && deps.manage() && !!state.snapshot?.write_ready && !state.loading && !state.busy && !state.pending && !state.pendingError && !state.confirmation;
 const viewLocked = () => !state.snapshot || state.loading || state.busy || !!state.pending || !!state.pendingError || !!state.editor || !!state.confirmation;
 function retire() {
  state.epoch++; readSerial++; requests.forEach(c => c.abort()); requests.clear(); state.snapshot = null; 
  state.loading = state.busy = false; state.editor = null; state.confirmation = null; state.pending = null;
  state.pendingError = state.error = state.notice = ''; state.retryReady = false; state.filters.draft = ''; state.filters.keyword = ''; state.filters.page = 1;
 }
 async function restore(s: ReturnType<typeof stamp>) {
  try { const raw = deps.readPending(s.actor); if (raw === null || raw === undefined) return;
   const a = ruleAction(raw, s.actor); if (await rulePayloadHash(a) !== a.payload_hash) throw Error('原规格模板操作摘要不一致，请保留核对');
   if (owner(s)) { state.pending = a; state.notice = ''; }
  } catch (error) { if (owner(s)) state.pendingError = message(error); }
 }
 async function load() {
  const s = stamp(); if (!current(s) || state.busy) return;
  readRequest?.abort(); const read = ++readSerial, c = controller(); readRequest = c; state.loading = true; state.source++; state.editor = null; state.confirmation = null; state.error = '';
  try { const result = ruleCatalog(await deps.read(c.signal)); if (current(s) && read === readSerial) { state.snapshot = result; state.source++; state.filters.page = Math.min(state.filters.page, pageCount()); } }
  catch (error) { if (current(s) && read === readSerial) { state.snapshot = null; state.error = message(error); } }
  finally { requests.delete(c); if (current(s) && read === readSerial) state.loading = false; }
 }
 async function activate() { active = true; retire(); const s = stamp(); if (s.actor > 0) await restore(s); if (current(s)) await load(); }
 function dispose() { active = false; retire(); }
 function open(row: RuleRow | null) {
  if (!writable() || state.editor || !row && !state.snapshot!.can_create) return;
  state.error = state.notice = ''; state.editor = { serial: ++serial, version: 0, structure: 0, row: row ? copy(row) : null, name: row?.rule_name ?? '', mode: row ? 'preserve' : 'replace', dimensions: row ? [] : [dimension()] };
 }
 function confirm(operation: RuleOperation, id: number, payload: Record<string, unknown>, guard: () => boolean) {
  if (!writable() || !guard()) return; state.notice = ''; state.confirmation = { serial: ++serial, operation, id, payload: copy(payload), revision: state.snapshot!.revision }; state.editor = null;
 }
 async function completed(raw: unknown, a: RuleAction, s: ReturnType<typeof stamp>) {
  const receipt = ruleReceipt(raw, a); if (!owner(s)) return;
  deps.persist(s.actor, null, a); state.pending = null; state.editor = null; state.confirmation = null; state.retryReady = false; state.busy = false;
  state.notice = receipt.state === 'committed' ? '规格模板操作已完成' : '原规格模板操作已封存为未应用，请重新核对后编辑';
  if (receipt.state === 'committed') deps.changed?.();
  await restore(s); if (current(s)) await load();
 }
 async function run(a: RuleAction) {
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
 function visible() { const keyword = state.filters.keyword.toLocaleLowerCase(); return (state.snapshot?.list ?? []).filter(row => !keyword || (row.rule_name.toLocaleLowerCase().includes(keyword))); }
 const pageCount = () => Math.max(1, Math.ceil(visible().length / 10));
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
 function rowControls(row: RuleRow) {
  const s = stamp(), source = state.source, raw = JSON.stringify(row);
  const admitted = () => current(s) && source === state.source && !!state.snapshot?.list.includes(row) && JSON.stringify(row) === raw && !state.editor;
  const projection = ruleProjection(row.rule_value);
  return { key: `${state.epoch}:${source}:${row.id}`, row, projection,
   edit: () => { if (admitted()) open(row); }, remove: () => { if (admitted()) confirm('delete', row.id, {}, admitted); } };
 }
 function dimension(value: RuleDimension = { value: '', detail: [''] }): DimensionDraft {
  return { key: ++serial, value: value.value, detail: value.detail.map(value => ({ key: ++serial, value })) };
 }
 function editorControls() {
  const e = state.editor; if (!e) return [];
  const s = stamp(), source = state.source, version = e.version, structure = e.structure, raw = JSON.stringify(e);
  const admitted = () => current(s) && source === state.source && state.editor === e && writable();
  const input = () => admitted() && e.structure === structure;
  const action = () => input() && e.version === version && JSON.stringify(e) === raw;
  const changed = (structural = false) => { e.version++; if (structural) e.structure++; state.error = ''; };
  const projection = e.row ? ruleProjection(e.row.rule_value) : { spec: null, problem: '' };
  return [{ key: `${state.epoch}:${e.serial}`, value: e.name, count: [...e.name].length, mode: e.mode, raw: e.row?.rule_value,
   problem: projection.problem,
   set: (value: unknown) => { if (input() && typeof value === 'string' && value !== e.name) { e.name = value; changed(); } },
   replace: () => { if (action() && e.mode === 'preserve') { e.mode = 'replace'; e.dimensions = (projection.spec ?? [{ value: '', detail: [''] }]).map(dimension); changed(true); } },
   preserve: () => { if (action() && e.row && e.mode === 'replace') { e.mode = 'preserve'; e.dimensions = []; changed(true); } },
   addDimension: () => { if (!action() || e.mode !== 'replace') return; if (e.dimensions.length >= 3) { state.error = '最多支持3个规格维度'; return; } e.dimensions.push(dimension()); changed(true); },
   dimensions: e.dimensions.map(d => {
    const present = () => input() && e.mode === 'replace' && e.dimensions.includes(d);
    const structural = () => action() && present();
    return { key: d.key, value: d.value,
     set: (value: unknown) => { if (present() && typeof value === 'string' && value !== d.value) { d.value = value; changed(); } },
     remove: () => { if (!structural()) return; if (e.dimensions.length <= 1) { state.error = '至少保留一个规格维度'; return; } e.dimensions.splice(e.dimensions.indexOf(d), 1); changed(true); },
     add: () => { if (!structural()) return; if (d.detail.length >= 50) { state.error = '每个维度最多50个规格值'; return; } d.detail.push({ key: ++serial, value: '' }); changed(true); },
     entries: d.detail.map(v => ({ key: v.key, value: v.value,
      set: (value: unknown) => { if (present() && d.detail.includes(v) && typeof value === 'string' && value !== v.value) { v.value = value; changed(); } },
      remove: () => { if (!structural() || !d.detail.includes(v)) return; if (d.detail.length <= 1) { state.error = '每个维度至少保留一个规格值'; return; } d.detail.splice(d.detail.indexOf(v), 1); changed(true); },
     })),
    };
   }),
   cancel: () => { if (action() && !state.busy) state.editor = null; },
   submit: () => {
    if (!action()) return;
    try {
     ruleName(e.name, e.row?.rule_name);
     const spec = e.dimensions.map(d => ({ value: d.value, detail: d.detail.map(v => v.value) }));
     if (e.mode === 'replace') ruleSpec(spec);
     const payload = rulePayload(e.row ? 'update' : 'create', e.mode === 'preserve' ? { rule_name: e.name, mode: 'preserve' } : { rule_name: e.name, mode: 'replace', spec });
     confirm(e.row ? 'update' : 'create', e.row?.id ?? 0, payload, action);
    } catch (error) { state.error = message(error); }
   },
  }];
 }
 function confirmationControls() {
  const c = state.confirmation; if (!c) return [];
  const s = stamp(), source = state.source, admitted = () => current(s) && source === state.source && state.confirmation === c && !state.busy && deps.manage();
  return [{ key: `${state.epoch}:${c.serial}`, operation: c.operation, id: c.id, payload: c.payload,
   cancel: () => { if (admitted()) state.confirmation = null; },
   confirm: async () => {
    if (!admitted()) return; let dispatched = false; state.busy = true; state.notice = '';
    try { const a: RuleAction = { operation_id: crypto.randomUUID(), actor_id: s.actor, operation: c.operation, target_id: c.id, revision: c.revision, payload: copy(c.payload), payload_hash: '' };
     a.payload_hash = await rulePayloadHash(a);
     if (!current(s) || !deps.manage() || state.confirmation !== c || source !== state.source) return;
     deps.persist(s.actor, a); state.pending = copy(a); state.confirmation = null; state.busy = false; dispatched = true; void run(a);
    } catch (error) { if (owner(s)) { state.error = message(error); await restore(s); if (owner(s) && state.pending) state.confirmation = null; } }
    finally { if (owner(s) && !dispatched) state.busy = false; }
   },
  }];
 }
 return { state, writable, viewLocked, activate, dispose, load, screen, visible, pageCount, rowControls, editorControls, confirmationControls };
}
