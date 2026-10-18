<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductSystemFormCatalog, getSupplierProductSystemFormPreview } from '@/api/productSystemForms';
import { previewMode } from '@/api/supplier';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { productSystemFormId } from '@/utils/productSystemForms';
import type { SupplierProductSystemFormAvailability, SupplierProductSystemFormOption, SupplierProductSystemFormPreview, SupplierProductSystemFormSelection } from '@/types/productSystemForms';
const props = defineProps<{ modelValue: number; selection: SupplierProductSystemFormSelection | null; changed: boolean; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number]; availability: [SupplierProductSystemFormAvailability] }>();
const auth = useAuthStore(), enabled = ref(props.modelValue > 0), catalog = ref<SupplierProductSystemFormOption[]>([]), preview = ref<SupplierProductSystemFormPreview | null>(null);
const loading = ref(false), loaded = ref(false), failed = ref(false), previewLoading = ref(false), previewFailed = ref(false), invalid = ref(false);
let generation = 0, previewGeneration = 0, request: AbortController | undefined, previewRequest: AbortController | undefined;
function cancelPreview() { previewGeneration++; previewRequest?.abort(); previewLoading.value = false; preview.value = null; previewFailed.value = false; }
function cancel() { generation++; request?.abort(); loading.value = false; cancelPreview(); }
function invalidate() { cancel(); invalid.value = true; enabled.value = false; catalog.value = []; loaded.value = false; failed.value = false; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const listed = computed(() => catalog.value.some(row => row.id === props.modelValue));
const previewReady = computed(() => !!preview.value && preview.value.id === props.modelValue && !previewLoading.value && !previewFailed.value);
watch(() => ({ ready: !invalid.value && (!enabled.value || loaded.value && !loading.value && !failed.value && previewReady.value),
  valid: !invalid.value && (enabled.value ? props.modelValue > 0 && listed.value && previewReady.value : props.modelValue === 0) }), value => emit('availability', value), { immediate: true });
function toggle(value: unknown) {
  if (!canEdit.value || typeof value !== 'boolean') return;
  enabled.value = value;
  if (!value) cancelPreview();
  emit('update:modelValue', value ? props.modelValue : 0);
}
function choose(value: unknown) {
  if (!canEdit.value || loading.value || failed.value || !loaded.value) return;
  try { const id = productSystemFormId(value); if (!id || !catalog.value.some(row => row.id === id)) throw Error('模板已变化，请刷新后选择'); emit('update:modelValue', id); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '留言模板无效'); }
}
async function readPreview() {
  cancelPreview();
  const id = props.modelValue;
  if (!id || invalid.value || !session.isCurrent()) return;
  const token = ++previewGeneration, controller = new AbortController(); previewRequest = controller; previewLoading.value = true;
  const current = () => token === previewGeneration && !invalid.value && session.isCurrent() && props.modelValue === id;
  try { const value = await getSupplierProductSystemFormPreview(id, controller.signal); if (current()) preview.value = value; }
  catch (error) { if (current()) { previewFailed.value = true; ElMessage.error(error instanceof Error ? error.message : '留言模板预览失败'); } }
  finally { if (current()) previewLoading.value = false; }
}
async function reload() {
  if (invalid.value || !session.isCurrent() || loading.value) return;
  const token = ++generation, controller = new AbortController(); request = controller;
  catalog.value = []; loaded.value = false; failed.value = false; loading.value = true; cancelPreview();
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try { const value = await getSupplierProductSystemFormCatalog(controller.signal); if (current()) { catalog.value = value; loaded.value = true; await readPreview(); } }
  catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '留言模板目录读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.modelValue, id => { enabled.value = id > 0; void readPreview(); });
watch(() => props.context, () => { cancel(); enabled.value = props.modelValue > 0; catalog.value = []; loaded.value = false; failed.value = false; void reload(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void reload()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="system-form-picker">
    <el-checkbox :model-value="enabled" :disabled="!canEdit" @update:model-value="toggle">启用自定义留言</el-checkbox>
    <div v-if="enabled" class="system-form-actions">
      <el-select :model-value="modelValue || undefined" aria-label="自定义留言模板" filterable placeholder="请选择留言模板" :disabled="!canEdit || loading || failed || !loaded" @update:model-value="choose">
        <el-option v-if="modelValue && !listed" :value="modelValue" :label="`历史表单 #${modelValue}（暂不可选）`" disabled />
        <el-option v-for="item in catalog" :key="item.id" :value="item.id" :label="item.name" />
      </el-select>
      <el-button text :disabled="invalid || loading" @click="reload">刷新留言模板</el-button>
      <el-button text :disabled="!canEdit" @click="toggle(false)">关闭自定义留言</el-button>
    </div>
    <p>顾客下单时填写所选模板。这里只预览字段，不填写顾客答案；关闭后保留已有订单的留言。</p>
    <p v-if="enabled && !modelValue" role="status">请先选择留言模板再保存。</p>
    <p v-if="!changed && selection && !selection.available" role="status">原留言模板 #{{ selection.system_form_id }} 暂不可用。未修改时保留原绑定；可重新选择或关闭。</p>
    <p v-if="catalog.length === 500">目录最多显示500项，可能还有其他表单；未列出的原绑定保持不变。</p>
    <p v-if="loading || previewLoading" role="status">正在读取留言模板…</p>
    <div v-if="enabled && preview" class="system-form-preview">
      <strong>{{ preview.name }}</strong>
      <table aria-label="留言模板字段预览"><thead><tr><th>字段名称</th><th>字段类型</th><th>是否必填</th></tr></thead><tbody><tr v-for="(field, index) in preview.fields" :key="index"><td>{{ field.title }}</td><td>{{ field.type }}</td><td>{{ field.required ? '必填' : '选填' }}</td></tr></tbody></table>
    </div>
    <p v-if="failed" role="alert">留言模板目录读取失败。未修改时可保留原绑定；也可关闭自定义留言或刷新后重选。</p>
    <p v-if="previewFailed" role="alert">留言模板预览不可用。请刷新后重新选择，或关闭自定义留言。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.system-form-picker, .system-form-preview { min-width: 0; }
.system-form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.system-form-actions :deep(.el-select) { width: min(100%, 340px); }
.system-form-picker p { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.system-form-preview { margin-top: 16px; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
th, td { padding: 10px 6px; text-align: left; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
th:first-child { width: 50%; }
</style>
