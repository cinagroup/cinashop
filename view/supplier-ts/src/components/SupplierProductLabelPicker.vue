<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { isAxiosError } from 'axios';
import { ElMessage } from 'element-plus';
import { getSupplierProductLabelCatalog, getSupplierProductLabelForm, getSupplierProductLabelTree, saveSupplierProductLabel } from '@/api/productLabels';
import { ApiError } from '@/api/http';
import type { SupplierProductLabelTreeGroup } from '@/types/productLabels';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ modelValue: number[]; context: number; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number[]]; availability: [{ ids: number[]; ready: boolean }] }>();
const auth = useAuthStore(), groups = ref<SupplierProductLabelTreeGroup[]>([]);
const loading = ref(false), failed = ref(false), dialog = ref(false), busy = ref(false), uncertain = ref(false), invalid = ref(false);
const loaded = ref(false);
const options = ref<{ value: number; label: string }[]>([]), draft = reactive({ label_cate: 0, label_name: '' });
const baseline = ref<number[]>([]), pendingId = ref<number | null>(null), pendingDraft = ref<{ label_cate: number; label_name: string } | null>(null);
const pendingContext = ref<number | null>(null);
let generation = 0; const requests = new Set<AbortController>();
function cancel() { generation++; for (const request of requests) request.abort(); requests.clear(); loading.value = false; busy.value = false; }
const session = createSupplierSessionScope(() => { cancel(); invalid.value = true; dialog.value = false; groups.value = []; options.value = []; });
const current = (value: number) => value === generation && session.isCurrent() && !invalid.value;
const canWrite = computed(() => auth.can('supplier.product.manage') && !props.disabled && !invalid.value && session.isCurrent());
const leaves = computed(() => groups.value.flatMap(group => group.children));
const unavailable = computed(() => props.modelValue.filter(id => !leaves.value.some(label => label.id === id)));
watch(() => ({ ids: [...unavailable.value], ready: loaded.value && !loading.value && !failed.value && !invalid.value }), value => emit('availability', value), { immediate: true });
const selected = computed({ get: () => [...props.modelValue], set: (ids: number[]) => {
  if (canWrite.value && !loading.value && !failed.value && ids.length <= 100) emit('update:modelValue', [...new Set(ids)]);
} });
async function request<T>(work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController(); requests.add(controller);
  try { return await work(controller.signal); } finally { requests.delete(controller); }
}
async function reload() {
  if (!session.isCurrent() || invalid.value || loading.value || busy.value) return;
  const token = ++generation; loading.value = true;
  try { const rows = await request(getSupplierProductLabelTree); if (current(token)) { groups.value = rows; failed.value = false; loaded.value = true; } }
  catch (error) { if (current(token)) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '标签读取失败'); } }
  finally { if (current(token)) loading.value = false; }
}
async function openCreate() {
  if (!canWrite.value || loading.value || busy.value || failed.value) return;
  if (uncertain.value && pendingDraft.value) { dialog.value = true; return; }
  const token = ++generation; busy.value = true;
  try {
    const [form, catalog] = await Promise.all([request(getSupplierProductLabelForm), request(getSupplierProductLabelCatalog)]);
    if (!current(token)) return;
    options.value = form.rules[0].options.filter(option => catalog.groups.some(group => group.id === option.value && group.type === 0 && group.relation_id === 0 && group.is_show === 1));
    baseline.value = catalog.list.map(label => label.id);
    draft.label_cate = options.value[0]?.value ?? 0; draft.label_name = '';
    pendingId.value = null; pendingDraft.value = null; pendingContext.value = null; uncertain.value = false; dialog.value = true;
  } catch (error) { if (current(token)) ElMessage.error(error instanceof Error ? error.message : '标签表单读取失败'); }
  finally { if (current(token)) busy.value = false; }
}
async function verifyCreated() {
  if (!canWrite.value || busy.value || !pendingDraft.value) return;
  const token = ++generation; busy.value = true;
  try {
    const [tree, catalog] = await Promise.all([request(getSupplierProductLabelTree), request(getSupplierProductLabelCatalog)]);
    if (!current(token)) return;
    groups.value = tree; failed.value = false; loaded.value = true;
    const expected = pendingDraft.value;
    const candidates = catalog.list.filter(label => label.label_cate === expected.label_cate && label.label_name === expected.label_name
      && !baseline.value.includes(label.id) && (pendingId.value === null || label.id === pendingId.value));
    const label = candidates.length === 1 ? candidates[0] : undefined;
    if (!label || !label.selectable || !tree.some(group => group.children.some(item => item.id === label.id && item.type === 2 && item.relation_id === auth.user?.supplier_id))) {
      uncertain.value = true; return void ElMessage.warning('新增结果尚未核对成功，请刷新核对或关闭后查看标签管理');
    }
    if (pendingContext.value === props.context && !props.modelValue.includes(label.id)) {
      if (props.modelValue.length >= 100) return void ElMessage.warning('已达到100个标签，请先调整选择');
      emit('update:modelValue', [...props.modelValue, label.id]);
    }
    const selectedHere = pendingContext.value === props.context;
    uncertain.value = false; dialog.value = false; pendingDraft.value = null; pendingId.value = null; pendingContext.value = null;
    ElMessage.success(selectedHere ? '标签已创建并选中' : '标签已创建，请为当前商品选择标签');
  } catch (error) { if (current(token)) { uncertain.value = true; ElMessage.error(error instanceof Error ? error.message : '新增结果尚未核对成功'); } }
  finally { if (current(token)) busy.value = false; }
}
async function create() {
  if (!canWrite.value || busy.value || uncertain.value) return;
  const name = draft.label_name.trim();
  if (!name || [...name].length > 20 || !options.value.some(option => option.value === draft.label_cate)) return void ElMessage.warning('请选择标签组并填写1至20字的名称');
  const token = ++generation; busy.value = true; pendingDraft.value = { label_cate: draft.label_cate, label_name: name }; pendingContext.value = props.context; uncertain.value = true;
  try {
    const receipt = await request(signal => saveSupplierProductLabel(0, { ...pendingDraft.value! }, signal));
    if (!current(token)) return; pendingId.value = receipt.id; uncertain.value = true;
  } catch (error) {
    if (current(token)) {
      const response = isAxiosError(error) ? error.response : undefined;
      const refusedEnvelope = response && [400, 404, 409].includes(response.status)
        && response.data && typeof response.data === 'object' && response.data.status === response.status
        && typeof response.data.msg === 'string';
      const rejected = error instanceof ApiError && [400, 404, 409, 400011, 410000, 410001, 410002].includes(error.status) || Boolean(refusedEnvelope);
      uncertain.value = !rejected;
      if (rejected) { pendingDraft.value = null; pendingId.value = null; pendingContext.value = null; }
      ElMessage.error(error instanceof Error ? error.message : '新增结果未知，请先核对');
    }
  } finally { if (current(token)) busy.value = false; }
  if (current(token) && pendingId.value !== null) await verifyCreated();
}
watch(() => props.context, () => { cancel(); dialog.value = false; groups.value = []; options.value = []; loaded.value = false; void reload(); });
onMounted(() => void reload()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>

<template>
  <div class="label-picker">
    <el-select v-model="selected" multiple :multiple-limit="100" filterable collapse-tags collapse-tags-tooltip :disabled="!canWrite || loading || failed" :loading="loading" placeholder="选择商品标签" aria-label="商品标签">
      <el-option-group v-for="group in groups" :key="group.id" :label="group.label_name"><el-option v-for="label in group.children" :key="label.id" :value="label.id" :label="label.label_name" /></el-option-group>
      <el-option v-for="id in unavailable" :key="`unavailable-${id}`" :value="id" :label="`原标签 #${id}（暂不可选）`" />
    </el-select>
    <div class="label-actions"><el-button :disabled="!canWrite || loading || busy || failed" @click="openCreate">新增标签</el-button><el-button text :disabled="loading || busy || invalid" @click="reload">刷新标签</el-button><el-button v-if="modelValue.length" text :disabled="!canWrite || loading || busy || failed" @click="selected = []">清空标签选择</el-button></div>
    <p v-if="unavailable.length" class="label-note">原有 {{ unavailable.length }} 个标签暂不可选；调整标签前请先移除这些原标签。不修改标签时会保留原关联。</p>
    <p v-if="failed" role="alert" class="label-note">标签读取失败，请刷新后再修改标签选择。</p>
    <el-dialog v-model="dialog" title="添加商品标签" width="min(480px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
      <el-alert v-if="uncertain" type="warning" :closable="false" title="新增结果需要核对，请先刷新核对，避免重复创建。" />
      <el-form label-position="top" :disabled="busy || uncertain || !canWrite">
        <el-form-item label="标签组" required><el-select v-model="draft.label_cate" aria-label="新增标签组"><el-option v-for="option in options" :key="option.value" :value="option.value" :label="option.label" /></el-select></el-form-item>
        <el-form-item label="标签名称" required><el-input v-model="draft.label_name" maxlength="20" show-word-limit aria-label="新增标签名称" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="dialog = false">关闭</el-button><el-button v-if="uncertain" :loading="busy" :disabled="!canWrite" @click="verifyCreated">刷新核对新增结果</el-button><el-button v-else type="primary" :loading="busy" :disabled="!canWrite" @click="create">创建并选中</el-button></template>
    </el-dialog>
  </div>
</template>
<style scoped>
.label-picker { width: 100%; } .label-picker > .el-select { width: 100%; } .label-actions { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; } .label-note { color:var(--el-text-color-secondary); font-size:12px; line-height:1.6; margin:6px 0 0; }
</style>
