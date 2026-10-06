import { isProductCategoryStyleValue, productCategoryStyleCanonical, type ProductCategoryStyleValue } from './productCategoryStyle';

export interface CategoryStyleSnapshot { revision: string; value: ProductCategoryStyleValue | null; configured: boolean; editable: boolean; issues: string[] }
export interface CategoryStyleWrite extends ProductCategoryStyleValue { operationId: string; revision: string }
export interface CategoryStyleReceipt { operation: 'update'; id: number; operationId: string; payloadHash: string }
export interface CategoryStylePending { version: 1; actor: number; input: CategoryStyleWrite; fingerprint: string }
export interface CategoryStyleActor { id: number | null; identity: string; stored: string | null; view: boolean; manage: boolean }
export interface CategoryStylePorts {
  read: (signal?: AbortSignal) => Promise<CategoryStyleSnapshot>;
  write: (value: CategoryStyleWrite, signal?: AbortSignal) => Promise<CategoryStyleReceipt>;
  receipt: (id: string, signal?: AbortSignal) => Promise<CategoryStyleReceipt>;
  confirm: (message: string) => Promise<void>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  uuid: () => string;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品分类样式数据格式错误'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('商品分类样式字段不完整或含额外字段'); }
export function parseCategoryStyleSnapshot(value: unknown): CategoryStyleSnapshot {
  const row = object(value); exact(row, ['revision', 'value', 'configured', 'editable', 'issues']);
  if (!digest(row.revision) || row.value !== null && !isProductCategoryStyleValue(row.value) || typeof row.configured !== 'boolean' || typeof row.editable !== 'boolean' || !Array.isArray(row.issues) || row.issues.length > 20 || row.issues.some(issue => typeof issue !== 'string' || [...issue].length > 256 || /[\u0000-\u001f\u007f]/u.test(issue)) || row.configured && row.value === null || row.editable && row.value === null) throw Error('商品分类样式快照无效');
  if (row.value !== null) exact(object(row.value), ['level', 'index']);
  if (row.editable && !row.configured && ((row.value as ProductCategoryStyleValue).level !== 2 || (row.value as ProductCategoryStyleValue).index !== 1)) throw Error('未配置商品分类样式的默认值无效');
  return row as unknown as CategoryStyleSnapshot;
}
export function normalizeCategoryStyleWrite(value: unknown): CategoryStyleWrite {
  const row = object(value); exact(row, ['operationId', 'revision', 'level', 'index']);
  if (!uuid(row.operationId) || !digest(row.revision) || !isProductCategoryStyleValue({ level: row.level, index: row.index })) throw Error('请选择有效分类等级与样式并读取当前版本');
  return { operationId: row.operationId, revision: row.revision, level: row.level as 2 | 3, index: row.index as number };
}
export async function categoryStyleFingerprint(value: CategoryStyleWrite): Promise<string> {
  const input = normalizeCategoryStyleWrite(value);
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(productCategoryStyleCanonical(input))));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseCategoryStyleReceipt(value: unknown, operationId: string): CategoryStyleReceipt {
  const row = object(value); exact(row, ['operation', 'id', 'operationId', 'payloadHash']);
  if (row.operation !== 'update' || !positive(row.id) || row.operationId !== operationId || !uuid(row.operationId) || !digest(row.payloadHash)) throw Error('回执不完整或不属于原请求');
  return row as unknown as CategoryStyleReceipt;
}
function assertReceipt(receipt: CategoryStyleReceipt, pending: CategoryStylePending) { parseCategoryStyleReceipt(receipt, pending.input.operationId); if (receipt.payloadHash !== pending.fingerprint) throw Error('回执内容与原请求不一致，请继续核对'); }
export const categoryStylePendingKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_product_category_style_pending:${actor}`; };
export const categoryStyleDraftKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_product_category_style_rejected_draft:${actor}`; };
export async function parseCategoryStylePending(raw: string, actor: number): Promise<CategoryStylePending> {
  if (raw.length > 8192) throw Error('原请求记录过大');
  const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'input', 'fingerprint']); const input = normalizeCategoryStyleWrite(row.input);
  if (row.version !== 1 || row.actor !== actor || !positive(actor) || !digest(row.fingerprint) || JSON.stringify(input) !== JSON.stringify(row.input) || await categoryStyleFingerprint(input) !== row.fingerprint) throw Error('原请求身份或内容无效');
  return { version: 1, actor, input, fingerprint: row.fingerprint };
}
function response(reason: unknown): { status: unknown; data: Record<string, unknown> } | null { const row = reason as { isAxiosError?: boolean; response?: { status: unknown; data: Record<string, unknown> } } | null; return row?.isAxiosError === true && row.response && typeof row.response.data === 'object' && row.response.data !== null ? row.response : null; }
function definitive(reason: unknown, pending: CategoryStylePending): boolean {
  const actual = response(reason); if (!actual || ![400, 409].includes(actual.status as number) || actual.data.status !== actual.status) return false;
  const data = actual.data.data as Record<string, unknown> | undefined;
  return !!data && data.code === (actual.status === 409 ? 'PRODUCT_CATEGORY_STYLE_STALE_VERSION' : 'PRODUCT_CATEGORY_STYLE_REJECTED') && data.operation === 'update' && data.operationId === pending.input.operationId && data.payloadHash === pending.fingerprint;
}
export function categoryStyleErrorMessage(reason: unknown): string { const row = response(reason), text = row?.data.msg ?? (reason instanceof Error ? reason.message : null); return typeof text === 'string' && text && [...text].length <= 512 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '请求失败，请重新核对'; }
interface Stamp { epoch: number; identity: string; stored: string | null }
interface Job { stamp: Stamp; controller: AbortController }
export interface CategoryStyleState {
  snapshot: CategoryStyleSnapshot | null; selected: ProductCategoryStyleValue; pending: CategoryStylePending | null; rejected: CategoryStylePending | null;
  ready: boolean; needsReread: boolean; retryReady: boolean; loading: boolean; busy: boolean; confirming: boolean; restoring: boolean; readingReceipt: boolean;
  error: string; notice: string; recoveryError: string; success: boolean;
}
/** A persisted immutable actor-bound intent survives unknown writes; all replies are generation fenced. */
export class ProductCategoryStyleController {
  readonly state: CategoryStyleState;
  private epoch = 0; private alive = true; private confirmation = 0; private jobs = new Map<string, Job>();
  constructor(private actor: () => CategoryStyleActor, private ports: CategoryStylePorts, observe: (value: CategoryStyleState) => CategoryStyleState = value => value) {
    this.state = observe({ snapshot: null, selected: { level: 2, index: 1 }, pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false });
  }
  private stamp(): Stamp { return { epoch: this.epoch, identity: this.actor().identity, stored: this.actor().stored }; }
  private current(stamp: Stamp) { const actor = this.actor(); return this.alive && actor.view && stamp.epoch === this.epoch && stamp.identity === actor.identity && stamp.stored === actor.stored; }
  private begin(channel: string): Job { this.jobs.get(channel)?.controller.abort(); const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job; }
  private valid(channel: string, job: Job) { return this.jobs.get(channel) === job && this.current(job.stamp); }
  private finish(channel: string, job: Job) { if (!this.valid(channel, job)) return false; this.jobs.delete(channel); return true; }
  get locked() { const s = this.state; return s.loading || s.busy || s.confirming || s.restoring || s.readingReceipt || !!s.pending || !!s.recoveryError; }
  get editorDisabled() { return !this.actor().manage || this.locked || !this.state.ready || !this.state.snapshot?.editable; }
  select(index: unknown) { if (!this.editorDisabled && isProductCategoryStyleValue({ level: this.state.selected.level, index })) this.state.selected = { level: this.state.selected.level, index: index as number }; }
  setLevel(level: unknown) { if (!this.editorDisabled && (level === 2 || level === 3) && this.state.selected.level !== level) this.state.selected = { level, index: 0 }; }
  private persisted(value: CategoryStylePending) { if (this.ports.storage.getItem(categoryStylePendingKey(value.actor)) !== JSON.stringify(value)) throw Error('本地原请求已变化，请核对后恢复'); }
  private clear(value: CategoryStylePending) { this.persisted(value); this.ports.storage.removeItem(categoryStylePendingKey(value.actor)); this.state.pending = null; this.state.retryReady = false; }
  private accept(value: CategoryStyleReceipt, pending: CategoryStylePending) { assertReceipt(value, pending); this.ports.storage.removeItem(categoryStyleDraftKey(pending.actor)); this.clear(pending); this.state.rejected = null; this.state.needsReread = false; this.state.notice = '商品分类样式已确认保存，正在读取当前配置。'; this.state.success = true; }
  async load(preserve = false) {
    const s = this.state; if (!this.actor().view || s.busy || s.confirming || s.readingReceipt || s.restoring) return;
    const job = this.begin('load'), selected = { ...s.selected }; s.loading = true; s.ready = false; s.error = '';
    try { const value = parseCategoryStyleSnapshot(await this.ports.read(job.controller.signal)); if (!this.valid('load', job)) return; s.snapshot = value;
      if (s.pending) s.selected = { level: s.pending.input.level, index: s.pending.input.index };
      else if (preserve) { s.selected = selected; s.needsReread = false; s.notice = '已读取当前版本并保留选择，请核对后再次确认保存。'; }
      else if (s.rejected) { s.selected = { level: s.rejected.input.level, index: s.rejected.input.index }; s.needsReread = true; }
      else s.selected = value.value ? { ...value.value } : { level: 2, index: 1 };
      s.ready = true;
    } catch (reason) { if (this.valid('load', job)) s.error = `读取失败，现有选择已保留且不能保存：${categoryStyleErrorMessage(reason)}`; }
    finally { if (this.finish('load', job)) s.loading = false; }
  }
  async reread() { if (!this.locked && this.actor().view) await this.load(!!this.state.snapshot || !!this.state.rejected); }
  async activate() {
    this.invalidate(); const s = this.state, stamp = this.stamp(), actor = this.actor(); if (!actor.view || !actor.id) return; s.restoring = true;
    try { const raw = this.ports.storage.getItem(categoryStylePendingKey(actor.id)), draft = raw ? null : this.ports.storage.getItem(categoryStyleDraftKey(actor.id));
      if (raw || draft) { const value = await parseCategoryStylePending((raw || draft)!, actor.id); if (!this.current(stamp)) return; if (raw) s.pending = value; else { s.rejected = value; s.needsReread = true; } s.selected = { level: value.input.level, index: value.input.index }; }
    } catch (reason) { if (this.current(stamp)) s.recoveryError = `原请求无法安全恢复：${categoryStyleErrorMessage(reason)}`; }
    finally { if (this.current(stamp)) s.restoring = false; }
    if (this.current(stamp)) await this.load();
  }
  async save() {
    const s = this.state; if (this.editorDisabled || s.needsReread || !s.snapshot || !this.actor().id) return;
    const stamp = this.stamp(), version = ++this.confirmation; s.confirming = true; s.success = false; s.notice = ''; let frozen: CategoryStylePending | null = null;
    try { const input = normalizeCategoryStyleWrite({ operationId: this.ports.uuid(), revision: s.snapshot.revision, ...s.selected }), fingerprint = await categoryStyleFingerprint(input);
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage) return;
      await this.ports.confirm(`确认保存${input.level === 2 ? '二级' : '三级'}分类的样式 ${input.index + 1}？商城分类页将使用所选分类导航和商品布局。`);
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage || s.pending || s.recoveryError) return;
      frozen = { version: 1, actor: this.actor().id!, input, fingerprint }; const key = categoryStylePendingKey(frozen.actor); if (this.ports.storage.getItem(key) !== null) throw Error('已有未完成请求，请重新打开并核对');
      this.ports.storage.setItem(key, JSON.stringify(frozen)); s.pending = frozen; this.persisted(frozen);
    } catch (reason) { if (this.current(stamp) && reason !== 'cancel' && reason !== 'close') s.notice = categoryStyleErrorMessage(reason); frozen = null; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && frozen && s.pending?.input.operationId === frozen.input.operationId) await this.submit(frozen);
  }
  private async submit(value: CategoryStylePending) {
    const s = this.state; if (!this.actor().manage || !this.current(this.stamp()) || s.busy || s.readingReceipt || s.pending?.input.operationId !== value.input.operationId) return;
    try { this.persisted(value); } catch (reason) { s.recoveryError = categoryStyleErrorMessage(reason); return; }
    const job = this.begin('write'); s.busy = true; s.retryReady = false; s.notice = '';
    try { const receipt = await this.ports.write(value.input, job.controller.signal); if (this.valid('write', job) && this.actor().manage) this.accept(receipt, value); }
    catch (reason) { if (!this.valid('write', job)) return;
      if (definitive(reason, value)) { try { this.ports.storage.setItem(categoryStyleDraftKey(value.actor), JSON.stringify(value)); this.clear(value); s.rejected = value; s.selected = { level: value.input.level, index: value.input.index }; s.needsReread = true; s.notice = `本次未保存：${response(reason)?.status === 409 ? '配置版本已改变' : categoryStyleErrorMessage(reason)}。选择已保留，请读取当前版本并核对。`; } catch (failure) { s.recoveryError = categoryStyleErrorMessage(failure); } }
      else s.notice = `提交结果尚未确认：${categoryStyleErrorMessage(reason)}。请读取原请求回执，不能发起新的提交。`;
    } finally { if (this.finish('write', job)) s.busy = false; }
    if (this.current(job.stamp) && !s.pending && !s.rejected && !s.recoveryError) await this.load();
  }
  async readReceipt() {
    const s = this.state; if (!s.pending || s.busy || s.confirming || s.readingReceipt || s.restoring || !this.actor().view) return;
    const value = s.pending, job = this.begin('receipt'); s.readingReceipt = true; s.retryReady = false;
    try { const receipt = await this.ports.receipt(value.input.operationId, job.controller.signal); if (this.valid('receipt', job)) this.accept(receipt, value); }
    catch (reason) { if (this.valid('receipt', job)) { if (response(reason)?.status === 404) { s.retryReady = true; s.notice = '服务端明确未找到原请求回执，可主动原样重试，原版本与选择保持不变。'; } else s.notice = `原请求仍未确认：${categoryStyleErrorMessage(reason)}`; } }
    finally { if (this.finish('receipt', job)) s.readingReceipt = false; }
    if (this.current(job.stamp) && !s.pending && !s.recoveryError) await this.load();
  }
  async retryOriginal() {
    const s = this.state; if (!s.pending || !s.retryReady || !this.actor().manage || s.busy || s.readingReceipt || s.confirming || s.restoring) return;
    const value = s.pending, stamp = this.stamp(), version = ++this.confirmation; s.confirming = true;
    try { await this.ports.confirm('确认原样重试相同分类样式请求？原请求标识、版本、分类等级和样式均保持不变。'); } catch { return; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && version === this.confirmation && this.actor().manage && s.pending === value && s.retryReady) await this.submit(value);
  }
  invalidate() { this.epoch++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); this.confirmation++; Object.assign(this.state, { snapshot: null, selected: { level: 2, index: 1 }, pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false }); }
  dispose() { this.invalidate(); this.alive = false; }
}
