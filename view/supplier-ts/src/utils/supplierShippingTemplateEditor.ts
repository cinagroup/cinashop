import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getShippingCities, getShippingTemplate, saveShippingTemplate, previewMode } from '@/api/supplier';
import { ApiError } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { supplierShippingCreation } from '@/api/shippingCreation';
import type { CreationIntent } from '../../../shared/shippingCreation';
import type { ShippingCityOption, ShippingFreeRule, ShippingNoDeliveryRule, ShippingRegionRule, ShippingTemplateDetail, ShippingTemplatePayload } from '@/types';

export interface SupplierShippingSavedEvent { id: number; kind: 'created' | 'updated' }
interface EditorOptions {
  blocked?: () => boolean;
  onSaved?: (event: SupplierShippingSavedEvent) => void | Promise<void>;
  onInvalidate?: () => void;
}
interface TemplateForm extends ShippingTemplatePayload { id: number }

/** One mounted shipping author. Product drafts and list queries belong to callers. */
export function useSupplierShippingTemplateEditor(options: EditorOptions = {}) {
  const saving = ref(false), reading = ref(false), editError = ref(''), needsReload = ref(false);
  const sessionInvalidated = ref(false), uncertainMutation = ref(''), dialogVisible = ref(false);
  const creation = ref<CreationIntent | null>(null), cities = ref<ShippingCityOption[]>([]);
  // A successful POST followed by an unreadable GET is a confirmed write, not a failed submission.
  const awaitingReadback = ref(0);
  const auth = useAuthStore(), blocked = computed(() => Boolean(options.blocked?.()));
  const canView = computed(() => !sessionInvalidated.value && (previewMode || auth.can('supplier.shipping.view')));
  const canManage = computed(() => canView.value && (previewMode || auth.can('supplier.shipping.manage')));
  let editGeneration = 0, confirmationPending = false, updateConfirmed = false;
  let creator: ReturnType<typeof supplierShippingCreation> | undefined;
  let editorRequest: AbortController | undefined;
  const blankRegion = (nationwide = false): ShippingRegionRule => ({ city_ids: nationwide ? [[0]] : [], first: '1.00', first_price: '0.00', continue: '1.00', continue_price: '0.00' });
  const blankFree = (): ShippingFreeRule => ({ city_ids: [], number: '1.00', price: '0.00' });
  const blankNoDelivery = (): ShippingNoDeliveryRule => ({ city_ids: [] });
  const blankForm = (): TemplateForm => ({ id: 0, expectedRevision: undefined, name: '', type: 1, appoint: 0, no_delivery: 0, sort: 0, region_info: [blankRegion(true)], appoint_info: [], no_delivery_info: [] });
  const form = reactive<TemplateForm>(blankForm());
  function stopRequests() { editorRequest?.abort(); editorRequest = undefined; }
  function invalidate() {
    if (sessionInvalidated.value) return;
    sessionInvalidated.value = true; editGeneration++; stopRequests();
    if (confirmationPending) ElMessageBox.close();
    confirmationPending = false; dialogVisible.value = false; cities.value = []; creation.value = null;
    Object.assign(form, blankForm()); reading.value = false; saving.value = false; awaitingReadback.value = 0;
    session.dispose(); options.onInvalidate?.();
  }
  const session = createSupplierSessionScope(invalidate, previewMode);
  function current() { return session.isCurrent(); }
  function canWrite() { return current() && canManage.value && !blocked.value && !uncertainMutation.value; }
  function unknownResult(action: string) {
    uncertainMutation.value = `${action}结果未知，已暂停本页写入。请查询列表并核对实际记录；不要直接重复提交。`;
    return uncertainMutation.value;
  }
  function beginRequest() {
    stopRequests(); const controller = new AbortController(); editorRequest = controller;
    if (session.signal.aborted) controller.abort(session.signal.reason);
    return controller.signal;
  }
  session.signal.addEventListener('abort', stopRequests, { once: true });
  function cancelEditor() {
    if (saving.value && form.id > 0 && !updateConfirmed) unknownResult('保存');
    editGeneration++; stopRequests(); dialogVisible.value = false; reading.value = false; saving.value = false;
    if (confirmationPending) ElMessageBox.close();
    confirmationPending = false;
  }
  watch(() => [auth.user?.id ?? 0, auth.user?.supplier_id ?? 0, auth.can('supplier.shipping.view'), auth.can('supplier.shipping.manage')], () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
  onBeforeUnmount(() => {
    if (confirmationPending) ElMessageBox.close();
    confirmationPending = false; editGeneration++; stopRequests(); session.dispose();
  });
  const cascaderProps = { value: 'city_id', label: 'name', children: 'children', multiple: true, checkStrictly: true, emitPath: true };
  const unitLabel = computed(() => form.type === 1 ? '件' : form.type === 2 ? 'KG' : 'm³');
  function isNationwide(rule: ShippingRegionRule) { return rule.city_ids.some(path => path.length === 1 && path[0] === 0); }
  function decimalValid(value: string, positive = false) { return /^\d{1,10}(?:\.\d{1,2})?$/.test(String(value)) && (!positive || Number(value) > 0); }
  function validationMessage() {
    if (!form.name.trim()) return '请填写运费模板名称';
    if (!form.region_info.length || !isNationwide(form.region_info[0])) return '第一条配送规则必须是默认全国';
    for (const rule of form.region_info) {
      if (!rule.city_ids.length) return '请选择配送区域';
      if (!decimalValid(rule.first, true) || !decimalValid(rule.continue, true)) return '首计量和续计量必须大于0且最多两位小数';
      if (!decimalValid(rule.first_price) || !decimalValid(rule.continue_price)) return '首费和续费必须是最多两位小数的非负数';
    }
    if (form.appoint) for (const rule of form.appoint_info) {
      if (!rule.city_ids.length) return '请选择包邮区域';
      if (!decimalValid(rule.number, true) || !decimalValid(rule.price)) return '包邮门槛格式错误';
    }
    if (form.no_delivery && form.no_delivery_info.some(rule => !rule.city_ids.length)) return '请选择禁配区域';
    return '';
  }
  async function loadCities(generation: number, signal: AbortSignal) {
    if (!canView.value || !current()) return;
    try { const result = await getShippingCities(signal); if (current() && generation === editGeneration) cities.value = result; }
    catch (error) { if (current() && generation === editGeneration) ElMessage.error(error instanceof Error ? error.message : '城市数据加载失败'); }
  }
  function applyDetail(id: number, detail: ShippingTemplateDetail) {
    if (!/^shipping-v1:[a-f0-9]{64}$/.test(detail.revision)) throw new Error('编辑版本缺失或无效，请重新读取模板');
    const regions = detail.templateList.map(rule => ({ ...rule, city_ids: rule.city_ids.map(path => [...path]) }));
    const nationwideIndex = regions.findIndex(isNationwide);
    if (nationwideIndex > 0) regions.unshift(regions.splice(nationwideIndex, 1)[0]);
    const next: TemplateForm = { id, expectedRevision: detail.revision, name: detail.formData.name, type: detail.formData.type,
      appoint: detail.formData.appoint_check, no_delivery: detail.formData.no_delivery_check, sort: detail.formData.sort,
      region_info: regions.length ? regions : [blankRegion(true)],
      appoint_info: detail.appointList.map(rule => ({ ...rule, city_ids: rule.city_ids.map(path => [...path]) })),
      no_delivery_info: detail.noDeliveryList.map(rule => ({ ...rule, city_ids: rule.city_ids.map(path => [...path]) })) };
    Object.assign(form, next);
  }
  async function notifySaved(event: SupplierShippingSavedEvent) {
    try { await options.onSaved?.(event); }
    catch (error) { if (current()) ElMessage.warning(`模板已保存，但目录刷新失败：${error instanceof Error ? error.message : '请重读当前目录'}`); }
  }
  async function openCreate() {
    if (!canWrite() || saving.value || reading.value) return;
    const generation = ++editGeneration, signal = beginRequest();
    reading.value = true; editError.value = ''; needsReload.value = false; awaitingReadback.value = 0;
    Object.assign(form, blankForm()); creation.value = null; dialogVisible.value = true;
    try {
      await loadCities(generation, signal);
      if (!current() || generation !== editGeneration) return;
      if (!previewMode) {
        creator = supplierShippingCreation({ signal, isCurrent: () => current() && generation === editGeneration });
        const pending = await creator.load();
        if (!current() || generation !== editGeneration) return;
        creation.value = pending;
        if (pending) Object.assign(form, pending.payload, { id: 0 });
      }
    } catch (error) {
      if (current() && generation === editGeneration) { needsReload.value = true; editError.value = error instanceof Error ? error.message : '无法读取原创建请求，已阻止新建'; }
    } finally { if (current() && generation === editGeneration) reading.value = false; }
  }
  async function openEdit(id: number) {
    if (!current() || !canView.value || blocked.value || saving.value || reading.value) return;
    const generation = ++editGeneration, signal = beginRequest(); reading.value = true;
    const confirmingSaved = awaitingReadback.value === id;
    try {
      const [detail] = await Promise.all([getShippingTemplate(id, signal), loadCities(generation, signal)]);
      if (!current() || generation !== editGeneration) return;
      applyDetail(id, detail); dialogVisible.value = true; creation.value = null; editError.value = ''; needsReload.value = false; awaitingReadback.value = 0;
      if (confirmingSaved) await notifySaved({ id, kind: 'updated' });
    } catch (error) {
      if (!current() || generation !== editGeneration) return;
      // Failed reads retain the prior inputs and their version, including a confirmed write awaiting readback.
      editError.value = confirmingSaved ? `模板已更新，但最新内容仍未读回。${error instanceof Error ? error.message : '请重试读取'}` : error instanceof Error ? error.message : '运费模板详情加载失败';
      ElMessage.error(editError.value);
    } finally { if (current() && generation === editGeneration) reading.value = false; }
  }
  async function reloadEditor() {
    if (!current() || !canView.value || blocked.value || confirmationPending || saving.value || reading.value || !form.id) return;
    const generation = editGeneration, id = form.id;
    try {
      confirmationPending = true;
      await ElMessageBox.confirm('重新读取会替换当前输入。请先复制需要保留的内容，再与最新模板核对。', '重新读取模板', { type: 'warning', confirmButtonText: '读取最新模板', cancelButtonText: '保留输入' });
      confirmationPending = false;
      if (!current() || generation !== editGeneration || !dialogVisible.value || saving.value) return;
      await openEdit(id);
    } catch (error) { if (current() && error !== 'cancel' && error !== 'close') ElMessage.error('重新读取失败，当前输入已保留'); }
    finally { confirmationPending = false; }
  }
  async function submit() {
    if (!canWrite() || saving.value || reading.value || needsReload.value || !dialogVisible.value || creation.value) return;
    const message = validationMessage(); if (message) return ElMessage.warning(message);
    saving.value = true; updateConfirmed = false; const generation = editGeneration, id = form.id; editError.value = '';
    let confirmedId = 0;
    try {
      const payload: ShippingTemplatePayload = { ...(id > 0 ? { expectedRevision: form.expectedRevision } : {}), name: form.name.trim(), type: form.type,
        appoint: form.appoint, no_delivery: form.no_delivery, sort: form.sort, region_info: form.region_info,
        appoint_info: form.appoint ? form.appoint_info : [], no_delivery_info: form.no_delivery ? form.no_delivery_info : [] };
      if (!id && !previewMode) {
        if (!creator) throw new Error('创建恢复未就绪');
        const pending = await creator.prepare(JSON.parse(JSON.stringify(payload)));
        if (!current() || generation !== editGeneration) return;
        creation.value = pending; Object.assign(form, pending.payload, { id: 0 });
        if (JSON.stringify(pending.payload) !== JSON.stringify(payload)) { editError.value = '另一标签页已有创建请求，已恢复其原始表单。请先恢复查询，不会发送当前未保存输入。'; return; }
        const result = await creator.send(pending.requestKey);
        if (current() && generation === editGeneration) creation.value = result;
        return;
      }
      const saved = await saveShippingTemplate(id, JSON.parse(JSON.stringify(payload)), editorRequest?.signal ?? session.signal);
      if (!current() || generation !== editGeneration) return;
      confirmedId = saved.id; updateConfirmed = true; awaitingReadback.value = saved.id;
      const detail = await getShippingTemplate(saved.id, editorRequest?.signal ?? session.signal);
      if (!current() || generation !== editGeneration) return;
      applyDetail(saved.id, detail); awaitingReadback.value = 0; needsReload.value = false; dialogVisible.value = false;
      ElMessage.success(id ? '运费模板已更新并读回' : '运费模板已创建并读回');
      await notifySaved({ id: saved.id, kind: id ? 'updated' : 'created' });
    } catch (error) {
      if (!current() || generation !== editGeneration) return;
      if (confirmedId) { needsReload.value = true; editError.value = `模板已更新，但最新内容读取失败。当前输入已保留，保存已暂停，请重新读取模板核对。${error instanceof Error ? error.message : ''}`; }
      else {
        editError.value = !id && !previewMode ? `${error instanceof Error ? error.message : '创建未确认'}。原请求已保留，请恢复查询或使用原请求重试。`
          : error instanceof ApiError && error.status === 400 ? error.message : unknownResult('保存');
        needsReload.value = /其他操作修改|编辑版本/.test(editError.value);
      }
      ElMessage.error(editError.value);
    } finally { if (current() && generation === editGeneration) saving.value = false; }
  }
  async function creationAction(action: 'recover' | 'send' | 'acknowledge') {
    if (!creator || !creation.value || saving.value || !current() || !canManage.value || blocked.value) return;
    const generation = editGeneration, key = creation.value.requestKey; saving.value = true; editError.value = '';
    try {
      if (action === 'acknowledge') {
        const id = creation.value.receipt?.id;
        if (!id) throw new Error('结果未确认，不能完成创建');
        await creator.acknowledge(key);
        if (!current() || generation !== editGeneration) return;
        creation.value = null; dialogVisible.value = false; ElMessage.success('已确认原创建结果');
        await notifySaved({ id, kind: 'created' });
      } else {
        const result = await creator[action](key);
        if (!current() || generation !== editGeneration) return;
        creation.value = result;
        if (!result.receipt) editError.value = '暂未查到已提交回执。原请求继续保留，只能使用原键和原内容重试。';
      }
    } catch (error) { if (current() && generation === editGeneration) editError.value = error instanceof Error ? error.message : '恢复失败，原请求已保留'; }
    finally { if (current() && generation === editGeneration) saving.value = false; }
  }
  function addRegion() { if (!canWrite() || saving.value || reading.value || creation.value) return; if (form.region_info.length >= 100) return ElMessage.warning('配送规则不能超过100组'); form.region_info.push(blankRegion()); }
  function addFreeRule() { if (!canWrite() || saving.value || reading.value || creation.value) return; if (form.appoint_info.length >= 100) return ElMessage.warning('包邮规则不能超过100组'); form.appoint_info.push(blankFree()); }
  function addNoDeliveryRule() { if (!canWrite() || saving.value || reading.value || creation.value) return; if (form.no_delivery_info.length >= 100) return ElMessage.warning('禁配规则不能超过100组'); form.no_delivery_info.push(blankNoDelivery()); }
  return { form, saving, reading, editError, needsReload, sessionInvalidated, uncertainMutation, dialogVisible, creation, cities, canView, canManage,
    current, session, openCreate, openEdit, reloadEditor, submit, creationAction, unknownResult, canWrite, blocked, cancelEditor, awaitingReadback,
    cascaderProps, unitLabel, isNationwide, addRegion, addFreeRule, addNoDeliveryRule, validationMessage };
}
export type SupplierShippingEditor = ReturnType<typeof useSupplierShippingTemplateEditor>;
