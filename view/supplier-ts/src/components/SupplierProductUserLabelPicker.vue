<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductUserLabelCatalog } from '@/api/productUserLabels';
import { previewMode } from '@/api/supplier';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import type { SupplierUserLabelEntry, SupplierUserLabelOption, SupplierUserLabelSelection } from '@/utils/productUserLabels';
import { productUserLabelIds } from '@/utils/productUserLabels';
const props = defineProps<{ modelValue: number[]; selection: SupplierUserLabelSelection | null; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number[]] }>();
const auth = useAuthStore(), rows = ref<SupplierUserLabelOption[]>([]), keyword = ref(''), page = ref(1), count = ref(0), loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
const runtimeConfigured = ref<boolean | null>(null);
const remembered = ref<SupplierUserLabelEntry[]>([]);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; rows.value = []; remembered.value = []; loaded.value = false; runtimeConfigured.value = null; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const selectedEntries = computed(() => props.modelValue.map(id => [...rows.value.map(row => ({ id: row.id, title: row.title, available: true })), ...remembered.value, ...(props.selection?.entries ?? [])].find(x => x.id === id) ?? { id, title: '历史用户标签', available: false }));
function choose(id: number, checked: boolean) {
  if (!canEdit.value || loading.value || !loaded.value || failed.value) return;
  try {
    const row = rows.value.find(x => x.id === id);
    if (checked && row) remembered.value = [...remembered.value.filter(x => x.id !== id), { id, title: row.title, available: true }];
    emit('update:modelValue', productUserLabelIds(checked ? [...props.modelValue, id] : props.modelValue.filter(value => value !== id))); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '用户标签选择无效'); }
}
function remove(id: number) { if (canEdit.value) emit('update:modelValue', props.modelValue.filter(value => value !== id)); }
async function load(target = 1) {
  if (invalid.value || !session.isCurrent()) return;
  cancel(); const token = ++generation, controller = new AbortController(); request = controller;
  loading.value = true; loaded.value = false; failed.value = false; rows.value = [];
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try {
    const data = await getSupplierProductUserLabelCatalog(target, keyword.value.trim(), controller.signal);
    if (current()) { runtimeConfigured.value = data.runtime_configured; rows.value = data.list; page.value = data.page; count.value = data.count; loaded.value = true;
      remembered.value = [...remembered.value.filter(x => !data.list.some(row => row.id === x.id)), ...data.list.map(row => ({ id: row.id, title: row.title, available: true }))].filter(x => props.modelValue.includes(x.id)); }
  } catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '用户标签目录读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); remembered.value = []; keyword.value = ''; page.value = 1; runtimeConfigured.value = null; void load(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void load()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="user-label-picker">
    <div class="user-label-search"><el-input v-model="keyword" aria-label="搜索购买用户标签" placeholder="搜索标题或用户标签编号" :maxlength="128" :disabled="invalid" @keyup.enter="load()" /><el-button :disabled="invalid || loading" @click="load()">搜索用户标签</el-button></div>
    <div v-if="modelValue.length" class="user-label-selected" aria-label="已选用户标签"><el-tag v-for="item in selectedEntries" :key="item.id" :closable="canEdit" @close="remove(item.id)">{{ item.title }} #{{ item.id }}{{ item.available ? '' : '（不可重新绑定）' }}</el-tag></div>
    <div class="user-label-options" role="group" aria-label="购买用户标签">
      <el-checkbox v-for="row in rows" :key="row.id" :model-value="modelValue.includes(row.id)" :disabled="!canEdit || loading || failed" @change="choose(row.id, !!$event)">{{ row.title }} #{{ row.id }}</el-checkbox>
    </div>
    <p v-if="loaded && !rows.length">没有匹配的购买用户标签。</p>
    <div class="user-label-actions"><el-button text :disabled="invalid || loading" @click="load(page)">刷新用户标签</el-button><el-button v-if="modelValue.length || selection && (!selection.consistent || selection.truncated)" text :disabled="!canEdit" @click="emit('update:modelValue', [])">清空用户标签选择</el-button></div>
    <div v-if="loaded && count > 20" class="user-label-pages"><el-button :disabled="loading || page <= 1" @click="load(page - 1)">上一页用户标签</el-button><span>{{ page }} / {{ Math.ceil(count / 20) }}</span><el-button :disabled="loading || page * 20 >= count" @click="load(page + 1)">下一页用户标签</el-button></div>
    <p v-if="selection && (!selection.consistent || selection.truncated || selection.entries.some(x => !x.available))" role="status">原用户标签包含停用、外部归属、缺失或异常关联。未修改时保留原绑定；修改时请移除失效项或清空后重新选择。</p>
    <p role="status" v-if="runtimeConfigured === false">购买标签任务尚未启用；当前仅保存配置，不会自动给用户打标签。</p>
    <p role="status" v-else-if="runtimeConfigured === true">购买标签任务已配置；付款后按任务执行时的当前绑定添加，最终结果以任务回执为准。</p>
    <p role="status" v-else>购买标签任务状态尚未读取；保存配置不会启用任务。</p>
    <p v-if="failed" role="alert">用户标签目录读取失败，可刷新后再选择；未修改时保留原绑定。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.user-label-picker { width: 100%; min-width: 0; }
.user-label-search,.user-label-actions,.user-label-pages,.user-label-selected { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.user-label-search .el-input { flex: 1; min-width: 130px; }
.user-label-options { display: flex; flex-direction: column; align-items: flex-start; max-height: 280px; overflow-y: auto; }
.user-label-options :deep(.el-checkbox) { height: auto; min-height: 34px; max-width: 100%; margin: 0; }
.user-label-options :deep(.el-checkbox__label),.user-label-selected :deep(.el-tag__content) { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.user-label-selected .el-tag { height: auto; max-width: 100%; padding-block: 4px; }
.user-label-picker p { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
