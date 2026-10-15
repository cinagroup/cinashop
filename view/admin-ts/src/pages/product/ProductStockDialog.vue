<template>
  <el-dialog :model-value="modelValue" title="库存管理" width="min(960px, 96vw)" :before-close="beforeClose"
    :close-on-click-modal="!busy" :close-on-press-escape="!busy" @update:model-value="visibleChange">
    <p class="product-name">{{ productName }}（#{{ productId }}）</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="uncertain" title="上次调整结果尚未确认。请读取当前库存并人工核对，不能重复发送原调整。" type="warning" :closable="false" class="notice" />
    <el-alert v-if="rows.some(row => row.is_retired)" title="退役规格保留历史库存，仅可查看；本次提交保留其零调整。" type="info" :closable="false" class="notice" />
    <div v-if="specType && rows.length" class="batch">
      <el-select v-model="batchPm" aria-label="批量库存方向" :disabled="disabled"><el-option label="入库" :value="1" /><el-option label="出库" :value="0" /></el-select>
      <el-input-number :key="`batch:${disabled}`" v-model="batchQuantity" aria-label="批量库存数量" :min="0" :max="max" :precision="0" :disabled="disabled" />
      <el-button :disabled="disabled" @click="applyBatch">应用到全部可调整规格</el-button>
    </div>
    <div class="stock-scroll"><el-table :data="rows" border v-loading="loading">
      <el-table-column label="图片" width="70"><template #default="{ row }"><el-image v-if="row.image" :src="row.image" class="thumb" fit="cover" /></template></el-table-column>
      <el-table-column label="产品规格" min-width="145"><template #default="{ row }">{{ row.suk || '默认规格' }} <el-tag v-if="row.is_retired" type="info">退役</el-tag></template></el-table-column>
      <el-table-column prop="bar_code" label="商品条形码" min-width="120" />
      <el-table-column prop="code" label="商品编码" min-width="110" />
      <el-table-column prop="stock" label="当前库存" width="90" />
      <el-table-column label="入／出库数量" min-width="290"><template #default="{ row }"><div class="adjustment">
        <el-select v-model="row.pm" :aria-label="`库存方向 ${row.id}`" :disabled="disabled || !!row.is_retired"><el-option label="入库" :value="1" /><el-option label="出库" :value="0" /></el-select>
        <el-input-number :key="`${row.id}:${disabled || !!row.is_retired}`" v-model="row.quantity" :aria-label="`库存数量 ${row.id}`" :min="0" :max="max" :precision="0" :disabled="disabled || !!row.is_retired" />
        <span>= {{ resultStock(row) }}</span>
      </div></template></el-table-column>
    </el-table></div>
    <el-empty v-if="!loading && !rows.length && !error" description="暂无普通规格" />
    <template #footer>
      <el-button :disabled="busy" @click="close">取消库存调整</el-button>
      <el-button :disabled="busy || !canView" @click="load">重新读取库存</el-button>
      <el-button v-if="uncertain" :disabled="busy || loading || !freshRead || isStockWritePending(productId)" @click="acknowledge">已核对，开始新的调整</el-button>
      <el-button type="primary" :loading="busy" :disabled="disabled || !rows.length" @click="save">提交库存调整</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiAdminProductStockAttrs, apiAdminProductSaveStocks, acknowledgeStockRead, hasUnconfirmedStock, isStockWritePending,
  type AdminProductStockRow } from '@/api/productStock';

const props = defineProps<{ modelValue: boolean; productId: number; productName: string; specType: number; canView: boolean; canManage: boolean; contextKey: string }>();
const emit = defineEmits<{ 'update:modelValue': [visible: boolean]; saved: [stock: number] }>();
const max = 2_147_483_647;
type Row = AdminProductStockRow & { pm: 0 | 1; quantity: number | undefined };
const rows = ref<Row[]>([]), loading = ref(false), busy = ref(false), error = ref(''), uncertain = ref(false), freshRead = ref(false);
const batchPm = ref<0 | 1>(1), batchQuantity = ref<number | undefined>(0);
const disabled = computed(() => !props.canManage || !props.canView || !freshRead.value || loading.value || busy.value || uncertain.value);
let alive = true, epoch = 0, request = 0, abort: AbortController | null = null;
type Stamp = { epoch: number; product: number; context: string; token: string | null; session: string | null };
const stamp = (): Stamp => ({ epoch, product: props.productId, context: props.contextKey, token: getToken(), session: localStorage.getItem('admin_session') });
const current = (scope: Stamp): boolean => alive && props.modelValue && props.canView && scope.epoch === epoch && scope.product === props.productId && scope.context === props.contextKey && !!scope.token && scope.token === getToken() && scope.session === localStorage.getItem('admin_session');
const message = (value: unknown): string => value instanceof Error ? value.message : '库存请求失败';
function reset(): void { epoch++; request++; abort?.abort(); abort = null; rows.value = []; loading.value = busy.value = freshRead.value = false; error.value = ''; batchPm.value = 1; batchQuantity.value = 0; uncertain.value = false; }
function close(): void { if (busy.value) return; reset(); emit('update:modelValue', false); }
function beforeClose(done: () => void): void { if (!busy.value) { close(); done(); } }
function visibleChange(value: boolean): void { if (!value) close(); }
function quantity(value: number | undefined): number { if (!Number.isInteger(value) || value === undefined || value < 0 || value > max) throw Error('入出库数量须为0至2147483647的整数'); return value; }
function resultStock(row: Row): number | string { try { return Math.max(0, row.stock + (row.pm === 1 ? 1 : -1) * quantity(row.quantity)); } catch { return '—'; } }
function applyBatch(): void { if (disabled.value) return; try { const value = quantity(batchQuantity.value); for (const row of rows.value) if (!row.is_retired) { row.pm = batchPm.value; row.quantity = value; } error.value = ''; } catch (reason) { error.value = message(reason); } }
async function load(): Promise<void> {
  if (!current(stamp()) || busy.value) return;
  abort?.abort(); const controller = new AbortController(), scope = stamp(), turn = ++request; abort = controller;
  loading.value = true; error.value = ''; freshRead.value = false; rows.value = [];
  try {
    const result = await apiAdminProductStockAttrs(scope.product, controller.signal);
    if (!current(scope) || turn !== request) return;
    rows.value = result.map(row => ({ ...row, pm: 1, quantity: 0 })); freshRead.value = !isStockWritePending(scope.product);
    if (!freshRead.value) error.value = '库存请求尚未结束，请等待结果后重新读取库存';
    uncertain.value = hasUnconfirmedStock(scope.product);
  } catch (reason) { if (current(scope) && turn === request) error.value = message(reason); }
  finally { if (abort === controller) { abort = null; loading.value = false; } }
}
async function acknowledge(): Promise<void> {
  if (!current(stamp()) || busy.value || loading.value || !freshRead.value || !uncertain.value) return;
  const scope = stamp();
  try { await acknowledgeStockRead(scope.product); if (current(scope)) { uncertain.value = false; error.value = ''; } } catch (reason) { if (current(scope)) error.value = message(reason); }
}
async function save(): Promise<void> {
  if (!current(stamp()) || disabled.value || !rows.value.length) return;
  let attrs: Array<{ unique: string; pm: 0 | 1; stock: number }>;
  try { attrs = rows.value.map(row => ({ unique: row.unique, pm: row.pm, stock: row.is_retired ? 0 : quantity(row.quantity) })); }
  catch (reason) { error.value = message(reason); return; }
  const scope = stamp(); busy.value = true; error.value = ''; freshRead.value = false;
  try {
    const result = await apiAdminProductSaveStocks(scope.product, attrs);
    if (!current(scope) || !props.canManage) return;
    busy.value = false; ElMessage.success('库存已调整'); close(); emit('saved', Number(result.stock));
  } catch (reason) {
    if (!current(scope)) return;
    const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status));
    error.value = `${rejected ? '库存调整未完成' : '库存调整结果未确认'}：${message(reason)}`;
    uncertain.value = hasUnconfirmedStock(scope.product);
    if (rejected) rows.value = [];
  } finally { if (current(scope)) busy.value = false; }
}
watch(() => [props.modelValue, props.productId, props.canView, props.canManage, props.contextKey] as const, (value, previous) => {
  if (!value[0] || !value[2]) { reset(); if (value[0]) emit('update:modelValue', false); return; }
  if (!previous || !previous[0]) { reset(); try { uncertain.value = hasUnconfirmedStock(props.productId); } catch (reason) { error.value = message(reason); uncertain.value = true; } void load(); return; }
  if (value[1] !== previous[1] || value[3] !== previous[3] || value[4] !== previous[4]) { reset(); emit('update:modelValue', false); }
}, { immediate: true });
function stockChanged(event: Event): void {
  const product = (event as CustomEvent<{ productId?: number }>).detail?.productId;
  if (current(stamp()) && !busy.value && (product === 0 || product === props.productId)) { freshRead.value = false; error.value = '库存数据已更新，请重新读取后调整'; }
}
onMounted(() => window.addEventListener('cinashop:product-stock-changed', stockChanged));
onBeforeUnmount(() => { alive = false; reset(); window.removeEventListener('cinashop:product-stock-changed', stockChanged); });
</script>

<style scoped>
.product-name { font-weight: 600; overflow-wrap: anywhere; }.notice { margin: 10px 0; }.batch { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0; }.batch :deep(.el-select) { width: 100px; }.stock-scroll { overflow-x: auto; margin-top: 14px; }.thumb { width: 42px; height: 42px; }.adjustment { display: flex; align-items: center; gap: 8px; }.adjustment :deep(.el-select) { width: 90px; }.adjustment :deep(.el-input-number) { width: 120px; }.adjustment span { white-space: nowrap; }
@media (max-width: 600px) { :deep(.el-dialog__footer) { display: flex; flex-wrap: wrap; gap: 8px; }:deep(.el-dialog__footer .el-button) { margin-left: 0; } }
</style>
