<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getSupplierProductCouponCatalog } from '@/api/productCoupons';
import { previewMode } from '@/api/supplier';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import type { SupplierCouponEntry, SupplierCouponOption, SupplierCouponSelection } from '@/utils/productCoupons';
import { productCouponIds } from '@/utils/productCoupons';
const props = defineProps<{ modelValue: number[]; selection: SupplierCouponSelection | null; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number[]] }>();
const auth = useAuthStore(), rows = ref<SupplierCouponOption[]>([]), keyword = ref(''), page = ref(1), count = ref(0), loading = ref(false), loaded = ref(false), failed = ref(false), invalid = ref(false);
const remembered = ref<SupplierCouponEntry[]>([]);
let generation = 0, request: AbortController | undefined;
function cancel() { generation++; request?.abort(); loading.value = false; }
function invalidate() { cancel(); invalid.value = true; rows.value = []; remembered.value = []; loaded.value = false; }
const session = createSupplierSessionScope(invalidate, previewMode);
const canEdit = computed(() => !props.disabled && !invalid.value && session.isCurrent() && (previewMode || auth.can('supplier.product.manage')));
const selectedEntries = computed(() => props.modelValue.map(id => [...rows.value.map(row => ({ id: row.id, title: row.title, available: true })), ...remembered.value, ...(props.selection?.entries ?? [])].find(x => x.id === id) ?? { id, title: `历史发行实例 #${id}`, available: false }));
function choose(id: number, checked: boolean) {
  if (!canEdit.value || loading.value || !loaded.value || failed.value) return;
  try {
    const row = rows.value.find(x => x.id === id);
    if (checked && row) remembered.value = [...remembered.value.filter(x => x.id !== id), { id, title: row.title, available: true }];
    emit('update:modelValue', productCouponIds(checked ? [...props.modelValue, id] : props.modelValue.filter(value => value !== id))); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '赠券选择无效'); }
}
function remove(id: number) { if (canEdit.value) emit('update:modelValue', props.modelValue.filter(value => value !== id)); }
async function load(target = 1) {
  if (invalid.value || !session.isCurrent()) return;
  cancel(); const token = ++generation, controller = new AbortController(); request = controller;
  loading.value = true; loaded.value = false; failed.value = false; rows.value = [];
  const current = () => token === generation && !invalid.value && session.isCurrent();
  try {
    const data = await getSupplierProductCouponCatalog(target, keyword.value.trim(), controller.signal);
    if (current()) { rows.value = data.list; page.value = data.page; count.value = data.count; loaded.value = true;
      remembered.value = [...remembered.value.filter(x => !data.list.some(row => row.id === x.id)), ...data.list.map(row => ({ id: row.id, title: row.title, available: true }))].filter(x => props.modelValue.includes(x.id)); }
  } catch (error) { if (current()) { failed.value = true; ElMessage.error(error instanceof Error ? error.message : '赠券目录读取失败'); } }
  finally { if (current()) loading.value = false; }
}
watch(() => props.context, () => { cancel(); remembered.value = []; keyword.value = ''; page.value = 1; void load(); }, { flush: 'sync' });
watch(() => `${auth.user?.id ?? 0}:${auth.user?.supplier_id ?? 0}:${auth.can('supplier.product.view')}:${auth.can('supplier.product.manage')}`, () => { if (!previewMode) invalidate(); }, { flush: 'sync' });
onMounted(() => void load()); onBeforeUnmount(() => { cancel(); session.dispose(); });
</script>
<template>
  <div class="coupon-picker">
    <div class="coupon-search"><el-input v-model="keyword" aria-label="搜索赠券发行实例" placeholder="搜索标题或发行实例编号" :maxlength="128" :disabled="invalid" @keyup.enter="load()" /><el-button :disabled="invalid || loading" @click="load()">搜索赠券</el-button></div>
    <div v-if="modelValue.length" class="coupon-selected" aria-label="已选赠券"><el-tag v-for="item in selectedEntries" :key="item.id" :closable="canEdit" @close="remove(item.id)">{{ item.title }} #{{ item.id }}{{ item.available ? '' : '（已删除或缺失）' }}</el-tag></div>
    <div class="coupon-options" role="group" aria-label="赠券发行实例">
      <el-checkbox v-for="row in rows" :key="row.id" :model-value="modelValue.includes(row.id)" :disabled="!canEdit || loading || failed" @change="choose(row.id, !!$event)">{{ row.title }} #{{ row.id }} · {{ row.discount_type === 2 ? `${row.coupon_price}%` : `${row.coupon_price}元` }}{{ row.status === 1 ? '' : '（当前停用）' }}</el-checkbox>
    </div>
    <p v-if="loaded && !rows.length">没有匹配的赠券发行实例。</p>
    <div class="coupon-actions"><el-button text :disabled="invalid || loading" @click="load(page)">刷新赠券</el-button><el-button v-if="modelValue.length || selection && (!selection.consistent || selection.truncated)" text :disabled="!canEdit" @click="emit('update:modelValue', [])">清空赠券选择</el-button></div>
    <div v-if="loaded && count > 20" class="coupon-pages"><el-button :disabled="loading || page <= 1" @click="load(page - 1)">上一页赠券</el-button><span>{{ page }} / {{ Math.ceil(count / 20) }}</span><el-button :disabled="loading || page * 20 >= count" @click="load(page + 1)">下一页赠券</el-button></div>
    <p v-if="selection && (!selection.consistent || selection.truncated || selection.entries.some(x => !x.available))" role="status">原赠券包含缺失、重复或过多关联。未修改时保留原绑定；修改时请移除失效项或清空后重新选择。</p>
    <p v-if="failed" role="alert">赠券目录读取失败，可刷新后再选择；未修改时保留原绑定。</p>
    <p v-if="invalid" role="alert">登录身份或权限已改变，请重新进入商品页。</p>
  </div>
</template>
<style scoped>
.coupon-picker { width: 100%; min-width: 0; }
.coupon-search,.coupon-actions,.coupon-pages,.coupon-selected { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.coupon-search .el-input { flex: 1; min-width: 130px; }
.coupon-options { display: flex; flex-direction: column; align-items: flex-start; max-height: 280px; overflow-y: auto; }
.coupon-options :deep(.el-checkbox) { height: auto; min-height: 34px; max-width: 100%; margin: 0; }
.coupon-options :deep(.el-checkbox__label),.coupon-selected :deep(.el-tag__content) { white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.coupon-selected .el-tag { height: auto; max-width: 100%; padding-block: 4px; }
.coupon-picker p { color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
