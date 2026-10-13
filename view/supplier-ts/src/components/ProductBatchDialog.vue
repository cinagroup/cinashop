<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { productBatchFactsValid, productBatchMatches } from '@/utils/productBatch';
import { applySupplierProductBatch, getProductCategories, getSupplierBatchForms, getSupplierBatchFormFields,
  getSupplierProductBatchSelection, previewMode } from '@/api/supplier';
import { getProductShippingOptions } from '@/api/productShipping';
import type { ProductCategory, SupplierProductBatchFacts, SupplierProductBatchPayload, SupplierProductBatchSelection } from '@/types';

const props = defineProps<{ selectedIds: number[]; filters: Record<string, unknown> }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const route = useRoute(), auth = useAuthStore();
const invalidated = ref(false), phase = ref<'idle' | 'reading' | 'ready' | 'writing' | 'unknown' | 'verified'>('idle');
const error = ref(''), confirmation = ref(''), facts = ref<SupplierProductBatchFacts | null>(null);
const categories = ref<ProductCategory[]>([]), forms = ref<Array<{ id: number; name: string }>>([]);
const formFields = ref<Array<{ title: string; name: string; require: boolean }>>([]);
const freightOptions = ref<Array<{ id: number; name: string }>>([]), freightPage = ref(1), freightCount = ref(0), freightLoading = ref(false);
const formLoading = ref(false), optionsLoading = ref(true), optionsFailed = ref(false);
const mode = ref<0 | 1>(props.selectedIds.length ? 0 : 1);
const draft = reactive({ type: 1 as 1 | 3 | 7 | 8, cate_id: [] as number[], delivery_type: [1], system_form_id: 0,
  freight: 1 as 1 | 2 | 3, postage: '0.00', temp_id: 0 });
let generation = 0, intentGeneration = 0, formGeneration = 0, freightGeneration = 0;
let attempt: { payload: SupplierProductBatchPayload; ids: number[] } | null = null;
const scope = createSupplierSessionScope(() => {
  invalidated.value = true; generation++; formGeneration++; freightGeneration++;
  facts.value = null; attempt = null; categories.value = []; forms.value = []; formFields.value = []; freightOptions.value = [];
  Object.assign(draft, { cate_id: [], delivery_type: [], system_form_id: 0, temp_id: 0, postage: '0.00' });
  phase.value = 'idle'; error.value = '供应商会话已改变，请重新打开页面';
});
const canManage = computed(() => !invalidated.value && auth.can('supplier.product.manage'));
const busy = computed(() => phase.value === 'reading' || phase.value === 'writing');
const submitDisabled = computed(() => !canManage.value || phase.value !== 'ready' || optionsLoading.value || optionsFailed.value || formLoading.value || !facts.value);
function current(run: number) { return scope.isCurrent() && canManage.value && run === generation; }
function invalidateSelection() {
  if (phase.value === 'verified') return; // Parent list refresh clears selection after verified completion.
  generation++; facts.value = null; confirmation.value = '';
  if (attempt || phase.value === 'writing') { phase.value = 'unknown'; error.value = '选择已改变，先核对上次操作的原商品，不能重复提交'; }
  else { phase.value = 'idle'; error.value = '选择或筛选已改变，请重新读取商品'; }
}
watch(() => JSON.stringify({ ids: props.selectedIds, filters: props.filters, mode: mode.value, path: route.fullPath }), invalidateSelection);
watch(() => JSON.stringify(draft), () => { intentGeneration++; }, { flush: 'sync' });
function selection(): SupplierProductBatchSelection {
  return { all: mode.value, ids: mode.value ? [] : [...new Set(props.selectedIds)].sort((a, b) => a - b), where: mode.value ? JSON.parse(JSON.stringify(props.filters)) : {} };
}
async function readSelection() {
  if (!scope.isCurrent() || !canManage.value || busy.value || attempt) return;
  const selected = selection(); if (!selected.all && !selected.ids.length) return ElMessage.warning('请选定商品或切换为当前筛选全部');
  const run = ++generation; phase.value = 'reading'; error.value = ''; confirmation.value = '';
  try {
    const value = await getSupplierProductBatchSelection(selected, scope.signal);
    if (!current(run)) return;
    if (!productBatchFactsValid(value)) throw new Error('商品确认事实不完整，请刷新后重试');
    facts.value = value; phase.value = 'ready';
  } catch (cause) { if (current(run)) { phase.value = 'idle'; facts.value = null; error.value = cause instanceof Error ? cause.message : '商品读取失败'; } }
}
const categoryOptions = computed(() => {
  const walk = (rows: ProductCategory[], allowed: boolean): Array<{ id: number; label: string }> => rows.flatMap(row => {
    const active = allowed && row.is_show === 1;
    return [...(active ? [{ id: row.id, label: `${'— '.repeat(row.level)}${row.cate_name}` }] : []), ...walk(row.children, active)];
  }); return walk(categories.value, true);
});
async function loadFreight(page = 1) {
  if (!scope.isCurrent() || !canManage.value || phase.value === 'writing') return;
  const run = ++freightGeneration; freightLoading.value = true;
  try {
    const result = await getProductShippingOptions({ page, limit: 20 }, scope.signal);
    if (!scope.isCurrent() || run !== freightGeneration) return;
    freightPage.value = page; freightCount.value = result.count; freightOptions.value = result.data;
  } catch (cause) { if (scope.isCurrent() && run === freightGeneration) error.value = cause instanceof Error ? cause.message : '运费模板加载失败'; }
  finally { if (run === freightGeneration) freightLoading.value = false; }
}
async function loadFormFields() {
  const run = ++formGeneration, id = draft.system_form_id; formFields.value = [];
  if (!scope.isCurrent() || !canManage.value || id === 0) { formLoading.value = false; return; }
  formLoading.value = true;
  try { const value = await getSupplierBatchFormFields(id, scope.signal);
    if (!scope.isCurrent() || run !== formGeneration || id !== draft.system_form_id) return; formFields.value = value;
  } catch (cause) { if (scope.isCurrent() && run === formGeneration) { draft.system_form_id = 0; error.value = cause instanceof Error ? cause.message : '表单读取失败'; } }
  finally { if (run === formGeneration) formLoading.value = false; }
}
function payload(): SupplierProductBatchPayload | null {
  const data: SupplierProductBatchPayload['data'] = {};
  if (draft.type === 1) {
    const ids = [...new Set(draft.cate_id)].sort((a, b) => a - b);
    if (!ids.length || ids.length > 20 || ids.join(',').length > 64 || ids.some(id => !categoryOptions.value.some(option => option.id === id))) {
      ElMessage.warning('请选择可用分类，最多20项'); return null;
    } data.cate_id = ids;
  } else if (draft.type === 3) {
    if (!draft.delivery_type.length || draft.delivery_type.some(value => ![1, 2, 3].includes(value))) { ElMessage.warning('请选择物流方式'); return null; }
    data.delivery_type = [...new Set(draft.delivery_type)].sort((a, b) => a - b);
  } else if (draft.type === 7) {
    if (draft.system_form_id !== 0 && !forms.value.some(option => option.id === draft.system_form_id)) { ElMessage.warning('请选择当前可用表单'); return null; }
    data.system_form_id = draft.system_form_id;
  }
  else {
    if (draft.freight === 3 && (!draft.temp_id || !freightOptions.value.some(option => option.id === draft.temp_id))) { ElMessage.warning('请选择当前可用运费模板'); return null; }
    if (draft.freight === 2 && (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(draft.postage) || Number(draft.postage) <= 0)) { ElMessage.warning('固定运费须大于0且最多两位小数'); return null; }
    const [whole, cents = ''] = draft.postage.split('.');
    Object.assign(data, { freight: draft.freight, postage: draft.freight === 2 ? `${whole}.${cents.padEnd(2, '0')}` : '0.00', temp_id: draft.freight === 3 ? draft.temp_id : 0 });
  }
  if ([3, 8].includes(draft.type) && facts.value?.products.some(row => row.product_type !== 0)) { ElMessage.warning('物流和运费设置仅支持实物商品'); return null; }
  return { ...selection(), type: draft.type, data, expected_revision: facts.value!.revision };
}
async function recover() {
  if (!scope.isCurrent() || !canManage.value || busy.value || !attempt) return;
  const pending = attempt, run = ++generation; phase.value = 'reading'; error.value = '';
  try {
    const value = await getSupplierProductBatchSelection({ all: 0, ids: pending.ids, where: {} }, scope.signal);
    if (!current(run) || pending !== attempt) return; facts.value = value;
    if (!productBatchMatches(value, pending.payload, pending.ids)) {
      phase.value = 'unknown'; error.value = '已重新读取原商品，当前值与操作目标不一致；请核对后关闭，再开始新的操作'; return;
    }
    phase.value = 'verified'; attempt = null; confirmation.value = '已重新读取，全部原商品与本次操作目标一致'; emit('changed');
  } catch (cause) { if (current(run)) { phase.value = 'unknown'; error.value = cause instanceof Error ? cause.message : '操作结果仍未确认，请再次读取原商品'; } }
}
async function submit() {
  if (!scope.isCurrent() || submitDisabled.value || attempt) return;
  const value = payload(); if (!value) return;
  const ids = [...facts.value!.ids], run = generation, intent = intentGeneration;
  try { await ElMessageBox.confirm(`本次将为${ids.length}个商品修改${{ 1: '商品分类', 3: '物流方式', 7: '自定义留言', 8: '运费设置' }[value.type]}，只修改此项。继续提交？`, '确认批量设置', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }); }
  catch { return; }
  if (!current(run) || intent !== intentGeneration || submitDisabled.value || attempt) return;
  attempt = { payload: JSON.parse(JSON.stringify(value)), ids }; phase.value = 'writing'; error.value = '';
  try {
    const receipt = await applySupplierProductBatch(value, scope.signal);
    if (!current(run)) return;
    if (!receipt.verified || receipt.updated !== ids.length || !productBatchMatches(receipt, value, ids)) throw new Error('执行回执不完整，请重新读取并核对');
    phase.value = 'unknown'; await recover();
  } catch (cause) { if (current(run)) { phase.value = 'unknown'; error.value = cause instanceof Error ? cause.message : '执行结果未确认，请读取原商品核对'; } }
}
function close() { if (!busy.value) emit('close'); }
onMounted(async () => {
  if (!scope.isCurrent() || !canManage.value) { optionsLoading.value = false; return; }
  try { const [tree, formOptions] = await Promise.all([getProductCategories(), getSupplierBatchForms(scope.signal)]);
    if (!scope.isCurrent()) return; categories.value = tree; forms.value = formOptions; await loadFreight();
  } catch (cause) { if (scope.isCurrent()) { optionsFailed.value = true; error.value = cause instanceof Error ? cause.message : '选择目录加载失败'; } }
  finally { optionsLoading.value = false; }
});
onBeforeUnmount(() => { generation++; formGeneration++; freightGeneration++; scope.dispose(); });
</script>

<template>
  <el-dialog :model-value="true" title="批量设置商品" width="min(820px, 96vw)" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="close">
    <el-alert v-if="previewMode" title="当前为预览模式" description="仅模拟示例商品；真实归属、引用和事务由服务端核验。" type="info" :closable="false" />
    <el-alert v-if="error" :title="error" type="warning" :closable="false" class="batch-alert" />
    <el-alert v-if="confirmation" :title="confirmation" type="success" :closable="false" class="batch-alert" />
    <div class="batch-fields">
      <el-form label-position="top" :disabled="busy || !canManage || phase === 'unknown' || phase === 'verified'">
        <el-form-item label="处理商品"><el-radio-group v-model="mode"><el-radio :value="0">{{ phase === 'verified' && mode === 0 ? `本次选定 ${facts?.count ?? 0} 项` : `当前选定 ${selectedIds.length} 项` }}</el-radio><el-radio :value="1">当前筛选全部</el-radio></el-radio-group><p class="batch-help">最多100个商品；范围超限会拒绝整个操作。</p></el-form-item>
        <el-form-item label="本次修改项目"><el-select v-model="draft.type" style="width:100%"><el-option label="商品分类" :value="1" /><el-option label="物流方式" :value="3" /><el-option label="自定义留言" :value="7" /><el-option label="运费设置" :value="8" /></el-select></el-form-item>
        <el-form-item v-if="draft.type === 1" label="商品分类"><el-select v-model="draft.cate_id" multiple filterable :loading="optionsLoading" style="width:100%"><el-option v-for="item in categoryOptions" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
        <el-form-item v-if="draft.type === 3" label="物流方式"><el-checkbox-group v-model="draft.delivery_type"><el-checkbox :value="1">快递</el-checkbox><el-checkbox :value="2">自提</el-checkbox><el-checkbox :value="3">门店配送</el-checkbox></el-checkbox-group></el-form-item>
        <template v-if="draft.type === 7"><el-form-item label="自定义留言表单"><el-select v-model="draft.system_form_id" :loading="optionsLoading || formLoading" style="width:100%" @change="loadFormFields"><el-option label="关闭自定义留言" :value="0" /><el-option v-for="item in forms" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item><el-table v-if="formFields.length" :data="formFields" max-height="180"><el-table-column prop="title" label="表单标题" /><el-table-column prop="name" label="字段类型" /><el-table-column label="要求"><template #default="item">{{ item.row.require ? '必填' : '选填' }}</template></el-table-column></el-table></template>
        <template v-if="draft.type === 8"><el-form-item label="运费方式"><el-radio-group v-model="draft.freight"><el-radio :value="1">包邮</el-radio><el-radio :value="2">固定邮费</el-radio><el-radio :value="3">运费模板</el-radio></el-radio-group></el-form-item><el-form-item v-if="draft.freight === 2" label="固定运费（元）"><el-input v-model="draft.postage" inputmode="decimal" maxlength="13" placeholder="例如1.25" /></el-form-item><el-form-item v-if="draft.freight === 3" label="当前供应商运费模板"><el-select v-model="draft.temp_id" :loading="freightLoading" style="width:100%"><el-option v-for="item in freightOptions" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-pagination v-if="freightCount > 20" small layout="prev,pager,next" :current-page="freightPage" :page-size="20" :total="freightCount" @current-change="loadFreight" /></el-form-item></template>
      </el-form>
      <div v-if="facts" class="batch-facts"><p>已读取 {{ facts.count }} 个商品</p><el-table :data="facts.products" max-height="210"><el-table-column prop="id" label="ID" width="70" /><el-table-column prop="store_name" label="商品" min-width="160" /><el-table-column label="当前值" min-width="190"><template #default="item">{{ draft.type === 1 ? `分类 ${item.row.cate_id || '无'}` : draft.type === 3 ? `物流 ${item.row.delivery_type || '无'}` : draft.type === 7 ? `表单 ${item.row.system_form_id || '关闭'}` : `运费 ${item.row.freight} / ${item.row.postage}元 / 模板${item.row.temp_id}` }}</template></el-table-column></el-table></div>
    </div>
    <template #footer><div class="batch-footer"><el-button :disabled="busy" @click="close">关闭</el-button><el-button v-if="phase === 'unknown'" type="warning" :disabled="!canManage || busy" @click="recover">读取原商品并核对</el-button><el-button v-else :loading="phase === 'reading'" :disabled="!canManage || busy || phase === 'verified'" @click="readSelection">读取当前商品</el-button><el-button type="primary" :loading="phase === 'writing'" :disabled="submitDisabled" @click="submit">确认并提交</el-button></div></template>
  </el-dialog>
</template>
<style scoped>
.batch-alert { margin-top:12px; }.batch-help { flex-basis:100%;width:100%;margin:6px 0 0;color:var(--text-muted);font-size:12px; }
.batch-fields { max-height:65dvh;overflow-y:auto;padding:14px 4px 4px; }.batch-facts { margin-top:16px; }
.batch-footer { display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap; }.batch-footer .el-button + .el-button { margin-left:0; }
@media(max-width:600px) { .batch-fields { max-height:calc(70dvh - 190px); }.batch-footer { justify-content:stretch; }.batch-footer .el-button { flex:1; } }
</style>
