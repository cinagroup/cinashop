import { STAFF_FIELDS, staffAction, staffCatalog, staffInteger, staffObject, staffOnly, staffPayloadHash, staffPreview,
  staffReceipt, staffText, staffPayload, newStaffValues, type StaffAction, type StaffCatalog, type StaffOperation,
  type StaffRow, type StaffPayload } from '../../../common/staffAuthor';
interface ImageOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }
interface UserOption { uid: number; nickname: string; avatar: string; preview: string; selection: string }
interface Editor { serial: number; version: number; row: StaffRow | null; draft: StaffPayload; preview: string; selected: UserOption | null }
export interface StaffAuthorDependencies {
  identity(): string; actor(): number; view(): boolean; manage(): boolean;
  read(signal: AbortSignal): Promise<unknown>; write(a: StaffAction, signal: AbortSignal): Promise<unknown>;
  receipt(a: StaffAction, signal: AbortSignal): Promise<unknown>; resolve(a: StaffAction, signal: AbortSignal): Promise<unknown>;
  categories(signal: AbortSignal): Promise<unknown>; options(q: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  users(q: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  readPending(actor: number): unknown; persist(actor: number, a: StaffAction | null, expected?: StaffAction): void; changed?(): void;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const message = (e: unknown) => e instanceof Error ? e.message : '核销员请求失败';
const status = (e: unknown) => Number((e as { status?: unknown; response?: { status?: unknown } })?.status ?? (e as { response?: { status?: unknown } })?.response?.status);
function stableAvatar(v: string) { return !!staffPreview(v) && (!v.startsWith('/api/assets') || /^\/api\/assets\/[1-9]\d*$/u.test(v)); }
export function staffAuthorState(deps: StaffAuthorDependencies, wrap: <T extends object>(v: T) => T = v => v) {
  const state = wrap({ epoch: 0, source: 0, snapshot: null as StaffCatalog | null, loading: false, busy: false, error: '', notice: '',
    pending: null as StaffAction | null, pendingError: '', retryReady: false,
    filters: { keyword: '', store_id: 0, page: 1 }, editor: null as Editor | null,
    confirmation: null as { serial: number; operation: StaffOperation; id: number; payload: Record<string, unknown>; revision: string } | null,
    picker: null as { serial: number; query: number; page: number; pid: number; name: string; loading: boolean; list: ImageOption[]; count: number; categories: { id: number; pid: number; name: string }[]; error: string } | null,
    users: null as { serial: number; query: number; page: number; keyword: string; loading: boolean; list: UserOption[]; count: number; error: string } | null,
  });
  let active = false, serial = 0, readSerial = 0, pickerRequest: AbortController | null = null, userRequest: AbortController | null = null;
  const requests = new Set<AbortController>(), stamp = () => ({ identity: deps.identity(), actor: deps.actor(), epoch: state.epoch });
  const owner = (s: ReturnType<typeof stamp>) => active && s.actor > 0 && s.actor === deps.actor() && s.identity === deps.identity() && s.epoch === state.epoch;
  const current = (s: ReturnType<typeof stamp>) => owner(s) && deps.view();
  const controller = () => { const c = new AbortController(); requests.add(c); return c; };
  const auxiliary = () => !!(state.picker || state.users);
  const writable = () => active && deps.view() && deps.manage() && !!state.snapshot?.write_ready && !state.loading && !state.busy && !state.pending && !state.pendingError && !state.confirmation;
  const viewLocked = () => !state.snapshot || state.loading || state.busy || !!state.pending || !!state.pendingError || !!state.editor || !!state.confirmation;
  function closeAuxiliary() { pickerRequest?.abort(); userRequest?.abort(); state.picker = null; state.users = null; }
  function retire() {
    state.epoch++; readSerial++; requests.forEach(c => c.abort()); requests.clear(); closeAuxiliary(); state.snapshot = null;
    state.loading = state.busy = false; state.editor = null; state.confirmation = null; state.pending = null;
    state.pendingError = state.error = state.notice = ''; state.retryReady = false;
    state.filters.keyword = ''; state.filters.store_id = 0; state.filters.page = 1;
  }
  async function restore(s: ReturnType<typeof stamp>) {
    try {
      const raw = deps.readPending(s.actor); if (raw === null || raw === undefined) return;
      const a = staffAction(raw, s.actor); if (await staffPayloadHash(a) !== a.payload_hash) throw Error('原核销员操作摘要不一致，请保留核对');
      if (owner(s)) { state.pending = a; state.notice = ''; }
    } catch (e) { if (owner(s)) state.pendingError = message(e); }
  }
  async function load() {
    const s = stamp(); if (!current(s) || state.busy) return;
    const read = ++readSerial, c = controller(); state.loading = true; state.editor = null; closeAuxiliary(); state.confirmation = null; state.error = '';
    try { const result = staffCatalog(await deps.read(c.signal)); if (current(s) && read === readSerial) { state.snapshot = result; state.source++; state.filters.page = 1; } }
    catch (e) { if (current(s) && read === readSerial) { state.snapshot = null; state.error = message(e); } }
    finally { requests.delete(c); if (current(s) && read === readSerial) state.loading = false; }
  }
  async function activate() { active = true; retire(); const s = stamp(); if (s.actor > 0) await restore(s); if (current(s)) await load(); }
  function dispose() { active = false; retire(); }
  function open(row: StaffRow | null) {
    if (!writable() || state.editor || !row && !state.snapshot!.can_create) return;
    state.error = state.notice = '';
    state.editor = { serial: ++serial, version: 0, row: row ? copy(row) : null, draft: newStaffValues(row ?? undefined),
      preview: row?.avatar_preview ?? '', selected: null };
  }
  function confirm(operation: StaffOperation, id: number, payload: Record<string, unknown>, guard: () => boolean) {
    if (!writable() || !guard()) return;
    state.notice = ''; state.confirmation = { serial: ++serial, operation, id, payload: copy(payload), revision: state.snapshot!.revision };
    state.editor = null; closeAuxiliary();
  }
  async function completed(raw: unknown, a: StaffAction, s: ReturnType<typeof stamp>) {
    const receipt = staffReceipt(raw, a); if (!owner(s)) return;
    deps.persist(s.actor, null, a); state.pending = null; state.editor = null; state.confirmation = null; closeAuxiliary();
    state.retryReady = false; state.busy = false; state.notice = receipt.state === 'committed' ? '核销员操作已完成' : '原核销员操作已封存为未应用，请重新核对后编辑';
    if (receipt.state === 'committed') deps.changed?.();
    await restore(s); if (current(s)) await load();
  }
  async function run(a: StaffAction) {
    const s = stamp(); if (!current(s) || !deps.manage() || state.busy || JSON.stringify(state.pending) !== JSON.stringify(a)) return;
    const c = controller(); state.busy = true; state.retryReady = false; state.error = state.notice = '';
    try { await completed(await deps.write(a, c.signal), a, s); }
    catch (e) { if (owner(s)) state.error = '提交结果尚未确认。' + message(e); }
    finally { requests.delete(c); if (owner(s)) state.busy = false; }
  }
  async function recover(resolve = false) {
    const s = stamp(), a = state.pending; if (!owner(s) || state.busy || !a) return;
    const c = controller(); state.busy = true; state.error = state.notice = ''; state.retryReady = false;
    try { await completed(await (resolve ? deps.resolve(a, c.signal) : deps.receipt(a, c.signal)), a, s); }
    catch (e) { if (owner(s)) { state.error = status(e) === 404 ? '尚未找到回执，结果仍未知。可主动原样重试，或核对并封存原请求。' : message(e); state.retryReady = !resolve && status(e) === 404 && deps.manage() && deps.view(); } }
    finally { requests.delete(c); if (owner(s)) state.busy = false; }
  }
  function visible() {
    const keyword = state.filters.keyword.toLocaleLowerCase();
    return (state.snapshot?.list ?? []).filter(r => r.is_del === 0 && (!state.filters.store_id || r.store_id === state.filters.store_id)
      && (!keyword || `${r.id}\n${r.uid}\n${r.staff_name}\n${r.phone}\n${r.nickname}\n${r.store_name}`.toLocaleLowerCase().includes(keyword)));
  }
  const pageCount = () => Math.max(1, Math.ceil(visible().length / 20));
  function screen() {
    const s = stamp(), source = state.source, snapshot = state.snapshot, pending = state.pending;
    const admitted = () => current(s) && source === state.source && !viewLocked();
    return { key: state.epoch, filters: state.filters, refresh: () => { if (current(s) && source === state.source && !state.busy) void load(); },
      create: () => { if (admitted()) open(null); },
      keyword: (value: unknown) => { if (current(s) && snapshot === state.snapshot && !viewLocked() && typeof value === 'string' && [...value].length <= 80) { state.filters.keyword = value; state.filters.page = 1; state.source++; } },
      store: (value: unknown) => { if (admitted() && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) { state.filters.store_id = value; state.filters.page = 1; state.source++; } },
      reset: () => { if (admitted()) { state.filters.keyword = ''; state.filters.store_id = 0; state.filters.page = 1; state.source++; } },
      previous: () => { if (admitted() && state.filters.page > 1) { state.filters.page--; state.source++; } },
      next: () => { if (admitted() && state.filters.page < pageCount()) { state.filters.page++; state.source++; } },
      receipt: () => { if (owner(s) && pending === state.pending) void recover(); }, resolve: () => { if (owner(s) && pending === state.pending) void recover(true); },
      retry: () => { if (current(s) && source === state.source && pending === state.pending && state.retryReady && pending) void run(copy(pending)); },
    };
  }
  function rowControls(row: StaffRow) {
    const s = stamp(), source = state.source, raw = JSON.stringify(row);
    const admitted = () => current(s) && source === state.source && !!state.snapshot?.list.includes(row) && JSON.stringify(row) === raw && !state.editor;
    return { key: `${state.epoch}:${source}:${row.id}`, row, edit: () => { if (admitted()) open(row); },
      status: () => { if (admitted() && row.is_del === 0) confirm('status', row.id, { status: row.status === 1 ? 0 : 1 }, admitted); },
      remove: () => { if (admitted() && row.is_del === 0) confirm('delete', row.id, {}, admitted); } };
  }
  const editorAdmitted = (e: Editor, s: ReturnType<typeof stamp>, source: number) => current(s) && source === state.source && state.editor === e && !auxiliary();

  async function loadPicker() {
    const p = state.picker, e = state.editor, s = stamp(); if (!p || !e || !current(s) || !writable()) return;
    pickerRequest?.abort(); const query = ++p.query, q = { page: p.page, limit: 20, pid: p.pid, name: p.name }, c = controller(), version = e.version;
    pickerRequest = c; p.loading = true; p.error = ''; p.list = [];
    const valid = () => current(s) && deps.manage() && state.picker === p && state.editor === e && e.version === version && p.query === query && !c.signal.aborted;
    try {
      const rawCategories = staffObject(await deps.categories(c.signal)); staffOnly(rawCategories, ['list']);
      if (!Array.isArray(rawCategories.list) || rawCategories.list.length > 5000) throw Error('图库分类不完整');
      const ids = new Set<number>(), cats = rawCategories.list.map(v => { const r = staffObject(v); staffOnly(r, ['id', 'pid', 'name']); const id = staffInteger(r.id, 1); if (ids.has(id)) throw Error('图库分类重复'); ids.add(id); return { id, pid: staffInteger(r.pid), name: staffText(r.name, 255) }; });
      if (!valid()) return;
      const raw = staffObject(await deps.options(q, c.signal)); staffOnly(raw, ['list', 'count', 'page', 'limit']);
      if (!Array.isArray(raw.list) || raw.list.length > 20 || raw.page !== q.page || raw.limit !== 20) throw Error('图库响应与原查询不一致');
      const count = staffInteger(raw.count, 0, 5000), seen = new Set<number>();
      const list = raw.list.map(v => {
        const r = staffObject(v); staffOnly(r, ['att_id', 'pid', 'real_name', 'reference', 'preview']); const id = staffInteger(r.att_id, 1);
        if (seen.has(id)) throw Error('图片条目重复'); seen.add(id);
        const reference = staffText(r.reference, 255), preview = staffText(r.preview, 4096);
        if (!reference || !staffPreview(reference) || !staffPreview(preview) || reference.startsWith('/api/assets') && reference !== `/api/assets/${id}` || staffInteger(r.pid) !== q.pid) throw Error('图片稳定引用或预览无效');
        return { att_id: id, pid: staffInteger(r.pid), real_name: staffText(r.real_name, 255), reference, preview };
      });
      if (count < list.length || list.length !== Math.max(0, Math.min(20, count - (q.page - 1) * 20))) throw Error('图库计数不完整');
      if (valid()) { p.categories = cats; p.list = list; p.count = count; }
    } catch (error) { if (valid()) p.error = message(error); }
    finally { requests.delete(c); if (valid()) p.loading = false; }
  }
  function openPicker() {
    if (!state.editor || !writable() || auxiliary()) return;
    state.picker = { serial: ++serial, query: 0, page: 1, pid: 0, name: '', loading: false, list: [], count: 0, categories: [], error: '' }; void loadPicker();
  }
  async function loadUsers() {
    const p = state.users, e = state.editor, s = stamp(); if (!p || !e || !current(s) || !writable()) return;
    userRequest?.abort(); const query = ++p.query, q = { page: p.page, limit: 20, keyword: p.keyword }, c = controller(), version = e.version;
    userRequest = c; p.loading = true; p.error = ''; p.list = [];
    const valid = () => current(s) && deps.manage() && state.users === p && state.editor === e && e.version === version && p.query === query && !c.signal.aborted;
    try {
      const r = staffObject(await deps.users(q, c.signal)); staffOnly(r, ['list', 'count', 'page', 'limit']);
      if (!Array.isArray(r.list) || r.list.length > 20 || r.page !== q.page || r.limit !== 20) throw Error('用户响应与原查询不一致');
      const count = staffInteger(r.count), ids = new Set<number>();
      const list = r.list.map(value => {
        const x = staffObject(value); staffOnly(x, ['uid', 'nickname', 'avatar', 'preview', 'selection']);
        const uid = staffInteger(x.uid, 1), avatar = staffText(x.avatar, 256), preview = staffText(x.preview, 4096), selection = staffText(x.selection, 64);
        if (ids.has(uid) || !/^[a-f0-9]{64}$/u.test(selection) || preview && !staffPreview(preview)) throw Error('用户身份、头像预览或选择快照无效');
        ids.add(uid); return { uid, nickname: staffText(x.nickname, 60), avatar, preview, selection };
      });
      if (list.length !== Math.max(0, Math.min(20, count - (q.page - 1) * 20))) throw Error('用户计数不完整');
      if (valid()) { p.list = list; p.count = count; }
    } catch (error) { if (valid()) p.error = message(error); }
    finally { requests.delete(c); if (valid()) p.loading = false; }
  }
  function openUsers() {
    if (!state.editor || !writable() || auxiliary()) return;
    state.users = { serial: ++serial, query: 0, page: 1, keyword: '', loading: false, list: [], count: 0, error: '' }; void loadUsers();
  }
  function editorControls() {
    const e = state.editor; if (!e) return [];
    const s = stamp(), source = state.source, version = e.version, raw = JSON.stringify(e.draft), admitted = () => editorAdmitted(e, s, source);
    const fields = STAFF_FIELDS.filter(k => !['uid', 'avatar', 'store_id'].includes(k)).map(field => ({ field, key: `${e.serial}:${field}`, value: e.draft[field], set: (value: unknown) => {
      if (!admitted() || !writable() || !['string', 'number'].includes(typeof value) || Object.is(e.draft[field], value)) return;
      (e.draft as unknown as Record<string, unknown>)[field] = value; e.version++;
    } }));
    const stores = state.snapshot?.stores.filter(row => row.is_del === 0) ?? [];
    return [{ key: `${state.epoch}:${e.serial}`, draft: e.draft, fields, stores,
      historicalStore: !stores.some(row => row.id === e.draft.store_id) ? e.row ? e.row.store_name || `历史提货点 #${e.draft.store_id}` : '请选择提货点' : '',
      store: (v: unknown) => { if (admitted() && writable() && typeof v === 'number' && stores.some(row => row.id === v) && v !== e.draft.store_id) { e.draft.store_id = v; e.version++; } },
      user: { uid: e.draft.uid, name: e.selected?.nickname ?? e.row?.nickname ?? '', open: () => { if (admitted()) openUsers(); } },
      images: [{ key: `${e.serial}:avatar`, nativeKey: `${e.serial}:avatar:${version}`, reference: e.draft.avatar, preview: staffPreview(e.preview), open: () => { if (admitted()) openPicker(); },
        set: (v: unknown) => { if (admitted() && writable() && typeof v === 'string' && v !== e.draft.avatar) { e.draft.avatar = v; e.preview = v.startsWith('/api/assets') ? '' : staffPreview(v); e.version++; } },
        error: () => { if (admitted() && e.version === version) e.preview = ''; } }],
      cancel: () => { if (admitted() && !state.busy) state.editor = null; },
      submit: () => {
        if (!admitted() || !writable() || e.version !== version || JSON.stringify(e.draft) !== raw) return;
        try {
          if ([...e.draft.avatar].length > 255) throw Error('所选用户原头像超过255字，请改选头像，原值不会截断');
          const values = staffPayload(e.row ? 'update' : 'create', e.draft) as unknown as StaffPayload;
          const changed = (field: keyof StaffPayload) => !e.row || field === 'user_selection' || values[field] !== e.row[field];
          if ((!e.row || values.uid !== e.row.uid) && (!values.user_selection || !e.selected || values.uid !== e.selected.uid || values.user_selection !== e.selected.selection)) throw Error('请从真实用户目录选择关联用户');
          if ((!e.row || values.store_id !== e.row.store_id) && !stores.some(row => row.id === values.store_id)) throw Error('请选择当前有效提货点');
          if (changed('staff_name') && (!values.staff_name || values.staff_name !== values.staff_name.trim() || /[\u0000-\u001f\u007f]/u.test(values.staff_name))) throw Error('请填写有效核销员名称');
          if (changed('phone') && (!values.phone || values.phone !== values.phone.trim() || /[\u0000-\u001f\u007f]/u.test(values.phone))) throw Error('请填写有效联系电话');
          if (changed('verify_status') && ![0, 1].includes(values.verify_status) || changed('status') && ![0, 1].includes(values.status)) throw Error('核销开关或状态无效');
          const sameHistory = e.row && values.uid === e.row.uid && values.avatar === e.row.avatar;
          const selectedHistory = e.selected && values.uid === e.selected.uid && values.avatar === e.selected.avatar;
          if (!sameHistory && !selectedHistory && values.avatar && !stableAvatar(values.avatar)) throw Error('头像须为HTTPS、站内稳定地址或所选用户原头像');
          confirm(e.row ? 'update' : 'create', e.row?.id ?? 0, values as unknown as Record<string, unknown>, () => admitted() && e.version === version && JSON.stringify(e.draft) === raw);
        } catch (error) { state.error = message(error); }
      } }];
  }
  function pickerControls() {
    const p = state.picker, e = state.editor; if (!p || !e) return [];
    const s = stamp(), version = e.version, query = p.query;
    const admitted = () => current(s) && deps.manage() && writable() && state.picker === p && state.editor === e && e.version === version;
    return [{ key: `${state.epoch}:${p.serial}`, ...p, items: p.list.map(item => ({ ...item, key: `${p.serial}:${query}:${item.att_id}`, choose: () => {
      if (admitted() && !p.loading && query === p.query && p.list.includes(item)) { e.draft.avatar = item.reference; e.preview = item.preview; e.version++; state.picker = null; }
    } })), nameChange: (v: unknown) => { if (admitted() && typeof v === 'string' && [...v].length <= 80) { p.name = v; p.query++; pickerRequest?.abort(); p.loading = false; p.list = []; p.count = 0; } },
      category: (v: unknown) => { if (admitted() && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) { p.pid = v; p.page = 1; void loadPicker(); } },
      search: () => { if (admitted() && query === p.query) { p.page = 1; void loadPicker(); } },
      previous: () => { if (admitted() && query === p.query && !p.loading && p.page > 1) { p.page--; void loadPicker(); } },
      next: () => { if (admitted() && query === p.query && !p.loading && p.page * 20 < p.count) { p.page++; void loadPicker(); } },
      close: () => { if (current(s) && state.picker === p) { p.query++; pickerRequest?.abort(); state.picker = null; } } }];
  }
  function userControls() {
    const p = state.users, e = state.editor; if (!p || !e) return [];
    const s = stamp(), version = e.version, query = p.query;
    const admitted = () => current(s) && deps.manage() && writable() && state.users === p && state.editor === e && e.version === version;
    return [{ key: `${state.epoch}:${p.serial}`, ...p, items: p.list.map(item => {
      const source = JSON.stringify(item); return { ...item, key: `${p.serial}:${query}:${item.uid}`, choose: () => {
        if (admitted() && !p.loading && query === p.query && p.list.includes(item) && JSON.stringify(item) === source) {
          e.draft.uid = item.uid; e.draft.avatar = item.avatar; e.draft.user_selection = item.selection; e.selected = copy(item); e.preview = item.preview; e.version++; state.users = null;
        }
      } };
    }), keywordChange: (v: unknown) => { if (admitted() && typeof v === 'string' && [...v].length <= 80 && v !== p.keyword) { p.keyword = v; p.query++; userRequest?.abort(); p.loading = false; p.list = []; p.count = 0; } },
      search: () => { if (admitted() && query === p.query) { p.page = 1; void loadUsers(); } },
      previous: () => { if (admitted() && query === p.query && !p.loading && p.page > 1) { p.page--; void loadUsers(); } },
      next: () => { if (admitted() && query === p.query && !p.loading && p.page * 20 < p.count) { p.page++; void loadUsers(); } },
      close: () => { if (current(s) && state.users === p) { p.query++; userRequest?.abort(); state.users = null; } } }];
  }
  function confirmationControls() {
    const c = state.confirmation; if (!c) return [];
    const s = stamp(), source = state.source, admitted = () => current(s) && source === state.source && state.confirmation === c && !state.busy && deps.manage();
    return [{ key: `${state.epoch}:${c.serial}`, operation: c.operation, id: c.id, payload: c.payload,
      cancel: () => { if (admitted()) state.confirmation = null; },
      confirm: async () => {
        if (!admitted()) return; let dispatched = false; state.busy = true; state.notice = '';
        try {
          const a: StaffAction = { operation_id: crypto.randomUUID(), actor_id: s.actor, operation: c.operation, target_id: c.id, revision: c.revision, payload: copy(c.payload), payload_hash: '' };
          a.payload_hash = await staffPayloadHash(a);
          if (!current(s) || !deps.manage() || state.confirmation !== c || source !== state.source) return;
          deps.persist(s.actor, a); state.pending = copy(a); state.confirmation = null; state.busy = false; dispatched = true; void run(a);
        } catch (error) { if (owner(s)) { state.error = message(error); await restore(s); if (owner(s) && state.pending) state.confirmation = null; } }
        finally { if (owner(s) && !dispatched) state.busy = false; }
      } }];
  }
  return { state, writable, viewLocked, activate, dispose, load, screen, visible, pageCount, rowControls, editorControls, pickerControls, userControls, confirmationControls };
}
