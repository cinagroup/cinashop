import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { getSupplierProductRules, getSupplierProductRule, saveSupplierProductRule, deleteSupplierProductRule, supplierProductRuleKnownRejection } from '@/api/productRules';
import { supplierProductRuleDraft, supplierProductRuleMatches } from '@/utils/productRules';
import type { SupplierProductRuleCatalog, SupplierProductRulePayload, SupplierProductRuleReceipt, SupplierProductRuleRow, SupplierRuleDimension } from '@/types/productRules';

export interface SupplierProductRuleVerifiedEvent { id: number; kind: 'created' | 'updated' | 'deleted' }
interface EditorOptions {
  blocked?: () => boolean;
  onVerified?: (event: SupplierProductRuleVerifiedEvent) => void | Promise<void>;
  onInvalidate?: () => void;
}
type Attempt = Readonly<{ operation: 'save' | 'delete'; id: number; payload?: SupplierProductRulePayload; previousIds: readonly number[] }>;

/** Mounted template author and factual GET recovery. Product drafts belong to callers. */
export function useSupplierProductRuleEditor(options: EditorOptions = {}) {
  const auth = useAuthStore(), invalidated = ref(false), blocked = computed(() => Boolean(options.blocked?.()));
  const canRead = computed(() => !invalidated.value && auth.can('supplier.product.view'));
  const canManage = computed(() => canRead.value && auth.can('supplier.product.manage'));
  const catalog = shallowRef<SupplierProductRuleCatalog | null>(null), loading = ref(false), busy = ref(false), editing = ref(false), error = ref(''), notice = ref('');
  const filter = reactive({ rule_name: '', page: 1, limit: 20 }), editId = ref(0), editRevision = ref(''), createRevision = ref(''), createIds = ref<number[]>([]);
  const blankDimension = (): SupplierRuleDimension => ({ value: '', detail: [] }), form = reactive({ rule_name: '', spec: [blankDimension()] });
  const attempt = shallowRef<Attempt | null>(null), receipt = shallowRef<SupplierProductRuleReceipt | null>(null), recoveryRead = ref(false);
  let generation = 0, interactionGeneration = 0, disposed = false, confirmationPending = false;
  let readController: AbortController | undefined, interactionController: AbortController | undefined, writeController: AbortController | undefined;
  let busyOwner: object | undefined;
  function stopRequests() { readController?.abort(); interactionController?.abort(); writeController?.abort(); }
  function invalidate() {
    if (invalidated.value) return;
    invalidated.value = true; generation++; interactionGeneration++; stopRequests(); session.dispose();
    if (confirmationPending) ElMessageBox.close?.();
    confirmationPending = false; busyOwner = undefined; catalog.value = null; editing.value = false;
    attempt.value = null; receipt.value = null; recoveryRead.value = false; loading.value = false; busy.value = false;
    form.rule_name = ''; form.spec = [blankDimension()]; editId.value = 0; editRevision.value = ''; createRevision.value = ''; createIds.value = [];
    error.value = '登录会话或权限已改变，请重新打开规格模板'; notice.value = ''; options.onInvalidate?.();
  }
  const session = createSupplierSessionScope(invalidate, true);
  session.signal.addEventListener('abort', stopRequests, { once: true });
  function current() { return !disposed && !invalidated.value && session.isCurrent() && canRead.value; }
  function invalidateContext() { invalidate(); }
  function dispose() { disposed = true; invalidate(); session.dispose(); }
  onScopeDispose(dispose);
  watch([canRead, canManage], () => { if (!canRead.value || !canManage.value && (editing.value || busy.value || attempt.value)) invalidate(); }, { flush: 'sync' });
  watch(() => [filter.rule_name, filter.page, filter.limit], () => { interactionGeneration++; generation++; readController?.abort(); interactionController?.abort(); }, { flush: 'sync' });
  const submitDisabled = computed(() => busy.value || loading.value || blocked.value || !!attempt.value || !canManage.value || !catalog.value || !form.rule_name.trim());
  function message(value: unknown) { return value instanceof Error ? value.message : '请求失败，请重新读取后确认'; }
  function beginRead(interaction = false) {
    const controller = new AbortController();
    if (interaction) { interactionController?.abort(); interactionController = controller; }
    else { readController?.abort(); readController = controller; }
    if (session.signal.aborted) controller.abort(session.signal.reason);
    return controller;
  }
  function beginWrite() {
    writeController?.abort(); writeController = new AbortController();
    if (session.signal.aborted) writeController.abort(session.signal.reason);
    return writeController;
  }
  function beginBusy() { const owner = {}; busyOwner = owner; busy.value = true; return owner; }
  function endBusy(owner: object) { if (busyOwner === owner) { busyOwner = undefined; busy.value = false; } }
  function interactionCurrent(version: number, pending?: Attempt) {
    return current() && version === interactionGeneration && (!pending || attempt.value === pending);
  }
  async function load() {
    if (!current()) return null;
    const version = ++generation, request = beginRead(); loading.value = true; error.value = '';
    try { const result = await getSupplierProductRules({ ...filter }, request.signal); if (!current() || request.signal.aborted || version !== generation) return null; catalog.value = result; return result; }
    catch (value) { if (current() && !request.signal.aborted && version === generation) error.value = message(value); return null; }
    finally { if (current() && version === generation) loading.value = false; }
  }
  function search() { if (busy.value || attempt.value || blocked.value) return; filter.page = 1; void load(); }
  async function openCreate() {
    if (!current() || !canManage.value || blocked.value || busy.value || attempt.value || !catalog.value) return;
    const version = ++interactionGeneration, request = beginRead(true), owner = beginBusy(); error.value = ''; notice.value = '';
    try { const result = await getSupplierProductRules({}, request.signal); if (!interactionCurrent(version) || request.signal.aborted || !canManage.value || blocked.value) return;
      createRevision.value = result.revision; createIds.value = result.list.map(row => row.id); editId.value = 0; editRevision.value = ''; form.rule_name = ''; form.spec = [blankDimension()]; editing.value = true; }
    catch (value) { if (interactionCurrent(version) && !request.signal.aborted) error.value = message(value); }
    finally { endBusy(owner); }
  }
  async function openEdit(id: number) {
    if (!current() || !canManage.value || blocked.value || busy.value || attempt.value) return;
    const version = ++interactionGeneration, request = beginRead(true), owner = beginBusy(); error.value = ''; notice.value = '';
    try { const result = await getSupplierProductRule(id, request.signal); if (!interactionCurrent(version) || request.signal.aborted || !canManage.value || blocked.value) return;
      editId.value = result.id; editRevision.value = result.revision; form.rule_name = result.rule_name;
      form.spec = result.spec.length ? result.spec.map(row => ({ value: row.value, detail: [...row.detail] })) : [blankDimension()]; editing.value = true; }
    catch (value) { if (interactionCurrent(version) && !request.signal.aborted) error.value = message(value); }
    finally { endBusy(owner); }
  }
  function addDimension() { if (current() && canManage.value && !blocked.value && !busy.value && !attempt.value && form.spec.length < 3) form.spec.push(blankDimension()); }
  function removeDimension(index: number) { if (current() && canManage.value && !blocked.value && !busy.value && !attempt.value && form.spec.length > 1) form.spec.splice(index, 1); }
  function immutableAttempt(value: Attempt): Attempt { if (value.payload) { value.payload.spec.forEach(row => { Object.freeze(row.detail); Object.freeze(row); }); Object.freeze(value.payload.spec); Object.freeze(value.payload); } Object.freeze(value.previousIds); return Object.freeze(value); }
  function matchingRows(result: SupplierProductRuleCatalog, pending: Attempt) {
    const id = receipt.value?.id ?? pending.id;
    return id ? result.list.filter(row => row.id === id)
      : result.list.filter(row => !pending.previousIds.includes(row.id) && supplierProductRuleMatches(row, pending.payload!));
  }
  function verify(result: SupplierProductRuleCatalog, pending: Attempt) {
    if (pending.operation === 'delete') return !result.list.some(row => row.id === pending.id);
    const candidates = matchingRows(result, pending);
    return candidates.length === 1 && supplierProductRuleMatches(candidates[0], pending.payload!) && (!receipt.value || candidates[0].revision === receipt.value.revision);
  }
  async function notifyVerified(event: SupplierProductRuleVerifiedEvent) {
    try { await options.onVerified?.(event); }
    catch (value) { if (current()) ElMessage.warning(`模板结果已核对，但目录刷新失败：${message(value)}`); }
  }
  async function reread(pending: Attempt, version = interactionGeneration) {
    if (!interactionCurrent(version, pending)) return false;
    const request = beginRead(true), result = await getSupplierProductRules({}, request.signal);
    if (!interactionCurrent(version, pending) || request.signal.aborted) return false;
    recoveryRead.value = true;
    if (!verify(result, pending)) throw Error('当前模板事实无法确认本次操作结果，请核对后结束本次操作，不要重复提交');
    const id = pending.operation === 'delete' ? pending.id : matchingRows(result, pending)[0].id;
    attempt.value = null; receipt.value = null; editing.value = false; notice.value = '已重新读取并核对规格模板结果'; ElMessage.success(notice.value);
    await notifyVerified({ id, kind: pending.operation === 'delete' ? 'deleted' : pending.id ? 'updated' : 'created' });
    if (interactionCurrent(version)) await load(); return true;
  }
  async function recover() {
    const pending = attempt.value; if (!pending || !current() || blocked.value || busy.value) return;
    const version = interactionGeneration, owner = beginBusy(); error.value = '';
    try { await reread(pending, version); }
    catch (value) { if (interactionCurrent(version, pending)) error.value = message(value); }
    finally { endBusy(owner); }
  }
  async function submit() {
    if (submitDisabled.value || !current()) return; let payload: SupplierProductRulePayload;
    try { payload = supplierProductRuleDraft(form.rule_name, form.spec, editId.value ? editRevision.value : createRevision.value); } catch (value) { error.value = message(value); return; }
    const pending = immutableAttempt({ operation: 'save', id: editId.value, payload, previousIds: [...createIds.value] });
    attempt.value = pending; receipt.value = null; recoveryRead.value = false; const version = interactionGeneration, request = beginWrite(), owner = beginBusy(); error.value = ''; notice.value = ''; let acknowledged = false;
    try { const result = await saveSupplierProductRule(pending.id, payload, request.signal); if (!interactionCurrent(version, pending) || request.signal.aborted) return; receipt.value = result; acknowledged = true; await reread(pending, version); }
    catch (value) { if (!interactionCurrent(version, pending)) return; if (!acknowledged && supplierProductRuleKnownRejection(value)) { attempt.value = null; receipt.value = null; } error.value = message(value); }
    finally { endBusy(owner); }
  }
  async function removeRule(row: SupplierProductRuleRow) {
    if (!current() || !canManage.value || blocked.value || busy.value || attempt.value) return;
    const version = interactionGeneration, rowRevision = row.revision;
    try { confirmationPending = true; await ElMessageBox.confirm(`删除“${row.rule_name}”？已复制到商品的规格、价格和库存会保留。`, '删除规格模板', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }); }
    catch { return; } finally { confirmationPending = false; }
    if (!current() || !canManage.value || blocked.value || version !== interactionGeneration || catalog.value?.list.find(item => item.id === row.id)?.revision !== rowRevision) return;
    const pending = immutableAttempt({ operation: 'delete', id: row.id, previousIds: [] }); attempt.value = pending; receipt.value = null; recoveryRead.value = false;
    const request = beginWrite(), owner = beginBusy(); error.value = ''; notice.value = ''; let acknowledged = false;
    try { await deleteSupplierProductRule(row.id, rowRevision, request.signal); if (!interactionCurrent(version, pending) || request.signal.aborted) return; acknowledged = true; await reread(pending, version); }
    catch (value) { if (interactionCurrent(version, pending)) { if (!acknowledged && supplierProductRuleKnownRejection(value)) attempt.value = null; error.value = message(value); } }
    finally { endBusy(owner); }
  }
  function finishAttempt() {
    if (!current() || blocked.value || busy.value || !recoveryRead.value) return;
    interactionGeneration++; interactionController?.abort(); attempt.value = null; receipt.value = null; editing.value = false; error.value = ''; notice.value = '已结束本次操作，请按当前列表重新选择'; void load();
  }
  function closeEditor(done?: () => void) { if (busy.value || attempt.value) return; interactionGeneration++; interactionController?.abort(); editing.value = false; done?.(); }
  return { auth, canRead, canManage, catalog, loading, busy, editing, error, notice, filter, editId, editRevision, createRevision, createIds, form,
    attempt, receipt, recoveryRead, submitDisabled, blankDimension, message, load, search, openCreate, openEdit, addDimension, removeDimension,
    immutableAttempt, verify, reread, recover, submit, removeRule, finishAttempt, closeEditor, session, current, invalidate, invalidateContext, dispose, invalidated, blocked };
}
export type SupplierProductRuleEditor = ReturnType<typeof useSupplierProductRuleEditor>;
