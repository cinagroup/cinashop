import { cloneProductDetailDesign, isProductDetailDesignValue, productDetailDesignPayload, type ProductDetailDesignValue, type ProductDetailDesignSnapshot, type ProductDetailDesignReceipt } from './productDetailDesign';

export interface DetailDesignWrite { operationId: string; revision: string; value: ProductDetailDesignValue }
export interface DetailDesignPending { version: 1; actor: number; input: DetailDesignWrite; fingerprint: string }
export interface DetailDesignActor { id: number | null; identity: string; stored: string | null; view: boolean; manage: boolean }
export interface DetailDesignPorts {
  read: (signal?: AbortSignal) => Promise<ProductDetailDesignSnapshot>;
  write: (value: DetailDesignWrite, signal?: AbortSignal) => Promise<ProductDetailDesignReceipt>;
  receipt: (id: string, signal?: AbortSignal) => Promise<ProductDetailDesignReceipt>;
  confirm: (message: string) => Promise<void>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  uuid: () => string;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品详情设计数据格式错误'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('商品详情设计字段不完整或含额外字段'); }
const equal = (left: ProductDetailDesignValue, right: ProductDetailDesignValue) => JSON.stringify(cloneProductDetailDesign(left)) === JSON.stringify(cloneProductDetailDesign(right));
export function parseDetailDesignSnapshot(value: unknown): ProductDetailDesignSnapshot {
  const row = object(value); exact(row, ['revision', 'value', 'configured', 'editable', 'issues']);
  if (!digest(row.revision) || row.value !== null && !isProductDetailDesignValue(row.value) || typeof row.configured !== 'boolean' || typeof row.editable !== 'boolean'
    || row.editable && row.value === null || !Array.isArray(row.issues) || row.issues.length > 20
    || row.issues.some(issue => typeof issue !== 'string' || [...issue].length > 256 || /[\u0000-\u001f\u007f]/u.test(issue))) throw Error('商品详情设计快照无效');
  if (row.editable && !row.configured && !equal(row.value as ProductDetailDesignValue, cloneProductDetailDesign())) throw Error('未配置商品详情设计的默认值无效');
  return { revision: row.revision, value: row.value === null ? null : cloneProductDetailDesign(row.value as ProductDetailDesignValue), configured: row.configured, editable: row.editable, issues: [...row.issues] as string[] };
}
export function normalizeDetailDesignWrite(value: unknown): DetailDesignWrite {
  const row = object(value); exact(row, ['operationId', 'revision', 'value']);
  if (!uuid(row.operationId) || !digest(row.revision) || !isProductDetailDesignValue(row.value)) throw Error('请核对全部商品详情设置并读取当前版本');
  return { operationId: row.operationId, revision: row.revision, value: cloneProductDetailDesign(row.value) };
}
export async function detailDesignFingerprint(value: DetailDesignWrite): Promise<string> {
  const input = normalizeDetailDesignWrite(value);
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(productDetailDesignPayload(input.revision, input.value))));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseDetailDesignReceipt(value: unknown, operationId: string): ProductDetailDesignReceipt {
  const row = object(value); exact(row, ['operation', 'id', 'operationId', 'payloadHash']);
  if (row.operation !== 'update' || !positive(row.id) || row.operationId !== operationId || !uuid(row.operationId) || !digest(row.payloadHash)) throw Error('回执不完整或不属于原请求');
  return { operation: 'update', id: row.id, operationId: row.operationId, payloadHash: row.payloadHash };
}
function assertReceipt(receipt: ProductDetailDesignReceipt, pending: DetailDesignPending) { parseDetailDesignReceipt(receipt, pending.input.operationId); if (receipt.payloadHash !== pending.fingerprint) throw Error('回执内容与原请求不一致，请继续核对'); }
export const detailDesignPendingKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_product_detail_design_pending:${actor}`; };
export const detailDesignDraftKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_product_detail_design_rejected_draft:${actor}`; };
function freezeIntent(value: DetailDesignPending): DetailDesignPending {
  for (const field of Object.values(value.input.value)) if (Array.isArray(field)) Object.freeze(field);
  Object.freeze(value.input.value); Object.freeze(value.input); return Object.freeze(value);
}
export async function parseDetailDesignPending(raw: string, actor: number): Promise<DetailDesignPending> {
  if (raw.length > 16384) throw Error('原请求记录过大');
  const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'input', 'fingerprint']); const input = normalizeDetailDesignWrite(row.input);
  if (row.version !== 1 || row.actor !== actor || !positive(actor) || !digest(row.fingerprint) || JSON.stringify(input) !== JSON.stringify(row.input) || await detailDesignFingerprint(input) !== row.fingerprint) throw Error('原请求身份或内容无效');
  return freezeIntent({ version: 1, actor, input, fingerprint: row.fingerprint });
}
function response(reason: unknown): { status: unknown; data: Record<string, unknown> } | null {
  const row = reason as { isAxiosError?: boolean; response?: { status: unknown; data: Record<string, unknown> } } | null;
  return row?.isAxiosError === true && row.response && typeof row.response.data === 'object' && row.response.data !== null && !Array.isArray(row.response.data) ? row.response : null;
}
function definitive(reason: unknown, pending: DetailDesignPending): boolean {
  const actual = response(reason); if (!actual || ![400, 409].includes(actual.status as number) || actual.data.status !== actual.status) return false;
  const data = actual.data.data as Record<string, unknown> | undefined;
  return !!data && data.code === (actual.status === 409 ? 'PRODUCT_DETAIL_DESIGN_STALE_VERSION' : 'PRODUCT_DETAIL_DESIGN_REJECTED') && data.operation === 'update' && data.operationId === pending.input.operationId && data.payloadHash === pending.fingerprint;
}
export function detailDesignErrorMessage(reason: unknown): string {
  const row = response(reason), text = row?.data.msg ?? (reason instanceof Error ? reason.message : null);
  return typeof text === 'string' && text && [...text].length <= 512 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '请求失败，请重新核对';
}
type SelectionKey = 'navList' | 'isOpen' | 'showService' | 'menuList';
type FlagKey = 'openShare' | 'pictureConfig' | 'swiperDot' | 'showSvip' | 'showRank' | 'showReply' | 'showMatch' | 'showRecommend' | 'showCart' | 'showCommunity';
type CountKey = 'replyNum' | 'matchNum' | 'recommendNum' | 'communityNum';
const flags: FlagKey[] = ['openShare', 'pictureConfig', 'swiperDot', 'showSvip', 'showRank', 'showReply', 'showMatch', 'showRecommend', 'showCart', 'showCommunity'];
const counts: Record<CountKey, number> = { replyNum: 10, matchNum: 10, recommendNum: 24, communityNum: 10 };
interface Stamp { epoch: number; actor: number | null; identity: string; stored: string | null }
interface Job { stamp: Stamp; controller: AbortController }
export interface DetailDesignState {
  snapshot: ProductDetailDesignSnapshot | null; draft: ProductDetailDesignValue; pending: DetailDesignPending | null; rejected: DetailDesignPending | null;
  ready: boolean; needsReread: boolean; retryReady: boolean; loading: boolean; busy: boolean; confirming: boolean; restoring: boolean; readingReceipt: boolean;
  error: string; notice: string; recoveryError: string; success: boolean; syncedReadonly: string[];
}
/** Actor-bound immutable full-nineteen intent; no write can bypass a persisted unknown operation. */
export class ProductDetailDesignController {
  readonly state: DetailDesignState;
  private epoch = 0; private alive = true; private confirmation = 0; private jobs = new Map<string, Job>();
  constructor(private actor: () => DetailDesignActor, private ports: DetailDesignPorts, observe: (value: DetailDesignState) => DetailDesignState = value => value) {
    this.state = observe({ snapshot: null, draft: cloneProductDetailDesign(), pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false, syncedReadonly: [] });
  }
  private stamp(): Stamp { const actor = this.actor(); return { epoch: this.epoch, actor: actor.id, identity: actor.identity, stored: actor.stored }; }
  private current(stamp: Stamp) { const actor = this.actor(); return this.alive && actor.view && stamp.epoch === this.epoch && stamp.actor === actor.id && stamp.identity === actor.identity && stamp.stored === actor.stored; }
  private begin(channel: string): Job { this.jobs.get(channel)?.controller.abort(); const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job; }
  private valid(channel: string, job: Job) { return this.jobs.get(channel) === job && this.current(job.stamp); }
  private finish(channel: string, job: Job) { if (!this.valid(channel, job)) return false; this.jobs.delete(channel); return true; }
  get locked() { const s = this.state; return s.loading || s.busy || s.confirming || s.restoring || s.readingReceipt || !!s.pending || !!s.recoveryError; }
  get editorDisabled() { return !this.actor().manage || this.locked || !this.state.ready || !this.state.snapshot?.editable; }
  get dirty() { return !!this.state.snapshot?.value && !equal(this.state.draft, this.state.snapshot.value); }
  setFlag(key: FlagKey, value: unknown) { if (!this.editorDisabled && flags.includes(key) && (value === 0 || value === 1)) { this.state.draft[key] = value; this.state.success = false; } }
  setCount(key: CountKey, value: unknown) {
    if (this.editorDisabled || !Object.hasOwn(counts, key)) return;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > counts[key]) { this.state.notice = `数量须为 1 至 ${counts[key]} 的整数，原数量已保留。`; return; }
    this.state.draft[key] = value; this.state.success = false;
  }
  toggleSelection(key: SelectionKey, value: number, checked: unknown) {
    const last: Record<SelectionKey, number> = { navList: 4, isOpen: 2, showService: 3, menuList: 4 };
    if (this.editorDisabled || !Object.hasOwn(last, key) || !Number.isSafeInteger(value) || value < 0 || value > last[key] || typeof checked !== 'boolean') return;
    const old = this.state.draft[key];
    if (checked && !old.includes(value)) { if (key === 'menuList' && old.length >= 3) { this.state.notice = '底部菜单最多选择三项。'; return; } this.state.draft[key] = [...old, value]; }
    else if (!checked && old.includes(value)) this.state.draft[key] = old.filter(item => item !== value);
    this.state.success = false;
  }
  private preserveReadonly(draft: ProductDetailDesignValue, current: ProductDetailDesignValue): ProductDetailDesignValue {
    const result = cloneProductDetailDesign(draft); result.showPrice = [...current.showPrice];
    if (JSON.stringify(draft.isOpen.filter(item => item >= 3)) !== JSON.stringify(current.isOpen.filter(item => item >= 3))) {
      result.isOpen = draft.isOpen.filter(item => item <= 2);
      current.isOpen.forEach((item, index) => { if (item >= 3) result.isOpen.splice(Math.min(index, result.isOpen.length), 0, item); });
    }
    return result;
  }
  private persisted(value: DetailDesignPending) { if (this.ports.storage.getItem(detailDesignPendingKey(value.actor)) !== JSON.stringify(value)) throw Error('本地原请求已变化，请核对后恢复'); }
  private clear(value: DetailDesignPending) { this.persisted(value); this.ports.storage.removeItem(detailDesignPendingKey(value.actor)); this.state.pending = null; this.state.retryReady = false; }
  private accept(value: ProductDetailDesignReceipt, pending: DetailDesignPending) { assertReceipt(value, pending); this.ports.storage.removeItem(detailDesignDraftKey(pending.actor)); this.clear(pending); this.state.rejected = null; this.state.needsReread = false; this.state.notice = '商品详情设计已确认保存，正在读取当前配置。'; this.state.success = true; }
  async load(preserve = false) {
    const s = this.state; if (!this.actor().view || s.busy || s.confirming || s.readingReceipt || s.restoring) return;
    const job = this.begin('load'), draft = cloneProductDetailDesign(s.draft); s.loading = true; s.ready = false; s.error = '';
    try {
      const value = parseDetailDesignSnapshot(await this.ports.read(job.controller.signal)); if (!this.valid('load', job)) return; s.snapshot = value;
      if (s.pending) s.draft = cloneProductDetailDesign(s.pending.input.value);
      else if (preserve) {
        s.syncedReadonly = value.value ? [
          ...(JSON.stringify(draft.showPrice) !== JSON.stringify(value.value.showPrice) ? ['会员展示项 showPrice'] : []),
          ...(JSON.stringify(draft.isOpen.filter(item => item >= 3)) !== JSON.stringify(value.value.isOpen.filter(item => item >= 3)) ? ['历史保留项 isOpen 3/4/5'] : []),
        ] : [];
        s.draft = value.value ? this.preserveReadonly(draft, value.value) : draft; s.needsReread = false;
        s.notice = `已读取当前版本并保留十八个可编辑项。${s.syncedReadonly.length ? `已同步当前配置的只读项：${s.syncedReadonly.join('、')}。` : '只读会员展示项与历史保留项已核对，无变化。'}请核对预览后再次确认保存。`;
      }
      else if (s.rejected) { s.draft = cloneProductDetailDesign(s.rejected.input.value); s.needsReread = true; }
      else s.draft = value.value ? cloneProductDetailDesign(value.value) : cloneProductDetailDesign();
      s.ready = true;
    } catch (reason) { if (this.valid('load', job)) s.error = `读取失败，现有草稿已保留且不能保存：${detailDesignErrorMessage(reason)}`; }
    finally { if (this.finish('load', job)) s.loading = false; }
  }
  async reread() { if (!this.locked && this.actor().view) await this.load(!!this.state.snapshot || !!this.state.rejected); }
  async activate() {
    this.invalidate(); const s = this.state, stamp = this.stamp(), actor = this.actor(); if (!actor.view || !positive(actor.id)) return; s.restoring = true;
    try {
      const raw = this.ports.storage.getItem(detailDesignPendingKey(actor.id)), draft = raw ? null : this.ports.storage.getItem(detailDesignDraftKey(actor.id));
      if (raw || draft) { const value = await parseDetailDesignPending((raw || draft)!, actor.id); if (!this.current(stamp)) return; if (raw) s.pending = value; else { s.rejected = value; s.needsReread = true; } s.draft = cloneProductDetailDesign(value.input.value); }
    } catch (reason) { if (this.current(stamp)) s.recoveryError = `原请求无法安全恢复：${detailDesignErrorMessage(reason)}`; }
    finally { if (this.current(stamp)) s.restoring = false; }
    if (this.current(stamp)) await this.load();
  }
  async save() {
    const s = this.state; if (this.editorDisabled || s.needsReread || !s.snapshot || !positive(this.actor().id)) return;
    const stamp = this.stamp(), version = ++this.confirmation; s.confirming = true; s.success = false; s.notice = ''; let frozen: DetailDesignPending | null = null;
    try {
      if (!s.snapshot.value || JSON.stringify(s.draft.showPrice) !== JSON.stringify(s.snapshot.value.showPrice)
        || JSON.stringify(s.draft.isOpen.filter(item => item >= 3)) !== JSON.stringify(s.snapshot.value.isOpen.filter(item => item >= 3))) throw Error('只读会员展示项或历史保留项与当前版本不一致，请重新读取并核对');
      const operationId = this.ports.uuid(); if (operationId === s.rejected?.input.operationId) throw Error('新的保存请求必须使用新的请求标识，请再次确认');
      const input = normalizeDetailDesignWrite({ operationId, revision: s.snapshot.revision, value: s.draft }), fingerprint = await detailDesignFingerprint(input);
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage) return;
      await this.ports.confirm('确认保存商品详情设计？顶部导航、主图、会员、排行榜、服务与参数、评价、种草秀、搭配购、推荐和底部菜单将按当前预览展示；商品价格、库存与结算规则以商城实际数据为准。');
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage || s.pending || s.recoveryError) return;
      frozen = freezeIntent({ version: 1, actor: this.actor().id!, input, fingerprint }); const key = detailDesignPendingKey(frozen.actor); if (this.ports.storage.getItem(key) !== null) throw Error('已有未完成请求，请重新打开并核对');
      this.ports.storage.setItem(key, JSON.stringify(frozen)); s.pending = frozen; this.persisted(frozen);
    } catch (reason) { if (this.current(stamp) && reason !== 'cancel' && reason !== 'close') s.notice = detailDesignErrorMessage(reason); frozen = null; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && frozen && s.pending?.input.operationId === frozen.input.operationId) await this.submit(frozen);
  }
  private async submit(value: DetailDesignPending) {
    const s = this.state; if (!this.actor().manage || !this.current(this.stamp()) || s.busy || s.readingReceipt || s.pending?.input.operationId !== value.input.operationId) return;
    try { this.persisted(value); } catch (reason) { s.recoveryError = detailDesignErrorMessage(reason); return; }
    const job = this.begin('write'); s.busy = true; s.retryReady = false; s.notice = '';
    try { const receipt = await this.ports.write(value.input, job.controller.signal); if (this.valid('write', job) && this.actor().manage) this.accept(receipt, value); }
    catch (reason) {
      if (!this.valid('write', job)) return;
      if (definitive(reason, value)) {
        try { this.ports.storage.setItem(detailDesignDraftKey(value.actor), JSON.stringify(value)); this.clear(value); s.rejected = value; s.draft = cloneProductDetailDesign(value.input.value); s.needsReread = true; s.notice = `本次未保存：${response(reason)?.status === 409 ? '配置版本已改变' : detailDesignErrorMessage(reason)}。草稿已保留，请读取当前版本并核对。`; }
        catch (failure) { s.recoveryError = detailDesignErrorMessage(failure); }
      } else s.notice = `提交结果尚未确认：${detailDesignErrorMessage(reason)}。请读取原请求回执，不能发起新的提交。`;
    } finally { if (this.finish('write', job)) s.busy = false; }
    if (this.current(job.stamp) && !s.pending && !s.rejected && !s.recoveryError) await this.load();
  }
  async readReceipt() {
    const s = this.state; if (!s.pending || s.busy || s.confirming || s.readingReceipt || s.restoring || !this.actor().view) return;
    const value = s.pending; try { this.persisted(value); } catch (reason) { s.recoveryError = detailDesignErrorMessage(reason); return; }
    const job = this.begin('receipt'); s.readingReceipt = true; s.retryReady = false;
    try { const receipt = await this.ports.receipt(value.input.operationId, job.controller.signal); if (this.valid('receipt', job)) this.accept(receipt, value); }
    catch (reason) { if (this.valid('receipt', job)) { if (response(reason)?.status === 404) { s.retryReady = true; s.notice = '服务端明确未找到原请求回执，可主动原样重试；原版本与全部十九项内容保持不变。'; } else s.notice = `原请求仍未确认：${detailDesignErrorMessage(reason)}`; } }
    finally { if (this.finish('receipt', job)) s.readingReceipt = false; }
    if (this.current(job.stamp) && !s.pending && !s.recoveryError) await this.load();
  }
  async retryOriginal() {
    const s = this.state; if (!s.pending || !s.retryReady || !this.actor().manage || s.busy || s.readingReceipt || s.confirming || s.restoring) return;
    const value = s.pending, stamp = this.stamp(), version = ++this.confirmation; s.confirming = true;
    try { await this.ports.confirm('确认原样重试相同商品详情设计请求？原请求标识、版本和全部十九项内容均保持不变。'); } catch { return; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && version === this.confirmation && this.actor().manage && s.pending === value && s.retryReady) await this.submit(value);
  }
  invalidate() {
    this.epoch++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); this.confirmation++;
    Object.assign(this.state, { snapshot: null, draft: cloneProductDetailDesign(), pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false, syncedReadonly: [] });
  }
  dispose() { this.invalidate(); this.alive = false; }
}
