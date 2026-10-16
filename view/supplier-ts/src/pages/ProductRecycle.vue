<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { changeSupplierRecycledProduct, readSupplierProductHeader, readSupplierProducts, type RecycleProduct } from '@/api/productRecycle';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { formatMoney } from '@/utils/format';

const route = useRoute(), router = useRouter(), auth = useAuthStore();
const filters = reactive({ page: 1, limit: 20, store_name: '' });
const rows = ref<RecycleProduct[]>([]), total = ref(0), headerCount = ref(0);
const reading = ref(false), writing = ref(false), checking = ref(false), fresh = ref(false), invalidated = ref(false);
const error = ref(''), notice = ref('');
const pending = ref<{ id: number; operation: 'restore' | 'delete' } | null>(null);
const checkedUnchanged = ref(false);
let generation = 0, loadedKey = '', active = true;
const controller = new AbortController();
const session = createSupplierSessionScope(invalidate, previewMode);
function invalidate() {
  if (!active) return;
  active = false; generation++; invalidated.value = true; controller.abort();
  rows.value = []; total.value = 0; headerCount.value = 0; fresh.value = false;
  pending.value = null; checkedUnchanged.value = false; reading.value = writing.value = checking.value = false;
  error.value = '页面或登录权限已变化，请返回商品管理后重新打开。'; notice.value = '';
}
watch(() => route.fullPath, invalidate, { flush: 'sync' });
onBeforeUnmount(() => { invalidate(); session.dispose(); });
const key = () => JSON.stringify(filters);
const current = (version?: number) => active && session.isCurrent() && (version === undefined || version === generation);
const canView = computed(() => !invalidated.value && (previewMode || auth.can('supplier.product.view')));
const canManage = computed(() => canView.value && (previewMode || auth.can('supplier.product.manage')));
const busy = computed(() => reading.value || writing.value || checking.value);
const ready = computed(() => canManage.value && fresh.value && loadedKey === key() && !busy.value && !pending.value);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647;
function validPage(value: unknown, page: number, limit: number, deleted: 0 | 1 | undefined, id?: number) {
  const result = value as { list?: RecycleProduct[]; count?: number; page?: number; limit?: number } | null;
  if (!result || !Array.isArray(result.list) || !integer(result.count) || result.page !== page || result.limit !== limit
    || result.list.length > limit || result.list.length > result.count || new Set(result.list.map(row => row.id)).size !== result.list.length
    || result.list.some(row => !row || !integer(row.id) || row.id <= 0 || id !== undefined && row.id !== id || (deleted === undefined ? ![0, 1].includes(row.is_del) : row.is_del !== deleted)
      || typeof row.store_name !== 'string' || row.store_name.length > 256) || result.list.length !== Math.min(limit, Math.max(0, result.count - (page - 1) * limit))) throw Error('商品列表结果不完整，请刷新核对');
  return result as { list: RecycleProduct[]; count: number; page: number; limit: number };
}
async function load(): Promise<void> {
  if (!current() || !canView.value || writing.value || checking.value || pending.value) return;
  const version = ++generation, params = { ...filters, is_del: 1 }, requestKey = key();
  reading.value = true; fresh.value = false; error.value = '';
  try {
    const [data, header] = await Promise.all([readSupplierProducts(params, controller.signal), readSupplierProductHeader(params.store_name, controller.signal)]);
    if (!current(version) || requestKey !== key()) return;
    const page = validPage(data, params.page, params.limit, 1);
    const count = header?.list?.find(item => item.type === 6)?.count;
    if (!Array.isArray(header?.list) || header.list.filter(item => item.type === 6).length !== 1 || !integer(count)) throw Error('回收站计数结果不完整，请刷新核对');
    const last = Math.max(1, Math.ceil(page.count / params.limit));
    if (params.page > last) { filters.page = last; reading.value = false; return load(); }
    rows.value = page.list; total.value = page.count; headerCount.value = count!;
    loadedKey = requestKey; fresh.value = true;
  } catch (cause) { if (current(version)) { rows.value = []; total.value = 0; error.value = cause instanceof Error ? cause.message : '回收站读取失败'; } }
  finally { if (current(version)) reading.value = false; }
}
function search() { if (busy.value || pending.value) return; filters.page = 1; void load(); }
function changePage(page: number) {
  if (busy.value || pending.value || page === filters.page || !integer(page) || page <= 0) return;
  filters.page = page; void load();
}
async function change(row: RecycleProduct, operation: 'restore' | 'delete') {
  if (!current() || !ready.value || !rows.value.some(value => value.id === row.id && value.is_del === 1)) return;
  const version = generation, requestKey = key(), id = row.id, title = row.store_name;
  writing.value = true; error.value = ''; notice.value = ''; checkedUnchanged.value = false;
  let sent = false;
  try {
    await ElMessageBox.confirm(operation === 'restore'
      ? `恢复“${title}”？恢复不会额外改变审核或上下架状态，请回商品管理核对后再运营。`
      : `彻底删除“${title}”（ID ${id}）？商品、规格及关联内容将被清除，无法恢复。历史订单、支付和已交付记录保留。`,
    operation === 'restore' ? '恢复商品' : '彻底删除商品', { type: 'warning', confirmButtonText: operation === 'restore' ? '确认恢复' : '确认彻底删除' });
    if (!current(version) || !canManage.value || requestKey !== key() || loadedKey !== requestKey) return;
    pending.value = { id, operation }; sent = true; fresh.value = false;
    const receipt = await changeSupplierRecycledProduct(id, operation, controller.signal);
    if (!current(version)) return;
    if (receipt?.id !== id || receipt.operation !== operation || operation === 'restore' && receipt.is_del !== 0) throw Error('操作回执不完整');
    pending.value = null; notice.value = operation === 'restore' ? '商品已恢复，请在商品管理核对状态。' : '商品已彻底删除。';
    ElMessage.success(notice.value); writing.value = false; await load();
  } catch (cause) {
    if (current(version) && cause !== 'cancel' && cause !== 'close') {
      error.value = sent ? '操作结果未确认，请先核对原商品状态。' : cause instanceof Error ? cause.message : '操作未完成';
    }
  } finally { if (current(version)) writing.value = false; }
}
async function recover() {
  if (!current() || !canView.value || busy.value || !pending.value) return;
  const version = generation, original = { ...pending.value }; checking.value = true; checkedUnchanged.value = false;
  try {
    const result = await readSupplierProducts({ id: original.id, is_del: 'all', page: 1, limit: 1 }, controller.signal);
    if (!current(version)) return;
    const present = validPage(result, 1, 1, undefined, original.id);
    if (present.count > 1) throw Error('原商品状态不一致，请稍后核对');
    const matched = original.operation === 'restore' ? present.list[0]?.is_del === 0 : present.count === 0;
    if (!matched) { checkedUnchanged.value = true; error.value = '已读取原商品，当前状态尚未达到预期。可稍后再核对，或按当前状态重新选择。'; return; }
    pending.value = null; error.value = '';
    notice.value = original.operation === 'restore' ? '原商品当前已恢复。' : '原商品已不在当前供应商列表中，未再次发送删除。';
    checking.value = false; await load();
  } catch (cause) { if (current(version)) error.value = cause instanceof Error ? cause.message : '原结果核对失败，请稍后重试'; }
  finally { if (current(version)) checking.value = false; }
}
function useCurrentState() {
  if (!current() || !checkedUnchanged.value || busy.value) return;
  pending.value = null; checkedUnchanged.value = false; fresh.value = false; notice.value = '请按刷新后的商品重新确认操作。'; void load();
}
onMounted(load);
</script>

<template>
  <section class="page-section recycle-page">
    <header class="page-heading"><div><h1>商品回收站</h1><p>查看当前供应商回收的商品，恢复或彻底删除</p></div><el-button @click="router.push('/products')">返回商品管理</el-button></header>
    <el-alert v-if="previewMode" title="当前为预览模式，仅操作示例商品" type="info" :closable="false" />
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div v-if="pending" class="recovery-bar"><span>待核对商品 ID {{ pending.id }} · {{ pending.operation === 'restore' ? '恢复' : '彻底删除' }}</span><el-button :loading="checking" :disabled="busy" @click="recover">核对原结果</el-button><el-button v-if="checkedUnchanged" :disabled="busy" @click="useCurrentState">按当前状态重新选择</el-button></div>
    <div class="surface list-surface">
      <div class="filter-row"><el-input v-model="filters.store_name" :disabled="busy || Boolean(pending)" clearable placeholder="搜索回收商品" @keyup.enter="search" /><el-button type="primary" :disabled="busy || Boolean(pending)" @click="search">查询</el-button><el-button :loading="reading" :disabled="busy || Boolean(pending) || invalidated" @click="load">刷新回收站</el-button><span>回收站 {{ headerCount }} 件</span></div>
      <el-table v-loading="reading" :data="rows" row-key="id">
        <el-table-column label="商品" min-width="240"><template #default="scope"><strong>{{ scope.row.store_name || '未命名商品' }}</strong><div class="secondary-text">ID {{ scope.row.id }}</div></template></el-table-column>
        <el-table-column label="价格" width="110"><template #default="scope">{{ formatMoney(scope.row.price) }}</template></el-table-column>
        <el-table-column prop="stock" label="库存" width="90" />
        <el-table-column label="操作" min-width="220"><template #default="scope"><template v-if="canManage"><el-button link type="primary" :disabled="!ready" @click="change(scope.row, 'restore')">恢复</el-button><el-button link type="danger" :disabled="!ready" @click="change(scope.row, 'delete')">彻底删除</el-button></template><span v-else>只读</span></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 件</span><el-pagination :current-page="filters.page" :page-size="filters.limit" :total="total" :disabled="busy || Boolean(pending)" layout="prev, pager, next" @current-change="changePage" /></div>
    </div>
  </section>
</template>

<style scoped>
.recycle-page { display: grid; gap: 16px; }
.filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.filter-row :deep(.el-input) { max-width: 300px; }
.secondary-text { color: var(--el-text-color-secondary); margin-top: 4px; font-size: 12px; }
.recovery-bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
@media (max-width: 640px) { .page-heading { align-items: flex-start; gap: 12px; flex-direction: column; } .list-surface { overflow-x: auto; } }
</style>
