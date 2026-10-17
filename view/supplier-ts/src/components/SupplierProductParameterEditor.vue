<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductParameterCatalog } from '@/api/productParameters';
import { previewMode } from '@/api/supplier';
import type { SupplierProductParameterAvailability, SupplierProductParameterDraft, SupplierProductParameterSelection, SupplierProductParameterTemplate } from '@/types/productParameters';
import { productParameterAvailable, productParameterDraft } from '@/utils/productParameters';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';
const props = defineProps<{ modelValue: SupplierProductParameterDraft; selection: SupplierProductParameterSelection | null; changed: boolean; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [SupplierProductParameterDraft]; availability: [SupplierProductParameterAvailability] }>();
const auth = useAuthStore(), catalog = ref<SupplierProductParameterTemplate[]>([]), loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; catalog.value = []; loaded.value = false; failed.value = false; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const available = computed(() => productParameterAvailable(catalog.value, props.modelValue));
const historical = computed(() => !props.changed && !!props.selection && (!props.selection.consistent || !props.selection.available));
watch(() => ({ ready: loaded.value && !loading.value && !failed.value && !invalid.value, valid: available.value }), value => emit('availability', value), { immediate: true });
function update(value: SupplierProductParameterDraft) {
  if (!canEdit.value) return;
  try { emit('update:modelValue', productParameterDraft(value)); } catch (error) { ElMessage.warning(error instanceof Error ? error.message : '商品参数无效'); }
}
function selectTemplate(raw: unknown) {
  if (!canEdit.value || loading.value || failed.value || !loaded.value) return;
  const id = raw === '' || raw === undefined || raw === null ? 0 : raw;
  if (id === 0) return update({ ...props.modelValue, specs_id: 0 });
  const item = catalog.value.find(item => item.id === id);
  if (!item) return void ElMessage.warning('模板已变化，请刷新后再选择');
  if (item.specs.length > 100) return void ElMessage.warning('此模板超过100项，无法完整载入；可清除模板并手动填写参数');
  update({ specs_id: item.id, specs: item.specs.map(row => ({ ...row })) });
}
function updateRow(index: number, key: 'name' | 'value' | 'sort', value: unknown) {
  if (!props.modelValue.specs[index]) return;
  const specs = props.modelValue.specs.map(row => ({ ...row }));
  if (key === 'sort') specs[index]!.sort = value === null || value === undefined ? 0 : value as number;
  else specs[index]![key] = value as string;
  update({ specs_id: props.modelValue.specs_id, specs });
}
function addRow() { if (props.modelValue.specs.length < 100) update({ specs_id: props.modelValue.specs_id, specs: [...props.modelValue.specs, { id: 0, temp_id: 0, name: '', value: '', sort: 0 }] }); }
function removeRow(index: number) { if (index > 0 && index < props.modelValue.specs.length) update({ specs_id: props.modelValue.specs_id, specs: props.modelValue.specs.filter((_, i) => i !== index) }); }
function clearTemplate() { update({ specs_id: 0, specs: props.modelValue.specs }); }
function clearAll() { update({ specs_id: 0, specs: [] }); }
async function reload() {
  if (invalid.value || !session.isCurrent() || loading.value) return;
  const token = ++generation, controller = new AbortController(); request = controller;
  catalog.value = []; loaded.value = false; failed.value = false; loading.value = true;
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try { const value = await getSupplierProductParameterCatalog(Number(auth.user?.supplier_id ?? (previewMode ? 1 : 0)), controller.signal); if (current()) { catalog.value = value; loaded.value = true; } }
  catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '参数模板读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); catalog.value = []; loaded.value = false; failed.value = false; void reload(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void reload()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="parameter-editor">
    <label class="parameter-template-label">参数模板</label>
    <div class="parameter-template-actions">
      <el-select :model-value="modelValue.specs_id || undefined" aria-label="参数模板" filterable clearable placeholder="不使用模板，可手动填写" :disabled="!canEdit || loading || failed || !loaded" @update:model-value="selectTemplate">
        <el-option v-if="modelValue.specs_id && !available" :value="modelValue.specs_id" :label="`历史模板 #${modelValue.specs_id}（暂不可选）`" disabled />
        <el-option v-for="item in catalog" :key="item.id" :value="item.id" :label="item.name" />
      </el-select>
      <el-button text :disabled="invalid || loading" @click="reload">刷新参数模板</el-button>
      <el-button v-if="modelValue.specs_id" text :disabled="!canEdit" @click="clearTemplate">清除模板选择</el-button>
    </div>
    <p class="parameter-hint">选择模板会填入初始参数，可继续修改名称、值和排序。清除模板选择会保留已填参数。</p>
    <div v-for="(row, index) in modelValue.specs" :key="index" class="parameter-row" role="group" :aria-label="`商品参数 ${index + 1}`">
      <label>参数名称<el-input :model-value="row.name" :aria-label="`参数名称 ${index + 1}`" :maxlength="510" :disabled="!canEdit" @update:model-value="updateRow(index, 'name', $event)" /></label>
      <label>参数值<el-input :model-value="row.value" :aria-label="`参数值 ${index + 1}`" :maxlength="510" :disabled="!canEdit" @update:model-value="updateRow(index, 'value', $event)" /></label>
      <label>排序<el-input-number :model-value="row.sort" :aria-label="`参数排序 ${index + 1}`" :precision="0" :min="-2147483648" :max="2147483647" :disabled="!canEdit" @update:model-value="updateRow(index, 'sort', $event)" /></label>
      <el-button :aria-label="`删除参数 ${index + 1}`" :disabled="!canEdit || index === 0" @click="removeRow(index)">删除</el-button>
    </div>
    <p v-if="!modelValue.specs.length">尚未填写商品参数。</p>
    <div class="parameter-actions"><el-button :disabled="!canEdit || modelValue.specs.length >= 100" @click="addRow">添加参数</el-button><el-button v-if="modelValue.specs_id || modelValue.specs.length || historical" :disabled="!canEdit" @click="clearAll">清空全部参数</el-button><span>{{ modelValue.specs.length }} / 100 项</span></div>
    <p v-if="historical" role="status">原参数模板 #{{ selection?.specs_id }} 或快照暂不可用{{ selection?.truncated ? '，原快照已截断' : '' }}。未修改时保留原值；可选择模板、清除模板后调整或清空全部参数。</p>
    <p v-if="failed" role="alert">参数模板目录读取失败，可刷新后再选择。已有参数可继续查看；未修改时保留原值。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.parameter-editor, .parameter-row, .parameter-row label { min-width: 0; }
.parameter-editor { container-type: inline-size; }
.parameter-template-label, .parameter-row label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; }
.parameter-template-actions, .parameter-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.parameter-template-actions :deep(.el-select) { width: min(100%, 340px); }
.parameter-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(150px, 2fr) 135px 64px; gap: 10px; align-items: end; padding: 14px 0; border-bottom: 1px solid var(--line); }
.parameter-row :deep(.el-input-number) { width: 100%; }
.parameter-editor p, .parameter-actions span { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.parameter-actions { margin-top: 16px; }
@container (max-width: 580px) { .parameter-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .parameter-row label:nth-child(2) { grid-column: 1 / -1; } .parameter-row label:nth-child(3) { grid-column: 1; } .parameter-row > .el-button { justify-self: end; } }
@media (max-width: 760px) { .parameter-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .parameter-row label:nth-child(2) { grid-column: 1 / -1; } .parameter-row label:nth-child(3) { grid-column: 1; } .parameter-row > .el-button { justify-self: end; } }
</style>
