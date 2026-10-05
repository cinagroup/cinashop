import { reactive } from 'vue';
import { FabRequestScope } from './fabSettingsController';
import { apiThemeSettings, apiSaveThemeSettings, apiThemeReceipt, normalizeThemeWrite, themeFingerprint, themePendingKey, themeDraftKey, parseThemePending, assertThemeReceipt, isThemeStale, isThemeRejected, themeReceiptNotFound, themeErrorMessage, type ThemeSnapshot, type ThemePending, type ThemeWrite, type ThemeReceipt } from '@/api/themeSettings';
import { isThemeStatus, type ThemeStatus } from '../../../../common/theme';
export interface ThemeActor { id: number | null; identity: string; stored: string | null; view: boolean; manage: boolean }
export interface ThemePorts { read: typeof apiThemeSettings; write: typeof apiSaveThemeSettings; receipt: typeof apiThemeReceipt; confirm: (message: string) => Promise<void>; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; uuid: () => string }
/** Reactive UI state and actual request generations share one actor-bound intent journal. */
export class ThemeSettingsController {
  readonly state = reactive({ snapshot: null as ThemeSnapshot | null, status: 3 as ThemeStatus, pending: null as ThemePending | null, rejected: null as ThemePending | null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false });
  private scope: FabRequestScope;
  private confirmation = 0;
  constructor(private actor: () => ThemeActor, private ports: ThemePorts) { this.scope = new FabRequestScope(() => actor().identity, () => actor().stored, () => actor().view); }
  get locked() { const s = this.state; return s.loading || s.busy || s.confirming || s.restoring || s.readingReceipt || !!s.pending || !!s.recoveryError; }
  get editorDisabled() { return !this.actor().manage || this.locked || !this.state.ready || !this.state.snapshot?.editable; }
  select(value: unknown) { if (!this.editorDisabled && isThemeStatus(value)) this.state.status = value; }
  private clear(value: ThemePending) { const key = themePendingKey(value.actor); if (this.ports.storage.getItem(key) !== JSON.stringify(value)) throw Error('本地原请求已变化，请核对后恢复'); this.ports.storage.removeItem(key); this.state.pending = null; this.state.retryReady = false; }
  private accept(value: ThemeReceipt, pending: ThemePending) { assertThemeReceipt(value, pending); this.clear(pending); this.ports.storage.removeItem(themeDraftKey(pending.actor)); this.state.rejected = null; this.state.needsReread = false; this.state.notice = '主题已确认保存，正在读取当前配置。'; this.state.success = true; }
  async load(preserve = false) {
    if (!this.actor().view || this.state.busy || this.state.confirming || this.state.readingReceipt || this.state.restoring) return;
    const job = this.scope.begin('load'), s = this.state, selected = s.status; s.loading = true; s.ready = false; s.error = '';
    try { const value = await this.ports.read(job.controller.signal); if (!this.scope.valid('load', job)) return; s.snapshot = value;
      if (s.pending) s.status = s.pending.input.status;
      else if (preserve) { s.status = selected; s.needsReread = false; s.notice = '已读取当前版本并保留选择，请核对后再次确认保存。'; }
      else if (s.rejected) { s.status = s.rejected.input.status; s.needsReread = true; }
      else s.status = value.status ?? 3;
      s.ready = true;
    } catch (reason) { if (this.scope.valid('load', job)) s.error = `读取失败，现有选择已保留且不能保存：${themeErrorMessage(reason)}`; }
    finally { if (this.scope.finish('load', job)) s.loading = false; }
  }
  async reread() { if (!this.locked && this.actor().view) await this.load(!!this.state.snapshot || !!this.state.rejected); }
  async activate() {
    this.invalidate(); const s = this.state, stamp = this.scope.stamp(), actor = this.actor(); if (!actor.view || !actor.id) return; s.restoring = true;
    try { const raw = this.ports.storage.getItem(themePendingKey(actor.id)), draft = raw ? null : this.ports.storage.getItem(themeDraftKey(actor.id)); if (raw || draft) { const value = await parseThemePending((raw || draft)!, actor.id); if (!this.scope.current(stamp)) return; if (raw) s.pending = value; else { s.rejected = value; s.needsReread = true; } s.status = value.input.status; } }
    catch (reason) { if (this.scope.current(stamp)) s.recoveryError = `原请求无法安全恢复：${themeErrorMessage(reason)}`; }
    finally { if (this.scope.current(stamp)) s.restoring = false; }
    if (this.scope.current(stamp)) await this.load();
  }
  async save() {
    const s = this.state; if (this.editorDisabled || s.needsReread || !s.snapshot || !this.actor().id) return;
    const stamp = this.scope.stamp(), version = ++this.confirmation; s.confirming = true; s.success = false; s.notice = ''; let frozen: ThemePending | null = null;
    try { const input: ThemeWrite = normalizeThemeWrite({ request_id: this.ports.uuid(), revision: s.snapshot.revision, status: s.status }), fingerprint = await themeFingerprint(input);
      if (!this.scope.current(stamp) || version !== this.confirmation || !this.actor().manage) return;
      await this.ports.confirm('确认保存所选商城主题？价格、按钮、选中项与渐变将按这套预设显示。DIY 自定义色与业务状态颜色保留。');
      if (!this.scope.current(stamp) || version !== this.confirmation || !this.actor().manage || s.pending || s.recoveryError) return;
      frozen = { version: 1, actor: this.actor().id!, input, fingerprint }; const key = themePendingKey(frozen.actor); if (this.ports.storage.getItem(key) !== null) throw Error('已有未完成请求，请重新打开并核对'); this.ports.storage.setItem(key, JSON.stringify(frozen)); s.pending = frozen;
    } catch (reason) { if (this.scope.current(stamp) && reason !== 'cancel' && reason !== 'close') s.notice = themeErrorMessage(reason); }
    finally { if (this.scope.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.scope.current(stamp) && frozen && s.pending?.input.request_id === frozen.input.request_id) await this.submit(frozen);
  }
  private async submit(value: ThemePending) {
    const s = this.state; if (!this.actor().manage || !this.scope.current(this.scope.stamp()) || s.busy || s.readingReceipt || s.pending?.input.request_id !== value.input.request_id) return;
    const job = this.scope.begin('write'); s.busy = true; s.retryReady = false; s.notice = '';
    try { const receipt = await this.ports.write(value.input, job.controller.signal); if (this.scope.valid('write', job) && this.actor().manage) this.accept(receipt, value); }
    catch (reason) { if (!this.scope.valid('write', job)) return;
      if (isThemeStale(reason, value) || isThemeRejected(reason, value)) { try { this.ports.storage.setItem(themeDraftKey(value.actor), JSON.stringify(value)); this.clear(value); s.rejected = value; s.status = value.input.status; s.needsReread = true; s.notice = `本次未保存：${isThemeStale(reason, value) ? '配置版本已改变' : themeErrorMessage(reason)}。选择已保留，请读取当前版本并核对。`; } catch (failure) { s.recoveryError = themeErrorMessage(failure); } }
      else s.notice = `提交结果尚未确认：${themeErrorMessage(reason)}。请读取原请求回执，不能发起新的提交。`;
    } finally { if (this.scope.finish('write', job)) s.busy = false; }
    if (this.scope.current(job.stamp) && !s.pending && !s.rejected && !s.recoveryError) await this.load();
  }
  async readReceipt() { const s = this.state; if (!s.pending || s.busy || s.confirming || s.readingReceipt || s.restoring || !this.actor().view) return;
    const value = s.pending, job = this.scope.begin('receipt'); s.readingReceipt = true; s.retryReady = false;
    try { const receipt = await this.ports.receipt(value.input.request_id, job.controller.signal); if (this.scope.valid('receipt', job)) this.accept(receipt, value); }
    catch (reason) { if (this.scope.valid('receipt', job)) { if (themeReceiptNotFound(reason)) { s.retryReady = true; s.notice = '服务端明确未找到原请求回执，可主动原样重试，原版本与选择保持不变。'; } else s.notice = `原请求仍未确认：${themeErrorMessage(reason)}`; } }
    finally { if (this.scope.finish('receipt', job)) s.readingReceipt = false; }
    if (this.scope.current(job.stamp) && !s.pending && !s.recoveryError) await this.load();
  }
  async retryOriginal() { const s = this.state; if (!s.pending || !s.retryReady || !this.actor().manage || s.busy || s.readingReceipt || s.confirming || s.restoring) return; const value = s.pending, stamp = this.scope.stamp(), version = ++this.confirmation; s.confirming = true;
    try { await this.ports.confirm('确认原样重试相同主题请求？原标识、版本和主题选择均保持不变。'); } catch { return; } finally { if (this.scope.current(stamp) && version === this.confirmation) s.confirming = false; }
    if (this.scope.current(stamp) && version === this.confirmation && this.actor().manage && s.pending === value && s.retryReady) await this.submit(value);
  }
  invalidate() { this.scope.invalidate(); this.confirmation++; Object.assign(this.state, { snapshot: null, status: 3, pending: null, rejected: null, ready: false, needsReread: false, retryReady: false, loading: false, busy: false, confirming: false, restoring: false, readingReceipt: false, error: '', notice: '', recoveryError: '', success: false }); }
  dispose() { this.invalidate(); this.scope.dispose(); }
}
