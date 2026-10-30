import { STORE_FIELDS, storeAction, storeCatalog, storeInteger, storeObject, storeOnly, storePayloadHash, storePreview,
  storeReceipt, storeText, storeValues, newStoreValues, type StoreAction, type StoreCatalog, type StoreOperation,
  type StoreRow, type StoreValues } from '../../../common/storeAuthor';

interface ImageOption { att_id: number; pid: number; real_name: string; reference: string; preview: string }
interface Region { id: number; pid: number; level: number; name: string }
interface Editor { serial: number; version: number; row: StoreRow | null; draft: StoreValues; preview: string; timeDirty: boolean; times: [string, string] }
export interface StoreAuthorDependencies {
  identity(): string; actor(): number; view(): boolean; manage(): boolean;
  read(signal: AbortSignal): Promise<unknown>; write(a: StoreAction, signal: AbortSignal): Promise<unknown>;
  receipt(a: StoreAction, signal: AbortSignal): Promise<unknown>; resolve(a: StoreAction, signal: AbortSignal): Promise<unknown>;
  categories(signal: AbortSignal): Promise<unknown>; options(q: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  regions(signal: AbortSignal): Promise<unknown>; mapConfig(signal: AbortSignal): Promise<unknown>;
  readPending(actor: number): unknown; persist(actor: number, a: StoreAction | null, expected?: StoreAction): void;
  changed?(): void;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const message = (e: unknown) => e instanceof Error ? e.message : '提货点请求失败';
const status = (e: unknown) => Number((e as { status?: unknown; response?: { status?: unknown } })?.status ?? (e as { response?: { status?: unknown } })?.response?.status);
const MAP_ORIGIN = 'https://apis.map.qq.com';
function clock(v: string): string | null {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(v)) return null;
  return v.length === 5 ? `${v}:00` : v;
}
function originalTimes(v: string): [string, string] {
  const pair = v.split(/\s+-\s+/u);
  return pair.length === 2 && clock(pair[0]!) && clock(pair[1]!) ? [clock(pair[0]!)!, clock(pair[1]!)!] : ['', ''];
}
function checkedRegions(raw: unknown): Region[] {
  const r = storeObject(raw); storeOnly(r, ['list', 'count']);
  if (!Array.isArray(r.list) || r.list.length > 10000 || r.count !== r.list.length) throw Error('省市区目录不完整');
  const seen = new Map<number, Region>(), names = new Set<string>();
  const rows = r.list.map(v => {
    const x = storeObject(v); storeOnly(x, ['id', 'pid', 'level', 'name']);
    const row = { id: storeInteger(x.id, 1), pid: storeInteger(x.pid), level: storeInteger(x.level, 1, 3), name: storeText(x.name, 100) };
    const name = JSON.stringify([row.pid, row.name]);
    if (!row.name || row.name !== row.name.trim() || /[\u0000-\u001f\u007f]/u.test(row.name) || seen.has(row.id) || names.has(name)) throw Error('省市区名称或标识存在歧义');
    seen.set(row.id, row); names.add(name); return row;
  });
  for (const row of rows) if (row.level === 1 ? row.pid !== 0 : seen.get(row.pid)?.level !== row.level - 1) throw Error('省市区父级层级异常');
  return rows;
}
function checkedMap(raw: unknown): { available: boolean; url: string; origin: string } {
  const r = storeObject(raw); storeOnly(r, ['available', 'url', 'origin']);
  if (typeof r.available !== 'boolean' || r.origin !== MAP_ORIGIN || typeof r.url !== 'string') throw Error('地图配置响应无效');
  if (!r.available) { if (r.url !== '') throw Error('地图配置状态矛盾'); return { available: false, url: '', origin: MAP_ORIGIN }; }
  const url = new URL(r.url), keys = [...url.searchParams.keys()];
  if (url.origin !== MAP_ORIGIN || url.pathname !== '/tools/locpicker' || url.username || url.password || url.hash
    || keys.length !== 3 || new Set(keys).size !== 3 || keys.some(k => !['type', 'key', 'referer'].includes(k))
    || url.searchParams.get('type') !== '1' || url.searchParams.get('referer') !== 'myapp'
    || !/^[A-Za-z0-9_-]{1,255}$/u.test(url.searchParams.get('key') ?? '') || url.searchParams.get('key') === '0') throw Error('地图只允许固定官方选点组件');
  return { available: true, url: r.url, origin: MAP_ORIGIN };
}

export function storeAuthorState(deps: StoreAuthorDependencies, wrap: <T extends object>(v: T) => T = v => v) {
  const state = wrap({ epoch: 0, source: 0, snapshot: null as StoreCatalog | null, loading: false, busy: false, error: '', notice: '',
    pending: null as StoreAction | null, pendingError: '', retryReady: false,
    filters: { keyword: '', type: '', page: 1 }, editor: null as Editor | null,
    confirmation: null as { serial: number; operation: StoreOperation; id: number; payload: Record<string, unknown>; revision: string } | null,
    picker: null as { serial: number; query: number; page: number; pid: number; name: string; loading: boolean; list: ImageOption[]; count: number; categories: { id: number; pid: number; name: string }[]; error: string } | null,
    region: null as { serial: number; version: number; loading: boolean; rows: Region[]; path: number[]; error: string } | null,
    map: null as { serial: number; nonce: string; loading: boolean; url: string; origin: string; error: string; candidate: { lat: number; lng: number } | null; version: number } | null,
  });
  let active = false, serial = 0, readSerial = 0, pickerRequest: AbortController | null = null, regionRequest: AbortController | null = null, mapRequest: AbortController | null = null;
  const requests = new Set<AbortController>(), stamp = () => ({ identity: deps.identity(), actor: deps.actor(), epoch: state.epoch });
  const owner = (s: ReturnType<typeof stamp>) => active && s.actor > 0 && s.actor === deps.actor() && s.identity === deps.identity() && s.epoch === state.epoch;
  const current = (s: ReturnType<typeof stamp>) => owner(s) && deps.view();
  const controller = () => { const c = new AbortController(); requests.add(c); return c; };
  const auxiliary = () => !!(state.picker || state.region || state.map);
  const writable = () => active && deps.view() && deps.manage() && !!state.snapshot?.write_ready && !state.loading && !state.busy && !state.pending && !state.pendingError && !state.confirmation;
  const viewLocked = () => !state.snapshot || state.loading || state.busy || !!state.pending || !!state.pendingError || !!state.editor || !!state.confirmation;
  function closeAuxiliary() { pickerRequest?.abort(); regionRequest?.abort(); mapRequest?.abort(); state.picker = null; state.region = null; state.map = null; }
  function retire() {
    state.epoch++; readSerial++; requests.forEach(c => c.abort()); requests.clear(); closeAuxiliary(); state.snapshot = null;
    state.loading = state.busy = false; state.editor = null; state.confirmation = null; state.pending = null;
    state.pendingError = state.error = state.notice = ''; state.retryReady = false;
    state.filters.keyword = ''; state.filters.type = ''; state.filters.page = 1;
  }
  async function restore(s: ReturnType<typeof stamp>) {
    try {
      const raw = deps.readPending(s.actor); if (raw === null || raw === undefined) return;
      const a = storeAction(raw, s.actor); if (await storePayloadHash(a) !== a.payload_hash) throw Error('原提货点操作摘要不一致，请保留核对');
      if (owner(s)) { state.pending = a; state.notice = ''; }
    } catch (e) { if (owner(s)) state.pendingError = message(e); }
  }
  async function load() {
    const s = stamp(); if (!current(s) || state.busy) return;
    const read = ++readSerial, c = controller(); state.loading = true; state.editor = null; closeAuxiliary(); state.confirmation = null; state.error = '';
    try { const result = storeCatalog(await deps.read(c.signal)); if (current(s) && read === readSerial) { state.snapshot = result; state.source++; state.filters.page = 1; } }
    catch (e) { if (current(s) && read === readSerial) { state.snapshot = null; state.error = message(e); } }
    finally { requests.delete(c); if (current(s) && read === readSerial) state.loading = false; }
  }
  async function activate() { active = true; retire(); const s = stamp(); if (s.actor > 0) await restore(s); if (current(s)) await load(); }
  function dispose() { active = false; retire(); }
  function open(row: StoreRow | null) {
    if (!writable() || state.editor || !row && state.snapshot!.count >= 5000) return;
    state.error = state.notice = '';
    state.editor = { serial: ++serial, version: 0, row: row ? copy(row) : null, draft: newStoreValues(row ?? undefined),
      preview: row?.image_preview ?? '', timeDirty: false, times: originalTimes(row?.day_time ?? newStoreValues().day_time) };
  }
  function confirm(operation: StoreOperation, id: number, payload: Record<string, unknown>, guard: () => boolean) {
    if (!writable() || !guard()) return;
    state.notice = ''; state.confirmation = { serial: ++serial, operation, id, payload: copy(payload), revision: state.snapshot!.revision };
    state.editor = null; closeAuxiliary();
  }
  async function completed(raw: unknown, a: StoreAction, s: ReturnType<typeof stamp>) {
    const receipt = storeReceipt(raw, a); if (!owner(s)) return;
    deps.persist(s.actor, null, a); state.pending = null; state.editor = null; state.confirmation = null; closeAuxiliary();
    state.retryReady = false; state.busy = false; state.notice = receipt.state === 'committed' ? '提货点操作已完成' : '原提货点操作已封存为未应用，请重新核对后编辑';
    if (receipt.state === 'committed') deps.changed?.();
    await restore(s); if (current(s)) await load();
  }
  async function run(a: StoreAction) {
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
    return (state.snapshot?.list ?? []).filter(r => (state.filters.type === '2' ? r.is_del !== 0 : r.is_del === 0)
      && (state.filters.type === '1' ? r.is_show === 1 : state.filters.type === '-1' ? r.is_show === 0 : true)
      && (!keyword || `${r.name}\n${r.phone}\n${r.address}\n${r.detailed_address}`.toLocaleLowerCase().includes(keyword)));
  }
  const pageCount = () => Math.max(1, Math.ceil(visible().length / 20));
  function screen() {
    const s = stamp(), source = state.source, snapshot = state.snapshot, pending = state.pending;
    const admitted = () => current(s) && source === state.source && !viewLocked();
    return { key: state.epoch, filters: state.filters, refresh: () => { if (current(s) && source === state.source && !state.busy) void load(); },
      create: () => { if (admitted()) open(null); },
      keyword: (value: unknown) => { if (current(s) && snapshot === state.snapshot && !viewLocked() && typeof value === 'string' && [...value].length <= 80) { state.filters.keyword = value; state.filters.page = 1; state.source++; } },
      type: (value: unknown) => { if (admitted() && typeof value === 'string' && ['', '1', '-1', '2'].includes(value)) { state.filters.type = value; state.filters.page = 1; state.source++; } },
      reset: () => { if (admitted()) { state.filters.keyword = ''; state.filters.type = ''; state.filters.page = 1; state.source++; } },
      previous: () => { if (admitted() && state.filters.page > 1) { state.filters.page--; state.source++; } },
      next: () => { if (admitted() && state.filters.page < pageCount()) { state.filters.page++; state.source++; } },
      receipt: () => { if (owner(s) && pending === state.pending) void recover(); }, resolve: () => { if (owner(s) && pending === state.pending) void recover(true); },
      retry: () => { if (current(s) && source === state.source && pending === state.pending && state.retryReady && pending) void run(copy(pending)); },
    };
  }
  function rowControls(row: StoreRow) {
    const s = stamp(), source = state.source, raw = JSON.stringify(row);
    const admitted = () => current(s) && source === state.source && !!state.snapshot?.list.includes(row) && JSON.stringify(row) === raw && !state.editor;
    return { key: `${state.epoch}:${source}:${row.id}`, row, edit: () => { if (admitted()) open(row); },
      show: () => { if (admitted() && row.is_del === 0) confirm('show', row.id, { is_show: row.is_show === 1 ? 0 : 1 }, admitted); },
      remove: () => { if (admitted()) confirm(row.is_del === 0 ? 'delete' : 'restore', row.id, {}, admitted); } };
  }
  const editorAdmitted = (e: Editor, s: ReturnType<typeof stamp>, source: number) => current(s) && source === state.source && state.editor === e && !auxiliary();

  async function loadPicker() {
    const p = state.picker, e = state.editor, s = stamp(); if (!p || !e || !current(s) || !writable()) return;
    pickerRequest?.abort(); const query = ++p.query, q = { page: p.page, limit: 20, pid: p.pid, name: p.name }, c = controller(), version = e.version;
    pickerRequest = c; p.loading = true; p.error = ''; p.list = [];
    const valid = () => current(s) && deps.manage() && state.picker === p && state.editor === e && e.version === version && p.query === query && !c.signal.aborted;
    try {
      const rawCategories = storeObject(await deps.categories(c.signal)); storeOnly(rawCategories, ['list']);
      if (!Array.isArray(rawCategories.list) || rawCategories.list.length > 5000) throw Error('图库分类不完整');
      const ids = new Set<number>(), cats = rawCategories.list.map(v => { const r = storeObject(v); storeOnly(r, ['id', 'pid', 'name']); const id = storeInteger(r.id, 1); if (ids.has(id)) throw Error('图库分类重复'); ids.add(id); return { id, pid: storeInteger(r.pid), name: storeText(r.name, 255) }; });
      if (!valid()) return;
      const raw = storeObject(await deps.options(q, c.signal)); storeOnly(raw, ['list', 'count', 'page', 'limit']);
      if (!Array.isArray(raw.list) || raw.list.length > 20 || raw.page !== q.page || raw.limit !== 20) throw Error('图库响应与原查询不一致');
      const count = storeInteger(raw.count, 0, 5000), seen = new Set<number>();
      const list = raw.list.map(v => {
        const r = storeObject(v); storeOnly(r, ['att_id', 'pid', 'real_name', 'reference', 'preview']); const id = storeInteger(r.att_id, 1);
        if (seen.has(id)) throw Error('图片条目重复'); seen.add(id);
        const reference = storeText(r.reference, 255), preview = storeText(r.preview, 4096);
        if (!reference || !storePreview(reference) || !storePreview(preview) || reference.startsWith('/api/assets') && reference !== `/api/assets/${id}` || storeInteger(r.pid) !== q.pid) throw Error('图片稳定引用或预览无效');
        return { att_id: id, pid: storeInteger(r.pid), real_name: storeText(r.real_name, 255), reference, preview };
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
  async function openRegion() {
    const e = state.editor, s = stamp(); if (!e || !writable() || auxiliary()) return;
    state.region = { serial: ++serial, version: 0, loading: true, rows: [], path: [], error: '' };
    const r = state.region, c = controller(), version = e.version; regionRequest = c;
    const valid = () => current(s) && deps.manage() && state.region === r && state.editor === e && e.version === version && !c.signal.aborted;
    try { const rows = checkedRegions(await deps.regions(c.signal)); if (valid()) r.rows = rows; }
    catch (error) { if (valid()) r.error = message(error); }
    finally { requests.delete(c); if (valid()) r.loading = false; }
  }
  async function openMap() {
    const e = state.editor, s = stamp(); if (!e || !writable() || auxiliary()) return;
    state.map = { serial: ++serial, nonce: crypto.randomUUID(), loading: true, url: '', origin: MAP_ORIGIN, error: '', candidate: null, version: 0 };
    const m = state.map, c = controller(), version = e.version; mapRequest = c;
    const valid = () => current(s) && deps.manage() && state.map === m && state.editor === e && e.version === version && !c.signal.aborted;
    try { const result = checkedMap(await deps.mapConfig(c.signal)); if (valid()) { m.url = result.url; if (!result.available) m.error = '地图选点尚未配置，可以关闭地图并手动填写经纬度。'; } }
    catch (error) { if (valid()) m.error = message(error); }
    finally { requests.delete(c); if (valid()) m.loading = false; }
  }
  function editorControls() {
    const e = state.editor; if (!e) return [];
    const s = stamp(), source = state.source, version = e.version, raw = JSON.stringify(e.draft), admitted = () => editorAdmitted(e, s, source);
    const fields = STORE_FIELDS.filter(k => !['image', 'address', 'day_time'].includes(k)).map(field => ({ field, key: `${e.serial}:${field}`, value: e.draft[field],
      set: (value: unknown) => {
        if (!admitted() || !writable() || !['string', 'number'].includes(typeof value) || Object.is(e.draft[field], value)) return;
        (e.draft as unknown as Record<string, unknown>)[field] = value; e.version++;
      } }));
    return [{ key: `${state.epoch}:${e.serial}`, draft: e.draft, fields,
      address: { value: e.draft.address, open: () => { if (admitted()) void openRegion(); } },
      times: e.times.map((value, index) => ({ key: `${e.serial}:time:${index}`, value, index, set: (value: unknown) => {
        if (!admitted() || !writable() || typeof value !== 'string' || value.length > 8 || e.times[index] === value) return;
        e.times[index] = value; e.timeDirty = true; e.version++;
        const start = clock(e.times[0]), end = clock(e.times[1]); if (start && end) e.draft.day_time = `${start} - ${end}`;
      } })),
      images: [{ key: `${e.serial}:image:${version}`, reference: e.draft.image, preview: storePreview(e.preview), open: () => { if (admitted()) openPicker(); },
        error: () => { if (admitted() && e.version === version && state.editor === e) e.preview = ''; } }],
      map: () => { if (admitted()) void openMap(); }, cancel: () => { if (admitted() && !state.busy) state.editor = null; },
      submit: () => {
        if (!admitted() || !writable() || e.version !== version || JSON.stringify(e.draft) !== raw) return;
        try {
          const values = storeValues(e.draft);
          if (e.timeDirty && (!clock(e.times[0]) || !clock(e.times[1]))) throw Error('请完整填写秒级开始与结束营业时间');
          const changed = (field: keyof StoreValues) => !e.row || values[field] !== e.row[field];
          for (const field of ['name', 'introduction', 'detailed_address'] as const) {
            if (changed(field) && (values[field] !== values[field].trim() || field !== 'introduction' && !values[field] || /[\u0000-\u001f\u007f]/u.test(values[field]))) throw Error('请填写有效名称、简介和详细地址');
          }
          if (changed('phone') && !/^1[3-9]\d{9}$/u.test(values.phone)) throw Error('请填写有效的11位手机号');
          for (const [field, maximum] of [['latitude', 90], ['longitude', 180]] as const) {
            if (changed(field) && (!/^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,12})?$/u.test(values[field]) || !Number.isFinite(Number(values[field])) || Math.abs(Number(values[field])) > maximum)) throw Error('请填写范围内的十进制经纬度');
          }
          if (!e.row && (!values.address || !values.image)) throw Error('请选择完整地区和门店图片');
          if (changed('valid_range') && values.valid_range < 0 || changed('is_show') && ![0, 1].includes(values.is_show) || changed('is_store') && ![0, 1].includes(values.is_store)) throw Error('有效距离或状态无效');
          confirm(e.row ? 'update' : 'create', e.row?.id ?? 0, values as unknown as Record<string, unknown>, () => admitted() && e.version === version && JSON.stringify(e.draft) === raw);
        } catch (error) { state.error = message(error); }
      } }];
  }
  function pickerControls() {
    const p = state.picker, e = state.editor; if (!p || !e) return [];
    const s = stamp(), version = e.version, query = p.query;
    const admitted = () => current(s) && deps.manage() && writable() && state.picker === p && state.editor === e && e.version === version;
    return [{ key: `${state.epoch}:${p.serial}`, ...p, items: p.list.map(item => ({ ...item, key: `${p.serial}:${query}:${item.att_id}`, choose: () => {
      if (admitted() && !p.loading && query === p.query && p.list.includes(item)) { e.draft.image = item.reference; e.preview = item.preview; e.version++; state.picker = null; }
    } })), nameChange: (v: unknown) => { if (admitted() && typeof v === 'string' && [...v].length <= 80) { p.name = v; p.query++; pickerRequest?.abort(); p.loading = false; p.list = []; p.count = 0; } },
      category: (v: unknown) => { if (admitted() && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) { p.pid = v; p.page = 1; void loadPicker(); } },
      search: () => { if (admitted()) { p.page = 1; void loadPicker(); } },
      previous: () => { if (admitted() && !p.loading && p.page > 1) { p.page--; void loadPicker(); } },
      next: () => { if (admitted() && !p.loading && p.page * 20 < p.count) { p.page++; void loadPicker(); } },
      close: () => { if (current(s) && state.picker === p) { p.query++; pickerRequest?.abort(); state.picker = null; } } }];
  }
  function regionControls() {
    const r = state.region, e = state.editor; if (!r || !e) return [];
    const s = stamp(), version = e.version, selection = r.version;
    const admitted = () => current(s) && deps.manage() && writable() && state.region === r && state.editor === e && e.version === version;
    const path = r.path.map(id => r.rows.find(row => row.id === id)!);
    const leaf = !!path.length && path.every(Boolean) && !r.rows.some(row => row.pid === path.at(-1)!.id);
    const levels = [0, 1, 2].map(index => ({ index, key: `${r.serial}:level:${index}`, value: r.path[index] ?? 0,
      options: index > 0 && !r.path[index - 1] ? [] : r.rows.filter(row => row.pid === (index ? r.path[index - 1] : 0)),
      set: (v: unknown) => {
        if (!admitted() || r.loading || selection !== r.version || typeof v !== 'number' || !Number.isSafeInteger(v)) return;
        const option = r.rows.find(row => row.id === v && row.pid === (index ? r.path[index - 1] : 0));
        if (!option) return; r.path = [...r.path.slice(0, index), v]; r.version++;
      } }));
    return [{ key: `${state.epoch}:${r.serial}`, loading: r.loading, error: r.error, levels, path: path.map(row => row?.name ?? '').join(' / '), ready: leaf,
      confirm: () => { if (admitted() && !r.loading && leaf && selection === r.version) { e.draft.address = path.map(row => row.name).join(','); e.version++; state.region = null; } },
      close: () => { if (current(s) && state.region === r) { regionRequest?.abort(); state.region = null; } } }];
  }
  function mapControls() {
    const m = state.map, e = state.editor; if (!m || !e) return [];
    const s = stamp(), version = e.version, selected = m.version, candidate = m.candidate && { ...m.candidate };
    const admitted = () => current(s) && deps.manage() && writable() && state.map === m && state.editor === e && e.version === version;
    return [{ key: `${state.epoch}:${m.serial}:${m.nonce}`, loading: m.loading, error: m.error, url: m.url, candidate,
      receive: (event: { origin?: unknown; source?: unknown; data?: unknown }, frameWindow: unknown) => {
        if (!admitted() || m.loading || !m.url || !frameWindow || event.origin !== MAP_ORIGIN || event.source !== frameWindow) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || Array.isArray(data) || (data as { module?: unknown }).module !== 'locationPicker') return;
        const latlng = (data as { latlng?: unknown }).latlng;
        if (!latlng || typeof latlng !== 'object' || Array.isArray(latlng)) return;
        const { lat, lng } = latlng as { lat?: unknown; lng?: unknown };
        if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
        m.candidate = { lat, lng }; m.version++;
      },
      confirm: () => { if (admitted() && candidate && selected === m.version) {
        const decimal = (value: number) => value.toFixed(12).replace(/0+$/u, '').replace(/\.$/u, '');
        e.draft.latitude = decimal(candidate.lat); e.draft.longitude = decimal(candidate.lng); e.version++; state.map = null;
      } },
      close: () => { if (current(s) && state.map === m) { mapRequest?.abort(); state.map = null; } } }];
  }
  function confirmationControls() {
    const c = state.confirmation; if (!c) return [];
    const s = stamp(), source = state.source, admitted = () => current(s) && source === state.source && state.confirmation === c && !state.busy && deps.manage();
    return [{ key: `${state.epoch}:${c.serial}`, operation: c.operation, id: c.id, payload: c.payload,
      cancel: () => { if (admitted()) state.confirmation = null; },
      confirm: async () => {
        if (!admitted()) return; let dispatched = false; state.busy = true; state.notice = '';
        try {
          const a: StoreAction = { operation_id: crypto.randomUUID(), actor_id: s.actor, operation: c.operation, target_id: c.id, revision: c.revision, payload: copy(c.payload), payload_hash: '' };
          a.payload_hash = await storePayloadHash(a);
          if (!current(s) || !deps.manage() || state.confirmation !== c || source !== state.source) return;
          deps.persist(s.actor, a); state.pending = copy(a); state.confirmation = null; state.busy = false; dispatched = true; void run(a);
        } catch (error) { if (owner(s)) { state.error = message(error); await restore(s); if (owner(s) && state.pending) state.confirmation = null; } }
        finally { if (owner(s) && !dispatched) state.busy = false; }
      } }];
  }
  return { state, writable, viewLocked, activate, dispose, load, screen, visible, pageCount, rowControls, editorControls, pickerControls, regionControls, mapControls, confirmationControls };
}
