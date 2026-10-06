import { reactive } from 'vue';
import { FabRequestScope } from './fabSettingsController';
import { apiCityDeliverySettings, apiPrepareCityDelivery, apiCityDeliveryIntent, apiConfirmCityDelivery, apiCityDeliveryReceipt,
  CITY_DELIVERY_FLAG_KEYS, CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_LABELS, CITY_DELIVERY_FLAG_LABELS,
  normalizeCityDeliveryPrepare, cityDeliveryJournal, cityDeliveryPendingKey, parseCityDeliveryJournal, assertCityDeliveryResponse,
  cityDeliveryConfirmInput, isCityDeliveryRollback, cityDeliveryNotFound, cityDeliveryErrorMessage,
  type CityDeliveryJournal, type CityDeliveryFlagKey, type CityDeliveryCredentialKey, type CityDeliveryCredentialAction,
  type CityDeliverySettingsSnapshot, type CityDeliveryPreparedIntent, type CityDeliverySettingsReceipt } from '@/api/cityDeliverySettings';
export interface CityDeliveryActor { id: number | null; identity: string; stored: string | null; view: boolean; manage: boolean }
export interface CityDeliveryPorts { read: typeof apiCityDeliverySettings; prepare: typeof apiPrepareCityDelivery; intent: typeof apiCityDeliveryIntent; confirm: typeof apiConfirmCityDelivery; receipt: typeof apiCityDeliveryReceipt; ask: (message: string) => Promise<void>; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; uuid: () => string }
function emptyDraft() { return { flags: Object.fromEntries(CITY_DELIVERY_FLAG_KEYS.map(key => [key, null])) as Record<CityDeliveryFlagKey, 0 | 1 | null>, credentials: Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, { action: 'keep' as CityDeliveryCredentialAction, value: '' }])) as Record<CityDeliveryCredentialKey, { action: CityDeliveryCredentialAction; value: string }> }; }
/** Preparation and confirmation are different durable phases. Only metadata may enter browser storage. */
export class CityDeliverySettingsController {
  readonly state = reactive({ snapshot: null as CityDeliverySettingsSnapshot | null, draft: emptyDraft(), journal: null as CityDeliveryJournal | null, intent: null as CityDeliveryPreparedIntent | null,
    ready: false, loading: false, busy: false, restoring: false, reading: false, asking: false, needsReread: false, error: '', notice: '', recoveryError: '', success: false });
  private scope: FabRequestScope;
  private confirmation = 0;
  constructor(private actor: () => CityDeliveryActor, private ports: CityDeliveryPorts) { this.scope = new FabRequestScope(() => actor().identity, () => actor().stored, () => actor().view); }
  get locked() { const s = this.state; return s.loading || s.busy || s.restoring || s.reading || s.asking || !!s.journal || !!s.recoveryError; }
  get editorDisabled() { return !this.actor().manage || this.locked || !this.state.ready || !this.state.snapshot?.editable; }
  get canConfirm() { const s = this.state; return this.actor().manage && !!s.journal?.payload_hash && !!s.intent && s.intent.state !== 'applied' && !s.loading && !s.busy && !s.reading && !s.asking && !s.restoring && !s.recoveryError; }
  get canAbandon() { const s = this.state; return this.actor().manage && !!s.journal && s.journal.phase !== 'confirm-unknown' && s.intent?.state !== 'applied' && !s.asking && !s.restoring && !s.recoveryError; }
  setFlag(key: CityDeliveryFlagKey, value: unknown) { if (!this.editorDisabled && (value === 0 || value === 1)) this.state.draft.flags[key] = value; }
  setAction(key: CityDeliveryCredentialKey, action: CityDeliveryCredentialAction) { if (this.editorDisabled || !['keep', 'replace', 'clear'].includes(action)) return; this.state.draft.credentials[key].action = action; if (action !== 'replace') this.state.draft.credentials[key].value = ''; }
  setValue(key: CityDeliveryCredentialKey, value: string) { if (!this.editorDisabled && this.state.draft.credentials[key].action === 'replace') this.state.draft.credentials[key].value = value; }
  private forgetInputs() { for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) this.state.draft.credentials[key].value = ''; }
  private restoreDraft(journal: CityDeliveryJournal) { this.state.draft.flags = { ...journal.flags }; for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) this.state.draft.credentials[key] = { action: journal.actions[key], value: '' }; }
  private persist(value: CityDeliveryJournal, replace = false) {
    const key = cityDeliveryPendingKey(value.actor), raw = this.ports.storage.getItem(key);
    if (replace ? !this.state.journal || raw !== JSON.stringify(this.state.journal) : raw !== null) throw Error('Local journal changed');
    this.ports.storage.setItem(key, JSON.stringify(value)); this.state.journal = value;
  }
  private clear(value: CityDeliveryJournal) { const key = cityDeliveryPendingKey(value.actor); if (this.ports.storage.getItem(key) !== JSON.stringify(value)) throw Error('Local journal changed'); this.ports.storage.removeItem(key); this.state.journal = null; this.state.intent = null; }
  private accept(receipt: CityDeliverySettingsReceipt, journal: CityDeliveryJournal) { assertCityDeliveryResponse(receipt, journal); this.clear(journal); this.forgetInputs(); this.state.needsReread = false; this.state.notice = '原配置已确认保存，正在读取当前有效配置。'; this.state.success = true; }
  private remember(intent: CityDeliveryPreparedIntent) { const journal = this.state.journal; if (!journal) throw Error('No original journal'); assertCityDeliveryResponse(intent, journal);
    if (intent.state === 'applied' && intent.receipt) { this.accept(intent.receipt, journal); return; }
    this.persist({ ...journal, phase: journal.phase === 'confirm-unknown' ? 'confirm-unknown' : 'prepared', payload_hash: intent.payload_hash }, true); this.state.intent = intent;
    this.state.notice = intent.state === 'expired' ? '服务器准备已过期。若确认曾经发出，仍须核对原回执或原确认结果，不能另发请求。' : '服务器已保存待确认准备；有效配送配置尚未由本页确认修改。请核对四开关与六项动作后主动确认。';
  }
  async load(preserve = false) { const s = this.state; if (!this.actor().view || s.busy || s.asking || s.reading || s.restoring) return;
    const job = this.scope.begin('load'); s.loading = true; s.ready = false; s.error = '';
    try { const snapshot = await this.ports.read(job.controller.signal); if (!this.scope.valid('load', job)) return; s.snapshot = snapshot;
      if (s.journal) this.restoreDraft(s.journal); else if (!preserve) { s.draft = emptyDraft(); s.draft.flags = { ...snapshot.flags }; }
      if (preserve) s.needsReread = false; s.ready = true;
    } catch (reason) { if (this.scope.valid('load', job)) s.error = `读取失败，现有草稿已保留且不能准备保存：${cityDeliveryErrorMessage(reason)}`; }
    finally { if (this.scope.finish('load', job)) s.loading = false; }
  }
  async reread() { if (!this.locked && this.actor().view) { const afterRejection = this.state.needsReread; await this.load(true); if (this.state.ready) this.state.notice = afterRejection ? '已读取当前版本并保留开关与动作，请重新输入需替换的凭据后核对。' : '已读取当前版本并保留本页草稿，请核对后准备保存。'; } }
  async activate() { this.invalidate(); const s = this.state, actor = this.actor(), stamp = this.scope.stamp(); if (!actor.view || !actor.id) return; s.restoring = true;
    try { const raw = this.ports.storage.getItem(cityDeliveryPendingKey(actor.id)); if (raw) { const journal = parseCityDeliveryJournal(raw, actor.id); if (!this.scope.current(stamp)) return; s.journal = journal; this.restoreDraft(journal); } }
    catch { if (this.scope.current(stamp)) s.recoveryError = '本账号的原准备记录无法安全恢复。请核对原请求，不能绕过记录发起新的保存。'; }
    finally { if (this.scope.current(stamp)) s.restoring = false; }
    if (this.scope.current(stamp)) { await this.load(); if (s.journal && !s.recoveryError && this.scope.current(stamp)) await this.readIntent(); }
  }
  async prepare() { const s = this.state, actor = this.actor(); if (this.editorDisabled || s.needsReread || !s.snapshot?.readiness.cipher_ready || !actor.id) return;
    const stamp = this.scope.stamp(); let input;
    try { input = normalizeCityDeliveryPrepare({ request_id: this.ports.uuid(), client_nonce: this.ports.uuid(), revision: s.snapshot.revision, flags: { ...s.draft.flags }, credentials: Object.fromEntries(CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, s.draft.credentials[key].action === 'replace' ? { action: 'replace', value: s.draft.credentials[key].value } : { action: s.draft.credentials[key].action }])) });
      this.persist(cityDeliveryJournal(input, actor.id));
    } catch (reason) { if (this.scope.current(stamp)) s.notice = cityDeliveryErrorMessage(reason); return; }
    const job = this.scope.begin('prepare'); s.busy = true; s.success = false; s.notice = ''; this.forgetInputs();
    try { const intent = await this.ports.prepare(input, job.controller.signal); if (this.scope.valid('prepare', job) && this.actor().manage) this.remember(intent); }
    catch (reason) { if (this.scope.valid('prepare', job)) s.notice = `准备结果尚未确认：${cityDeliveryErrorMessage(reason)}。可读取原准备；确认尚未发送时可明确放弃本地准备。`; }
    finally { for (const key of CITY_DELIVERY_CREDENTIAL_KEYS) { const field = input.credentials[key]; if (field.action === 'replace') field.value = ''; } if (this.scope.finish('prepare', job)) s.busy = false; }
  }
  async readIntent() { const s = this.state; if (!s.journal || !this.actor().view || s.busy || s.reading || s.asking || s.restoring) return;
    const journal = s.journal, job = this.scope.begin('intent'); s.reading = true;
    try { const intent = await this.ports.intent(journal.request_id, job.controller.signal); if (this.scope.valid('intent', job)) this.remember(intent); }
    catch (reason) { if (this.scope.valid('intent', job)) s.notice = cityDeliveryNotFound(reason) ? journal.phase === 'confirm-unknown' ? '原准备暂未找到，不能据此认定未保存。请继续核对原回执，不能发起新的保存。' : '原准备暂未找到。确认尚未发送，可明确放弃本地准备后重新准备；不会自动重发。' : `原准备仍未确认：${cityDeliveryErrorMessage(reason)}`; }
    finally { if (this.scope.finish('intent', job)) s.reading = false; }
    if (this.scope.current(job.stamp) && !s.journal && !s.recoveryError) await this.load();
  }
  async readReceipt() { const s = this.state; if (!s.journal || !this.actor().view || s.busy || s.reading || s.asking || s.restoring) return;
    const journal = s.journal, job = this.scope.begin('receipt'); s.reading = true;
    try { const receipt = await this.ports.receipt(journal.request_id, job.controller.signal); if (this.scope.valid('receipt', job)) this.accept(receipt, journal); }
    catch (reason) { if (this.scope.valid('receipt', job)) s.notice = cityDeliveryNotFound(reason) ? '尚未找到原回执；这不能证明未保存，也不会解除已发送确认的锁定。可读取原准备并主动原样确认。' : `原回执仍未确认：${cityDeliveryErrorMessage(reason)}`; }
    finally { if (this.scope.finish('receipt', job)) s.reading = false; }
    if (this.scope.current(job.stamp) && !s.journal && !s.recoveryError) await this.load();
  }
  summary() { const journal = this.state.journal; if (!journal) return ''; return [...CITY_DELIVERY_FLAG_KEYS.map(key => `${CITY_DELIVERY_FLAG_LABELS[key]}：${journal.flags[key] ? '开启' : '关闭'}`), ...CITY_DELIVERY_CREDENTIAL_KEYS.map(key => `${CITY_DELIVERY_LABELS[key]}：${({ keep: '保留原配置', replace: '替换为已准备的新值', clear: '清除配置' })[journal.actions[key]]}`)].join('；'); }
  async confirmPrepared() { const s = this.state; if (!this.canConfirm || !s.journal) return; const journal = s.journal, stamp = this.scope.stamp(), version = ++this.confirmation; s.asking = true;
    try { await this.ports.ask(`确认应用这一次已准备的同城配送配置？${this.summary()}。关闭开关不会清除保留项；清除项会被明确删除。本操作不会发单或测试第三方连接。`); }
    catch { return; }
    finally { if (this.scope.current(stamp) && version === this.confirmation) s.asking = false; }
    if (!this.scope.current(stamp) || version !== this.confirmation || !this.actor().manage || s.journal?.request_id !== journal.request_id) return;
    let original: CityDeliveryJournal;
    try { original = { ...journal, phase: 'confirm-unknown' }; this.persist(original, true); }
    catch { s.recoveryError = '本地原准备已变化或无法保存确认阶段，未发送新的确认，请核对原请求。'; return; }
    const job = this.scope.begin('confirm'); s.busy = true; s.success = false;
    try { const receipt = await this.ports.confirm(cityDeliveryConfirmInput(original), job.controller.signal); if (this.scope.valid('confirm', job) && this.actor().manage) this.accept(receipt, original); }
    catch (reason) { if (!this.scope.valid('confirm', job)) return; if (isCityDeliveryRollback(reason, original)) {
        try { this.clear(original); s.needsReread = true; s.notice = '服务端已证明本次未保存。开关与动作已保留，请先读取当前版本；替换项需重新输入，再准备新的请求。'; }
        catch { s.recoveryError = '原记录已变化，不能安全解除锁定，请核对原请求。'; }
      } else s.notice = `确认结果尚未确定：${cityDeliveryErrorMessage(reason)}。请读取原回执或原准备，再主动原样确认，不能发起新保存。`;
    } finally { if (this.scope.finish('confirm', job)) s.busy = false; }
    if (this.scope.current(job.stamp) && !s.journal && !s.needsReread && !s.recoveryError) await this.load();
  }
  async abandonUnconfirmed() { const s = this.state; if (!this.canAbandon || !s.journal) return; const requestId = s.journal.request_id, stamp = this.scope.stamp(), version = ++this.confirmation; s.asking = true;
    try { await this.ports.ask('仅放弃本页尚未发送确认的准备？不会修改有效配置，也不会删除服务器准备；服务器可将其保留至过期。替换值已从本页清除，重新准备时需要重新输入。'); }
    catch { return; }
    finally { if (this.scope.current(stamp) && version === this.confirmation) s.asking = false; }
    if (!this.scope.current(stamp) || version !== this.confirmation || !this.actor().manage || !s.journal || s.journal.request_id !== requestId || s.journal.phase === 'confirm-unknown' || s.intent?.state === 'applied') return;
    try { this.clear(s.journal); this.scope.invalidate(); this.confirmation++; s.busy = false; s.reading = false; s.loading = false; s.needsReread = false; this.forgetInputs(); await this.load(true); s.notice = '尚未确认的本地准备已明确放弃。服务器准备可保留至过期，未发送应用确认。'; }
    catch { s.recoveryError = '本地原记录已变化，不能安全放弃，请核对原准备。'; }
  }
  invalidate() { this.scope.invalidate(); this.confirmation++; this.forgetInputs(); Object.assign(this.state, { snapshot: null, draft: emptyDraft(), journal: null, intent: null, ready: false, loading: false, busy: false, restoring: false, reading: false, asking: false, needsReread: false, error: '', notice: '', recoveryError: '', success: false }); }
  dispose() { this.invalidate(); this.scope.dispose(); }
}
