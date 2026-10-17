<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductEnsureCatalog } from '@/api/productEnsures';
import { previewMode } from '@/api/supplier';
import type { SupplierProductEnsureAvailability, SupplierProductEnsureOption, SupplierProductEnsureSelection } from '@/types/productEnsures';
import { productEnsureAvailable, productEnsureIds } from '@/utils/productEnsures';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';
const props = defineProps<{ modelValue: number[]; selection: SupplierProductEnsureSelection | null; changed: boolean; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number[]]; availability: [SupplierProductEnsureAvailability] }>();
const auth = useAuthStore(), catalog = ref<SupplierProductEnsureOption[]>([]), query = ref(''), loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; catalog.value = []; loaded.value = false; failed.value = false; query.value = ''; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const retained = computed(() => props.selection?.retained_ids ?? []);
const valid = computed(() => productEnsureAvailable(catalog.value, props.modelValue, retained.value));
const unsupported = computed(() => loaded.value && !valid.value);
const originalUnavailable = computed(() => !props.changed && !!props.selection && (!props.selection.consistent || !props.selection.available));
const original = computed(() => props.selection ? `${props.selection.ensure_id ?? '无'}${props.selection.truncated ? '（已截断）' : ''}` : props.modelValue.join(','));
const options = computed(() => {
  const current = new Set(catalog.value.map(row => row.id));
  const rows = [...catalog.value, ...retained.value.filter(id => !current.has(id)).map(id => ({ id, name: `历史保障 #${id}（已停用，可保留或移除）` }))];
  const search = query.value.trim().toLocaleLowerCase(); return search ? rows.filter(row => row.name.toLocaleLowerCase().includes(search) || String(row.id).includes(search)) : rows;
});
watch(() => ({ ready: loaded.value && !loading.value && !failed.value && !invalid.value, valid: valid.value }), value => emit('availability', value), { immediate: true });
const selected = computed({ get: () => [...props.modelValue], set: (raw: unknown) => {
  if (!canEdit.value || loading.value || failed.value || !loaded.value || unsupported.value) return;
  try { const ids = productEnsureIds(raw); if (!productEnsureAvailable(catalog.value, ids, retained.value)) throw Error('保障目录已改变，请重新读取'); emit('update:modelValue', ids); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '服务保障选择无效'); }
} });
function clear() { if (canEdit.value) emit('update:modelValue', []); }
async function reload() {
  if (invalid.value || !session.isCurrent() || loading.value) return;
  const token = ++generation, controller = new AbortController(); request = controller;
  catalog.value = []; loaded.value = false; failed.value = false; loading.value = true;
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try { const rows = await getSupplierProductEnsureCatalog(Number(auth.user?.supplier_id ?? (previewMode ? 1 : 0)), controller.signal); if (current()) { catalog.value = rows; loaded.value = true; } }
  catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '服务保障读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); catalog.value = []; loaded.value = false; failed.value = false; query.value = ''; void reload(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void reload()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="ensure-picker">
    <el-input v-if="catalog.length > 10" v-model="query" aria-label="筛选服务保障" placeholder="搜索保障名称或编号" clearable :disabled="invalid" />
    <el-checkbox-group v-model="selected" aria-label="服务保障" :disabled="!canEdit || loading || failed || !loaded || unsupported" class="ensure-options">
      <el-checkbox v-for="item in options" :key="item.id" :value="item.id">{{ item.name }}</el-checkbox>
    </el-checkbox-group>
    <p v-if="loaded && !catalog.length && !retained.length">当前没有可选的服务保障。</p>
    <div class="ensure-actions"><el-button text :disabled="invalid || loading" @click="reload">刷新保障</el-button><el-button v-if="modelValue.length || originalUnavailable" text :disabled="!canEdit" @click="clear">清空保障选择</el-button></div>
    <p v-if="originalUnavailable || unsupported" role="status">原保障 {{ original }} 含停用或暂不可选项目。已核对的停用项可保留或移除；其它项请清空后重新选择。未修改时保留原绑定。</p>
    <p v-if="failed" role="alert">服务保障目录读取失败，可刷新后再选择；未修改时保留原绑定。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.ensure-picker { width: 100%; min-width: 0; }
.ensure-options { display: flex; flex-direction: column; align-items: flex-start; max-height: 240px; overflow-y: auto; }
.ensure-options :deep(.el-checkbox) { height: auto; min-height: 32px; margin: 0; max-width: 100%; }
.ensure-options :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.ensure-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ensure-picker p { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
