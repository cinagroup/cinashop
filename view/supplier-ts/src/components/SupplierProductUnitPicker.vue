<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductUnits } from '@/api/productUnits';
import { previewMode } from '@/api/supplier';
import { supplierProductUnitNames, type SupplierProductUnit } from '@/utils/productUnits';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ modelValue: string; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const auth = useAuthStore(), catalog = ref<SupplierProductUnit[]>([]);
const loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; catalog.value = []; loaded.value = false; failed.value = false; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const names = computed(() => supplierProductUnitNames(catalog.value));
const hasLongNames = computed(() => names.value.some(name => name.length > 32));
const selected = computed(() => names.value.includes(props.modelValue) ? props.modelValue : '');
function edit(value: unknown) {
  if (!canEdit.value) return;
  if (typeof value !== 'string' || value.length > 32) { ElMessage.warning('单位不能超过32个字符'); return; }
  emit('update:modelValue', value);
}
function choose(value: unknown) {
  if (!canEdit.value || loading.value || failed.value || !loaded.value) return;
  if (typeof value !== 'string' || value.length > 32 || value !== '' && !names.value.includes(value)) { ElMessage.warning('请选择32个字符以内的目录单位'); return; }
  edit(value);
}
async function reload() {
  if (invalid.value || !session.isCurrent() || loading.value) return;
  const token = ++generation, controller = new AbortController(); request = controller;
  catalog.value = []; loaded.value = false; failed.value = false; loading.value = true;
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try { const rows = await getSupplierProductUnits(controller.signal); if (current()) { catalog.value = rows; loaded.value = true; } }
  catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '单位目录读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); catalog.value = []; loaded.value = false; failed.value = false; void reload(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void reload());
onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="unit-picker">
    <el-input :model-value="modelValue" maxlength="32" :disabled="!canEdit" aria-label="计量单位" placeholder="例如：件、箱" @update:model-value="edit" />
    <div class="unit-directory">
      <el-select :model-value="selected" filterable clearable fit-input-width :loading="loading" :disabled="!canEdit || loading || failed || !loaded" aria-label="计量单位目录" placeholder="从目录选择单位" @update:model-value="choose">
        <el-option v-for="name in names" :key="name" :label="name" :value="name" :disabled="name.length > 32" />
      </el-select>
      <el-button text :disabled="invalid || loading" @click="reload">刷新单位目录</el-button>
    </div>
    <p v-if="failed" role="alert">单位目录读取失败，仍可填写或保存当前单位。</p>
    <p v-else-if="loaded && !names.length" role="status">暂无可选单位，可直接填写。</p>
    <p v-if="hasLongNames" role="status">部分目录单位名称超过32个字符，请选择其他单位或填写较短名称。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.unit-picker { width: 100%; min-width: 0; }
.unit-directory { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 6px; }
.unit-directory > .el-select { flex: 1 1 150px; min-width: 0; }
.unit-picker p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
