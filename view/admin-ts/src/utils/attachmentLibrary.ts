import { normalizeAttachmentMove, normalizeAttachmentRename, type AttachmentItem, type AttachmentMoveInput, type AttachmentRenameInput } from '@/api/attachment';

export interface AttachmentActor { identity: string; token: string; storedToken: string | null; session: string | null; view: boolean; manage: boolean }
export interface AttachmentQuery { pid: number; page: number; limit: 20 | 50; name: string }
export interface LibraryCategory { id: number; pid: number; name: string; label: string }
interface Ports {
  list: (query: AttachmentQuery & { file_type: 1 }, signal: AbortSignal) => Promise<unknown>;
  categories: (signal: AbortSignal) => Promise<unknown>;
  move: (input: AttachmentMoveInput, signal: AbortSignal) => Promise<unknown>;
  rename: (input: AttachmentRenameInput, signal: AbortSignal) => Promise<unknown>;
  remove: (ids: number[], signal: AbortSignal) => Promise<unknown>;
  upload: (file: File, pid: number, signal: AbortSignal) => Promise<unknown>;
  createCategory: (name: string, signal: AbortSignal) => Promise<unknown>;
  confirm: (message: string) => Promise<unknown>;
}
export interface AttachmentLibraryState {
  query: AttachmentQuery; items: AttachmentItem[]; categories: LibraryCategory[]; count: number;
  selected: number[]; targetPid: number; rename: { id: number; name: string } | null;
  ready: boolean; categoriesReady: boolean; loading: boolean; categoryLoading: boolean;
  busy: string; error: string; categoryError: string; notice: string; needsReview: boolean;
}
const id = (value: unknown, zero = false): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2_147_483_647;
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('素材响应格式错误'); return value as Record<string, unknown>; };
const name = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败';
const initialQuery = (): AttachmentQuery => ({ pid: 0, page: 1, limit: 20, name: '' });
export function attachmentPreview(value: string): string {
  const localPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview') === '1' && /^blob:/u.test(value);
  return (/^(https:\/\/|\/(?!\/))/iu.test(value) || localPreview) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : '';
}

export function decodeLibraryCategories(value: unknown): LibraryCategory[] {
  const rows = record(value).list;
  if (!Array.isArray(rows) || rows.length > 1000) throw Error('素材分类格式或数量错误');
  const map = new Map<number, { id: number; pid: number; name: string }>();
  for (const raw of rows) {
    const r = record(raw);
    if (!id(r.id) || !id(r.pid, true) || !name(r.name, 50) || r.type !== 1 || r.file_type !== 1 || r.relation_id !== 0 || map.has(r.id)) throw Error('素材分类归属或格式错误');
    map.set(r.id, { id: r.id, pid: r.pid, name: r.name as string });
  }
  return [...map.values()].map(r => {
    const seen = new Set<number>([r.id]), parts = [r.name]; let parent = r.pid;
    while (parent !== 0) { const p = map.get(parent); if (!p || seen.has(parent)) throw Error('素材分类层级损坏，请核对分类'); seen.add(parent); parts.unshift(p.name); parent = p.pid; }
    return { ...r, label: parts.join(' / ') };
  });
}

export function decodeLibraryPage(value: unknown, query: AttachmentQuery): { list: AttachmentItem[]; count: number } {
  const r = record(value);
  if (!Array.isArray(r.list) || r.list.length > query.limit || !Number.isSafeInteger(r.count) || (r.count as number) < r.list.length) throw Error('素材列表格式错误');
  const seen = new Set<number>();
  const list = r.list.map(raw => {
    const row = record(raw);
    if (!id(row.att_id) || seen.has(row.att_id) || row.pid !== query.pid || row.type !== 1 || row.file_type !== 1 || row.relation_id !== 0 || row.module_type !== 1 || !name(row.real_name, 255)
      || typeof row.canonical_url !== 'string' || !attachmentPreview(row.canonical_url) || /[?&](?:signature|expires)=/iu.test(row.canonical_url)
      || typeof row.att_dir !== 'string' || !attachmentPreview(row.att_dir) || typeof row.satt_dir !== 'string' || row.satt_dir && !attachmentPreview(row.satt_dir)
      || typeof row.att_type !== 'string' || !/^image\//iu.test(row.att_type) || typeof row.att_size !== 'string' || typeof row.time !== 'string' || typeof row.raw_size !== 'number' || !Number.isSafeInteger(row.raw_size) || row.raw_size < 0) throw Error('素材归属、分类或图片格式错误');
    seen.add(row.att_id);
    return Object.freeze({ ...row }) as unknown as AttachmentItem;
  });
  return { list, count: r.count as number };
}

type Stamp = { epoch: number; identity: string; token: string; session: string | null; query: string };
type Job = { stamp: Stamp; abort: AbortController };
export class AttachmentLibraryController {
  readonly state: AttachmentLibraryState;
  private alive = true; private epoch = 0; private jobs = new Map<string, Job>();
  constructor(private actor: () => AttachmentActor, private ports: Ports, reactive: (value: AttachmentLibraryState) => AttachmentLibraryState = value => value) {
    this.state = reactive({ query: initialQuery(), items: [], categories: [], count: 0, selected: [], targetPid: 0, rename: null, ready: false, categoriesReady: false, loading: false, categoryLoading: false, busy: '', error: '', categoryError: '', notice: '', needsReview: false });
  }
  get canView() { const a = this.actor(); return this.alive && a.view && !!a.token && a.token === a.storedToken; }
  get canManage() { return this.canView && this.actor().manage; }
  get locked() { return !!this.state.busy || this.state.loading || this.state.categoryLoading; }
  get writable() { return this.canManage && this.state.ready && this.state.categoriesReady && !this.state.needsReview && !this.locked; }
  private stamp(): Stamp { const a = this.actor(); return { epoch: this.epoch, identity: a.identity, token: a.token, session: a.session, query: JSON.stringify(this.state.query) }; }
  private current(s: Stamp) { const a = this.actor(); return this.canView && s.epoch === this.epoch && s.identity === a.identity && s.token === a.token && s.session === a.session && s.query === JSON.stringify(this.state.query); }
  private start(key: string): Job { this.jobs.get(key)?.abort.abort(); const job = { stamp: this.stamp(), abort: new AbortController() }; this.jobs.set(key, job); return job; }
  private valid(key: string, job: Job) { return this.current(job.stamp) && this.jobs.get(key) === job && !job.abort.signal.aborted; }
  private finish(key: string, job: Job) { if (this.jobs.get(key) !== job) return false; this.jobs.delete(key); return this.current(job.stamp); }
  private row(value: AttachmentItem) { return this.state.items.find(r => r.att_id === value.att_id && r.pid === value.pid && r.canonical_url === value.canonical_url && r.real_name === value.real_name); }
  private selectedRows(ids: number[]) { return ids.length > 0 && ids.length <= 50 && ids.every(n => this.state.items.some(r => r.att_id === n && r.pid === this.state.query.pid)); }
  invalidate(clearCategories = true) {
    this.epoch++; for (const job of this.jobs.values()) job.abort.abort(); this.jobs.clear();
    Object.assign(this.state, { items: [], count: 0, selected: [], targetPid: 0, rename: null, ready: false, loading: false, categoryLoading: false, busy: '', error: '', notice: '', needsReview: false });
    if (clearCategories) Object.assign(this.state, { query: initialQuery(), categories: [], categoriesReady: false, categoryError: '' });
  }
  dispose() { this.alive = false; this.invalidate(); }
  async activate() { this.invalidate(); if (this.canView) await Promise.all([this.loadCategories(), this.load()]); }
  async loadCategories() {
    if (!this.canView) return; const job = this.start('categories'); this.state.categoryLoading = true; this.state.categoriesReady = false; this.state.categoryError = '';
    try { const rows = decodeLibraryCategories(await this.ports.categories(job.abort.signal)); if (this.valid('categories', job)) { this.state.categories = rows; this.state.categoriesReady = true; } }
    catch (reason) { if (this.valid('categories', job)) this.state.categoryError = message(reason); }
    finally { if (this.finish('categories', job)) this.state.categoryLoading = false; }
  }
  async load() {
    if (!this.canView || this.state.busy) return; const job = this.start('list'), query = { ...this.state.query }; this.state.loading = true; this.state.ready = false; this.state.error = '';
    try { const result = decodeLibraryPage(await this.ports.list({ ...query, file_type: 1 }, job.abort.signal), query); if (!this.valid('list', job)) return;
      this.state.items = result.list; this.state.count = result.count; this.state.ready = true; this.state.needsReview = false;
      this.state.selected = this.state.selected.filter(n => result.list.some(r => r.att_id === n));
      if (this.state.rename && !result.list.some(r => r.att_id === this.state.rename!.id)) this.state.rename = null;
    } catch (reason) { if (this.valid('list', job)) this.state.error = message(reason); }
    finally { if (this.finish('list', job)) this.state.loading = false; }
  }
  async setQuery(changes: Partial<AttachmentQuery>) {
    if (!this.canView) return; const next = { ...this.state.query, ...changes };
    if (!id(next.pid, true) || !id(next.page) || ![20, 50].includes(next.limit) || typeof next.name !== 'string' || [...next.name].length > 80 || /[\u0000-\u001f\u007f]/.test(next.name)) return;
    if (next.pid > 0 && (!this.state.categoriesReady || !this.state.categories.some(c => c.id === next.pid))) return;
    this.invalidate(false); this.state.query = { ...next, name: next.name.trim() };
    await Promise.all([this.load(), ...(this.state.categoriesReady ? [] : [this.loadCategories()])]);
  }
  toggle(item: AttachmentItem, checked: boolean) {
    if (!this.writable || !this.row(item)) return;
    if (!checked) this.state.selected = this.state.selected.filter(n => n !== item.att_id);
    else if (!this.state.selected.includes(item.att_id) && this.state.selected.length < 50) this.state.selected = [...this.state.selected, item.att_id];
  }
  selectPage() { if (this.writable) this.state.selected = this.state.items.map(r => r.att_id); }
  clearSelection() { if (!this.locked) this.state.selected = []; }
  setTarget(pid: number) { if (this.writable && id(pid, true) && (pid === 0 || this.state.categories.some(c => c.id === pid))) this.state.targetPid = pid; }
  openRename(item: AttachmentItem) { if (this.writable && this.row(item)) this.state.rename = { id: item.att_id, name: item.real_name }; }
  setRenameName(value: string) { if (this.state.rename && !this.locked && this.canManage) this.state.rename.name = value; }
  closeRename() { if (!this.locked) this.state.rename = null; }
  private async write(label: string, submit: (signal: AbortSignal) => Promise<unknown>, accept: (result: unknown) => void, confirmation?: string): Promise<boolean> {
    if (!this.writable) return false; const job = this.start('write'); this.state.busy = label; this.state.error = ''; this.state.notice = ''; let submitted = false, success = false;
    try { if (confirmation) await this.ports.confirm(confirmation); if (!this.valid('write', job) || !this.canManage) return false;
      submitted = true; const result = await submit(job.abort.signal); if (!this.valid('write', job) || !this.canManage) return false;
      accept(result); this.state.notice = `${label}已确认`; success = true;
    } catch (reason) { if (this.valid('write', job) && reason !== 'cancel' && reason !== 'close') { this.state.error = submitted ? `${label}结果未确认：${message(reason)}。已保留选择和草稿，请重新读取核对后再操作。` : message(reason); this.state.needsReview = submitted; } }
    finally { if (this.finish('write', job)) this.state.busy = ''; }
    if (success && this.current(job.stamp)) await this.load(); return success && this.current(job.stamp);
  }
  async move() {
    if (!this.writable) return false;
    let input: AttachmentMoveInput;
    try { input = normalizeAttachmentMove(this.state.selected, this.state.targetPid); if (!this.selectedRows(input.ids) || input.pid !== 0 && !this.state.categories.some(c => c.id === input.pid)) throw Error('选中图片或目标分类已脱离当前范围'); }
    catch (reason) { this.state.error = message(reason); return false; }
    const frozen = { ids: [...input.ids], pid: input.pid }, label = input.pid === 0 ? '根目录' : this.state.categories.find(c => c.id === input.pid)!.label;
    return this.write('移动', signal => {
      if (!this.selectedRows(frozen.ids) || JSON.stringify([...this.state.selected].sort((a, b) => a - b)) !== JSON.stringify(frozen.ids) || this.state.targetPid !== frozen.pid) throw Error('原移动选择已改变');
      return this.ports.move({ ids: [...frozen.ids], pid: frozen.pid }, signal);
    }, result => { const r = record(result); if (r.pid !== frozen.pid || !Array.isArray(r.ids) || r.ids.length !== frozen.ids.length || r.ids.some((n, i) => n !== frozen.ids[i])) throw Error('移动响应未匹配全部原图片'); this.state.selected = []; }, `将选中的${frozen.ids.length}张图片移动到“${label}”？`);
  }
  async rename() {
    if (!this.writable || !this.state.rename) return false; let frozen: AttachmentRenameInput;
    try { frozen = normalizeAttachmentRename(this.state.rename.id, this.state.rename.name); if (!this.selectedRows([frozen.id])) throw Error('原图片已脱离当前范围'); }
    catch (reason) { this.state.error = message(reason); return false; }
    return this.write('重命名', signal => this.ports.rename({ ...frozen }, signal), result => { const r = record(result); if (r.id !== frozen.id || r.real_name !== frozen.real_name) throw Error('重命名响应未匹配原图片和名称'); this.state.rename = null; });
  }
  async remove(item: AttachmentItem) {
    if (!this.writable || !this.row(item)) return false; const target = item.att_id;
    return this.write('删除', signal => this.ports.remove([target], signal), result => { const r = record(result); if (r.deleted !== 1 || !Array.isArray(r.ids) || r.ids.length !== 1 || r.ids[0] !== target) throw Error('删除响应未匹配原图片'); this.state.selected = this.state.selected.filter(n => n !== target); if (this.state.rename?.id === target) this.state.rename = null; }, `确认删除“${item.real_name}”？元数据删除后对象将由队列清理。`);
  }
  async upload(file: File) {
    if (!this.writable) return false;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) { this.state.error = '请选择不超过10 MiB的JPEG、PNG、WebP或GIF图片'; return false; }
    const pid = this.state.query.pid;
    return this.write('上传', signal => this.ports.upload(file, pid, signal), result => { if (!id(record(result).att_id)) throw Error('上传响应格式错误'); });
  }
  async createCategory(value: string) {
    if (!this.writable || !name(value.trim(), 50)) { if (this.writable) this.state.error = '请输入1至50字的分类名称'; return false; }
    const stamp = this.stamp();
    const saved = await this.write('新建分类', signal => this.ports.createCategory(value.trim(), signal), result => { if (!id(record(result).id)) throw Error('分类响应格式错误'); });
    if (saved && this.current(stamp)) await this.loadCategories(); return saved && this.current(stamp);
  }
}
