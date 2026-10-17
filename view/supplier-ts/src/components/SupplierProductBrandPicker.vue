<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductBrandCatalog } from '@/api/productBrands';
import { previewMode } from '@/api/supplier';
import type { SupplierProductBrandAvailability, SupplierProductBrandNode, SupplierProductBrandSelection } from '@/types/productBrands';
import { productBrandAvailable, productBrandPath } from '@/utils/productBrands';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';
const props = defineProps<{ modelValue: number[]; selection: SupplierProductBrandSelection | null; changed: boolean; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number[]]; availability: [SupplierProductBrandAvailability] }>();
const auth = useAuthStore(), catalog = ref<SupplierProductBrandNode[]>([]), loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; catalog.value = []; loaded.value = false; failed.value = false; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const valid = computed(() => productBrandAvailable(catalog.value, props.modelValue));
const originalUnavailable = computed(() => !props.changed && !!props.selection && (!props.selection.consistent || !props.selection.available));
const unavailable = computed(() => originalUnavailable.value || loaded.value && !valid.value);
const original = computed(() => props.selection ? `#${props.selection.brand_id}${props.selection.brand_com ? `（${props.selection.brand_com}）` : ''}` : props.modelValue.join(' / '));
watch(() => ({ ready: loaded.value && !loading.value && !failed.value && !invalid.value, valid: valid.value }), value => emit('availability', value), { immediate: true });
const selected = computed({ get: () => [...props.modelValue], set: (raw: unknown) => {
  if (!canEdit.value || loading.value || failed.value || !loaded.value) return;
  try { const path = productBrandPath(raw); if (!productBrandAvailable(catalog.value, path)) throw Error('品牌目录已改变，请重新读取'); emit('update:modelValue', path); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '品牌选择无效'); }
} });
function clear() { if (canEdit.value) emit('update:modelValue', []); }
async function reload() {
  if (invalid.value || !session.isCurrent() || loading.value) return;
  const token = ++generation, controller = new AbortController(); request = controller;
  catalog.value = []; loaded.value = false; failed.value = false; loading.value = true;
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try { const rows = await getSupplierProductBrandCatalog(controller.signal); if (current()) { catalog.value = rows; loaded.value = true; } }
  catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '品牌读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); catalog.value = []; loaded.value = false; failed.value = false; void reload(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void reload()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="brand-picker">
    <el-cascader v-model="selected" :options="catalog" :props="{ checkStrictly: true, emitPath: true }" filterable clearable :disabled="!canEdit || loading || failed || !loaded" placeholder="请选择商品品牌" aria-label="商品品牌" />
    <div class="brand-actions"><el-button text :disabled="invalid || loading" @click="reload">刷新品牌</el-button><el-button v-if="modelValue.length || originalUnavailable" text :disabled="!canEdit" @click="clear">清空品牌选择</el-button></div>
    <p v-if="unavailable" role="status">原品牌 {{ original }} 暂不可选，可替换或清空；未修改时保留原绑定。</p>
    <p v-if="failed" role="alert">品牌目录读取失败，可刷新后再选择；未修改时保留原绑定。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.brand-picker, .brand-picker > .el-cascader { width: 100%; min-width: 0; }
.brand-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.brand-picker p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
