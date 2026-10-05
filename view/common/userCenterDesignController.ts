import { cloneUserCenterDesign, isUserCenterDesignValue, isUserCenterPublicImage, userCenterDesignPayload, type UserCenterDesignValue, type UserCenterDesignSnapshot, type UserCenterDesignReceipt } from './userCenterDesign';

export interface UserCenterDesignWrite { operationId: string; revision: string; value: UserCenterDesignValue }
export interface UserCenterDesignPending { version: 1; actor: number; input: UserCenterDesignWrite; fingerprint: string }
export interface UserCenterDesignActor { id: number | null; identity: string; stored: string | null; view: boolean; manage: boolean }
export interface UserCenterDesignPorts {
  read: (signal?: AbortSignal) => Promise<UserCenterDesignSnapshot>;
  write: (value: UserCenterDesignWrite, signal?: AbortSignal) => Promise<UserCenterDesignReceipt>;
  receipt: (id: string, signal?: AbortSignal) => Promise<UserCenterDesignReceipt>;
  confirm: (message: string) => Promise<void>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  uuid: () => string;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
function previewUrl(value:unknown):value is string{
  return value===''||isUserCenterPublicImage(value);
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('个人中心设计数据格式错误'); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('个人中心设计字段不完整或含额外字段'); }
const equal = (left: UserCenterDesignValue, right: UserCenterDesignValue) => JSON.stringify(cloneUserCenterDesign(left)) === JSON.stringify(cloneUserCenterDesign(right));
export function parseUserCenterDesignSnapshot(value: unknown): UserCenterDesignSnapshot {
  const row = object(value); exact(row, ['revision', 'value', 'configured', 'editable', 'issues', 'imagePreviews']);
  if (!digest(row.revision) || row.value !== null && !isUserCenterDesignValue(row.value) || typeof row.configured !== 'boolean' || typeof row.editable !== 'boolean'
    || row.editable && row.value === null || !Array.isArray(row.issues) || row.issues.length > 256
    || row.issues.some(issue => typeof issue !== 'string' || [...issue].length > 256 || /[\u0000-\u001f\u007f]/u.test(issue))) throw Error('个人中心设计快照无效');
  const previews=object(row.imagePreviews); exact(previews,['poster','menu','merMenu']);
  for(const key of ['poster','menu','merMenu'] as const){const list=previews[key];if(!Array.isArray(list)||list.length!==(row.value===null?0:(row.value as UserCenterDesignValue)[key].list.length)||list.some(url=>!previewUrl(url)))throw Error('个人中心素材预览与列表不一致');}
  return { revision: row.revision, value: row.value === null ? null : cloneUserCenterDesign(row.value as UserCenterDesignValue), configured: row.configured, editable: row.editable, issues: [...row.issues] as string[], imagePreviews:{poster:[...previews.poster as string[]],menu:[...previews.menu as string[]],merMenu:[...previews.merMenu as string[]]} };
}
export function normalizeUserCenterDesignWrite(value: unknown): UserCenterDesignWrite {
  const row = object(value); exact(row, ['operationId', 'revision', 'value']);
  if (!uuid(row.operationId) || !digest(row.revision) || !isUserCenterDesignValue(row.value)) throw Error('请核对全部个人中心设置并读取当前版本');
  return { operationId: row.operationId, revision: row.revision, value: cloneUserCenterDesign(row.value) };
}
export async function userCenterDesignFingerprint(value: UserCenterDesignWrite): Promise<string> {
  const input = normalizeUserCenterDesignWrite(value);
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(userCenterDesignPayload(input.revision, input.value))));
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseUserCenterDesignReceipt(value: unknown, operationId: string): UserCenterDesignReceipt {
  const row = object(value); exact(row, ['operation', 'id', 'operationId', 'payloadHash']);
  if (row.operation !== 'update' || !positive(row.id) || row.operationId !== operationId || !uuid(row.operationId) || !digest(row.payloadHash)) throw Error('回执不完整或不属于原请求');
  return { operation: 'update', id: row.id, operationId: row.operationId, payloadHash: row.payloadHash };
}
function assertReceipt(receipt: UserCenterDesignReceipt, pending: UserCenterDesignPending) { parseUserCenterDesignReceipt(receipt, pending.input.operationId); if (receipt.payloadHash !== pending.fingerprint) throw Error('回执内容与原请求不一致，请继续核对'); }
export const userCenterDesignPendingKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_user_center_design_pending:${actor}`; };
export const userCenterDesignDraftKey = (actor: number) => { if (!positive(actor)) throw Error('管理员身份无效'); return `admin_user_center_design_rejected_draft:${actor}`; };
function freezeIntent(value: UserCenterDesignPending): UserCenterDesignPending {
  const freeze=(item:unknown):void=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item);}};freeze(value);return value;
}
export async function parseUserCenterDesignPending(raw: string, actor: number): Promise<UserCenterDesignPending> {
  if (raw.length > 262144) throw Error('原请求记录过大');
  const row = object(JSON.parse(raw)); exact(row, ['version', 'actor', 'input', 'fingerprint']); const input = normalizeUserCenterDesignWrite(row.input);
  if (row.version !== 1 || row.actor !== actor || !positive(actor) || !digest(row.fingerprint) || JSON.stringify(input) !== JSON.stringify(row.input) || await userCenterDesignFingerprint(input) !== row.fingerprint) throw Error('原请求身份或内容无效');
  return freezeIntent({ version: 1, actor, input, fingerprint: row.fingerprint });
}
function response(reason: unknown): { status: unknown; data: Record<string, unknown> } | null {
  const row = reason as { isAxiosError?: boolean; response?: { status: unknown; data: Record<string, unknown> } } | null;
  return row?.isAxiosError === true && row.response && typeof row.response.data === 'object' && row.response.data !== null && !Array.isArray(row.response.data) ? row.response : null;
}
function definitive(reason: unknown, pending: UserCenterDesignPending): boolean {
  const actual = response(reason); if (!actual || ![400, 409].includes(actual.status as number) || actual.data.status !== actual.status) return false;
  const data = actual.data.data as Record<string, unknown> | undefined;
  return !!data && data.code === (actual.status === 409 ? 'USER_CENTER_DESIGN_STALE_VERSION' : 'USER_CENTER_DESIGN_REJECTED') && data.operation === 'update' && data.operationId === pending.input.operationId && data.payloadHash === pending.fingerprint;
}
export function userCenterDesignErrorMessage(reason: unknown): string {
  const row = response(reason), text = row?.data.msg ?? (reason instanceof Error ? reason.message : null);
  return typeof text === 'string' && text && [...text].length <= 512 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '请求失败，请重新核对';
}
type ListKey = 'poster' | 'menu' | 'merMenu';
interface Stamp { epoch: number; actor: number | null; identity: string; stored: string | null }
interface Job { stamp: Stamp; controller: AbortController }
export interface UserCenterDesignState {
  snapshot: UserCenterDesignSnapshot | null; draft: UserCenterDesignValue; pending: UserCenterDesignPending | null; rejected: UserCenterDesignPending | null;
  ready: boolean; needsReread: boolean; retryReady: boolean; loading: boolean; busy: boolean; confirming: boolean; restoring: boolean; readingReceipt: boolean;
  error: string; notice: string; recoveryError: string; success: boolean; syncedReadonly: string[];
}
/** Actor-bound immutable six-module intent; no write can bypass a persisted unknown operation. */
export class UserCenterDesignController {
  readonly state: UserCenterDesignState;
  private epoch = 0; private alive = true; private confirmation = 0; private jobs = new Map<string, Job>();
  constructor(private actor: () => UserCenterDesignActor, private ports: UserCenterDesignPorts, observe: (value: UserCenterDesignState) => UserCenterDesignState = value => value) {
    this.state = observe({ snapshot: null, draft: cloneUserCenterDesign(), pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false, syncedReadonly: [] });
  }
  private stamp(): Stamp { const actor = this.actor(); return { epoch: this.epoch, actor: actor.id, identity: actor.identity, stored: actor.stored }; }
  private current(stamp: Stamp) { const actor = this.actor(); return this.alive && actor.view && stamp.epoch === this.epoch && stamp.actor === actor.id && stamp.identity === actor.identity && stamp.stored === actor.stored; }
  private begin(channel: string): Job { this.jobs.get(channel)?.controller.abort(); const job = { stamp: this.stamp(), controller: new AbortController() }; this.jobs.set(channel, job); return job; }
  private valid(channel: string, job: Job) { return this.jobs.get(channel) === job && this.current(job.stamp); }
  private finish(channel: string, job: Job) { if (!this.valid(channel, job)) return false; this.jobs.delete(channel); return true; }
  get locked() { const s = this.state; return s.loading || s.busy || s.confirming || s.restoring || s.readingReceipt || !!s.pending || !!s.recoveryError; }
  get editorDisabled() { return !this.actor().manage || this.locked || !this.state.ready || !this.state.snapshot?.editable; }
  get dirty() { return !!this.state.snapshot?.value && !equal(this.state.draft, this.state.snapshot.value); }
  edit(change: (draft: UserCenterDesignValue) => void) {
    if (this.editorDisabled) return false;
    const draft = cloneUserCenterDesign(this.state.draft); change(draft);
    if (!isUserCenterDesignValue(draft)) { this.state.notice = '请核对样式、模块标题和列表范围，原草稿已保留。'; return false; }
    this.state.draft = draft; this.state.success = false; this.state.notice = ''; return true;
  }
  toggleProperty(value: number, checked: unknown) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8 || typeof checked !== 'boolean') return;
    this.edit(draft => { const old=draft.member.property; draft.member.property=checked ? old.includes(value) ? old : [...old,value] : old.filter(item=>item!==value); });
  }
  move(key: ListKey, index: number, direction: -1 | 1) {
    if (!['poster','menu','merMenu'].includes(key)) return;
    this.edit(draft => { const list=draft[key].list, next=index+direction; if (!Number.isSafeInteger(index)||index<0||next<0||index>=list.length||next>=list.length) return; [list[index],list[next]]=[list[next]!,list[index]!]; });
  }
  remove(key: 'poster' | 'menu', index: number) { if (['poster','menu'].includes(key)) this.edit(draft=>{ if(Number.isSafeInteger(index)&&index>=0&&index<draft[key].list.length)draft[key].list.splice(index,1); }); }
  private preserveSources(draft: UserCenterDesignValue, current: UserCenterDesignValue, before: UserCenterDesignValue | null) {
    const result=cloneUserCenterDesign(draft); let unresolved=false;
    for(const key of ['poster','menu','merMenu'] as const) for(const item of result[key].list){
      if(item.sourceId===null||current[key].list.some(row=>row.sourceId===item.sourceId))continue;
      const original=before?.[key].list.find(row=>row.sourceId===item.sourceId);
      const matches=original?current[key].list.filter(row=>row.name===original.name&&row.pic===original.pic&&row.url===original.url&&('type'in row?row.type:undefined)===('type'in original?original.type:undefined)):[];
      if(matches.length===1&&matches[0]!.sourceId)item.sourceId=matches[0]!.sourceId;else unresolved=true;
    }
    return {value:result,unresolved};
  }
  private persisted(value: UserCenterDesignPending) { if (this.ports.storage.getItem(userCenterDesignPendingKey(value.actor)) !== JSON.stringify(value)) throw Error('本地原请求已变化，请核对后恢复'); }
  private clear(value: UserCenterDesignPending) { this.persisted(value); this.ports.storage.removeItem(userCenterDesignPendingKey(value.actor)); this.state.pending = null; this.state.retryReady = false; }
  private accept(value: UserCenterDesignReceipt, pending: UserCenterDesignPending) { assertReceipt(value, pending); this.ports.storage.removeItem(userCenterDesignDraftKey(pending.actor)); this.clear(pending); this.state.rejected = null; this.state.needsReread = false; this.state.notice = '个人中心设计已确认保存，正在读取当前配置。'; this.state.success = true; }
  async load(preserve = false) {
    const s = this.state; if (!this.actor().view || s.busy || s.confirming || s.readingReceipt || s.restoring) return;
    const job = this.begin('load'), draft = cloneUserCenterDesign(s.draft), before = s.snapshot?.value ?? null; s.loading = true; s.ready = false; s.error = '';
    try {
      const value = parseUserCenterDesignSnapshot(await this.ports.read(job.controller.signal)); if (!this.valid('load', job)) return; s.snapshot = value;
      if (s.pending) s.draft = cloneUserCenterDesign(s.pending.input.value);
      else if (preserve) {
        const mapped=value.value?this.preserveSources(draft,value.value,before):{value:draft,unresolved:true};
        s.draft=mapped.value; s.needsReread=mapped.unresolved;
        s.notice=mapped.unresolved?'当前列表已变化，无法安全对应部分原条目。草稿已保留，请核对后采用当前配置再编辑。':'已读取当前版本并保留六模块草稿，请核对列表和预览后再次确认保存。';
      }
      else if (s.rejected) { s.draft = cloneUserCenterDesign(s.rejected.input.value); s.needsReread = true; }
      else s.draft = value.value ? cloneUserCenterDesign(value.value) : cloneUserCenterDesign();
      s.ready = true;
    } catch (reason) { if (this.valid('load', job)) s.error = `读取失败，现有草稿已保留且不能保存：${userCenterDesignErrorMessage(reason)}`; }
    finally { if (this.finish('load', job)) s.loading = false; }
  }
  async reread() { if (!this.locked && this.actor().view) await this.load(!!this.state.snapshot || !!this.state.rejected); }
  async adoptCurrent() {
    if(this.locked||!this.actor().view)return;const stamp=this.stamp();this.state.confirming=true;
    try{await this.ports.confirm('确认采用服务端当前配置并替换现有草稿？上次未保存的列表将不再用于新提交。');if(!this.current(stamp))return;
      if(positive(this.actor().id))this.ports.storage.removeItem(userCenterDesignDraftKey(this.actor().id!));this.state.rejected=null;this.state.needsReread=false;
    }catch{return;}finally{if(this.current(stamp))this.state.confirming=false;}
    if(this.current(stamp))await this.load();
  }
  async activate() {
    this.invalidate(); const s = this.state, stamp = this.stamp(), actor = this.actor(); if (!actor.view || !positive(actor.id)) return; s.restoring = true;
    try {
      const raw = this.ports.storage.getItem(userCenterDesignPendingKey(actor.id)), draft = raw ? null : this.ports.storage.getItem(userCenterDesignDraftKey(actor.id));
      if (raw || draft) { const value = await parseUserCenterDesignPending((raw || draft)!, actor.id); if (!this.current(stamp)) return; if (raw) s.pending = value; else { s.rejected = value; s.needsReread = true; } s.draft = cloneUserCenterDesign(value.input.value); }
    } catch (reason) { if (this.current(stamp)) s.recoveryError = `原请求无法安全恢复：${userCenterDesignErrorMessage(reason)}`; }
    finally { if (this.current(stamp)) s.restoring = false; }
    if (this.current(stamp)) await this.load();
  }
  async save() {
    const s = this.state; if (this.editorDisabled || s.needsReread || !s.snapshot || !positive(this.actor().id)) return;
    const stamp = this.stamp(), version = ++this.confirmation; s.confirming = true; s.success = false; s.notice = ''; let frozen: UserCenterDesignPending | null = null;
    try {
      if (!s.snapshot.value) throw Error('当前配置不可保存，请先读取并核对');
      const original=s.snapshot.value.merMenu.list, next=s.draft.merMenu.list;
      if(original.length!==next.length||next.some(row=>!original.some(item=>item.sourceId===row.sourceId&&item.url===row.url&&item.type===row.type)))throw Error('商家管理只能修改名称、图片与顺序，请先读取当前配置');
      const operationId = this.ports.uuid(); if (operationId === s.rejected?.input.operationId) throw Error('新的保存请求必须使用新的请求标识，请再次确认');
      const input = normalizeUserCenterDesignWrite({ operationId, revision: s.snapshot.revision, value: s.draft }), fingerprint = await userCenterDesignFingerprint(input);
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage) return;
      const synchronization=s.snapshot.issues.some(issue=>issue.endsWith('_group_disagreement'))?' 当前共享数据存在差异，将按本页列表同步广告和菜单组；额外共享项停用并原样保留。':'';
      await this.ports.confirm(`确认保存个人中心六个模块、全部广告及服务菜单？${synchronization}商家入口按当前账号权限展示，实际账户、订单及统计由商城提供。`);
      if (!this.current(stamp) || version !== this.confirmation || !this.actor().manage || s.pending || s.recoveryError) return;
      frozen = freezeIntent({ version: 1, actor: this.actor().id!, input, fingerprint }); const key = userCenterDesignPendingKey(frozen.actor); if (this.ports.storage.getItem(key) !== null) throw Error('已有未完成请求，请重新打开并核对');
      this.ports.storage.setItem(key, JSON.stringify(frozen)); s.pending = frozen; this.persisted(frozen);
    } catch (reason) { if (this.current(stamp) && reason !== 'cancel' && reason !== 'close') s.notice = userCenterDesignErrorMessage(reason); frozen = null; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && frozen && s.pending?.input.operationId === frozen.input.operationId) await this.submit(frozen);
  }
  private async submit(value: UserCenterDesignPending) {
    const s = this.state; if (!this.actor().manage || !this.current(this.stamp()) || s.busy || s.readingReceipt || s.pending?.input.operationId !== value.input.operationId) return;
    try { this.persisted(value); } catch (reason) { s.recoveryError = userCenterDesignErrorMessage(reason); return; }
    const job = this.begin('write'); s.busy = true; s.retryReady = false; s.notice = '';
    try { const receipt = await this.ports.write(value.input, job.controller.signal); if (this.valid('write', job) && this.actor().manage) this.accept(receipt, value); }
    catch (reason) {
      if (!this.valid('write', job)) return;
      if (definitive(reason, value)) {
        try { this.ports.storage.setItem(userCenterDesignDraftKey(value.actor), JSON.stringify(value)); this.clear(value); s.rejected = value; s.draft = cloneUserCenterDesign(value.input.value); s.needsReread = true; s.notice = `本次未保存：${response(reason)?.status === 409 ? '配置版本已改变' : userCenterDesignErrorMessage(reason)}。草稿已保留，请读取当前版本并核对。`; }
        catch (failure) { s.recoveryError = userCenterDesignErrorMessage(failure); }
      } else s.notice = `提交结果尚未确认：${userCenterDesignErrorMessage(reason)}。请读取原请求回执，不能发起新的提交。`;
    } finally { if (this.finish('write', job)) s.busy = false; }
    if (this.current(job.stamp) && !s.pending && !s.rejected && !s.recoveryError) await this.load();
  }
  async readReceipt() {
    const s = this.state; if (!s.pending || s.busy || s.confirming || s.readingReceipt || s.restoring || !this.actor().view) return;
    const value = s.pending; try { this.persisted(value); } catch (reason) { s.recoveryError = userCenterDesignErrorMessage(reason); return; }
    const job = this.begin('receipt'); s.readingReceipt = true; s.retryReady = false;
    try { const receipt = await this.ports.receipt(value.input.operationId, job.controller.signal); if (this.valid('receipt', job)) this.accept(receipt, value); }
    catch (reason) { if (this.valid('receipt', job)) { if (response(reason)?.status === 404) { s.retryReady = true; s.notice = '服务端明确未找到原请求回执，可主动原样重试；原版本与全部六个模块及全部列表内容保持不变。'; } else s.notice = `原请求仍未确认：${userCenterDesignErrorMessage(reason)}`; } }
    finally { if (this.finish('receipt', job)) s.readingReceipt = false; }
    if (this.current(job.stamp) && !s.pending && !s.recoveryError) await this.load();
  }
  async retryOriginal() {
    const s = this.state; if (!s.pending || !s.retryReady || !this.actor().manage || s.busy || s.readingReceipt || s.confirming || s.restoring) return;
    const value = s.pending, stamp = this.stamp(), version = ++this.confirmation; s.confirming = true;
    try { await this.ports.confirm('确认原样重试相同个人中心设计请求？原请求标识、版本和全部六个模块及全部列表内容均保持不变。'); } catch { return; }
    finally { if (this.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.current(stamp) && version === this.confirmation && this.actor().manage && s.pending === value && s.retryReady) await this.submit(value);
  }
  invalidate() {
    this.epoch++; for (const job of this.jobs.values()) job.controller.abort(); this.jobs.clear(); this.confirmation++;
    Object.assign(this.state, { snapshot: null, draft: cloneUserCenterDesign(), pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false, syncedReadonly: [] });
  }
  dispose() { this.invalidate(); this.alive = false; }
}
