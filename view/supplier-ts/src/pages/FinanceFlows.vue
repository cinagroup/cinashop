<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { downloadLegacyExport } from '@/utils/legacy-export';
import { supplierBillDateRange, supplierBillMoney } from '@/api/supplierBills';
import { getSupplierFlows, getSupplierFlowMark, saveSupplierFlowMark, getSupplierFlowExport,
  type SupplierFlow, type SupplierFlowQuery, type SupplierFlows, type SupplierFlowMark } from '@/api/supplierFlows';

const props = defineProps<{ embedded?: boolean }>();
const auth = useAuthStore(), route = useRoute();
const type = ref<SupplierFlowQuery['type']>(''), keyword = ref(''), from = ref(''), to = ref('');
const result = ref<SupplierFlows | null>(null), loading = ref(false), error = ref(''), notice = ref('');
const active = ref(true), routeValid = ref(false), selected = ref<number[]>([]), exporting = ref(false);
const editingId = ref(0), mark = ref(''), markContext = ref<SupplierFlowMark | null>(null);
const markLoading = ref(false), saving = ref(false), unknown = ref(false), markError = ref('');
let alive = true, readGeneration = 0, editGeneration = 0, exportGeneration = 0;
let readController: AbortController | undefined, editController: AbortController | undefined, exportController: AbortController | undefined;
const canRead = computed(() => active.value && !!auth.token && !!auth.user?.id && !!auth.user.supplier_id && auth.can('supplier.finance.view'));
const canManage = computed(() => canRead.value && auth.can('supplier.finance.manage'));
const session = createSupplierSessionScope(invalidate);
const current = () => alive && session.isCurrent() && canRead.value && routeValid.value;
const message = (value: unknown) => value instanceof Error ? value.message : '操作失败，请重新读取流水';
function closeMark() {
  editGeneration++; editController?.abort(); editingId.value = 0; mark.value = ''; markContext.value = null;
  markLoading.value = false; saving.value = false; unknown.value = false; markError.value = '';
}
function cancelExport() { exportGeneration++; exportController?.abort(); exporting.value = false; selected.value = []; }
function clear() { readGeneration++; readController?.abort(); result.value = null; loading.value = false; error.value = ''; notice.value = ''; closeMark(); cancelExport(); }
function invalidate() { clear(); active.value = false; error.value = '登录会话或权限已改变，请重新打开资金流水'; }
watch([type, keyword, from, to], clear, { flush: 'sync' });
watch(canRead, value => { if (!value) invalidate(); }, { flush: 'sync' });
watch(canManage, value => { if (!value) { closeMark(); cancelExport(); } }, { flush: 'sync' });
onScopeDispose(() => { alive = false; clear(); session.dispose(); });
async function load(page = 1) {
  if (!current()) return;
  clear(); const generation = ++readGeneration; readController = new AbortController(); loading.value = true;
  try {
    const query: SupplierFlowQuery = { type: type.value, keyword: keyword.value.trim(), data: supplierBillDateRange(from.value, to.value), page, limit: 20 };
    const value = await getSupplierFlows(query, auth.user!.supplier_id, readController.signal);
    if (current() && generation === readGeneration) result.value = value;
  } catch (cause) { if (current() && generation === readGeneration) error.value = message(cause); }
  finally { if (generation === readGeneration) loading.value = false; }
}
function reset() { type.value = ''; keyword.value = ''; from.value = ''; to.value = ''; void load(); }
function toggle(row: SupplierFlow, checked: boolean) {
  if (!current() || !canManage.value || exporting.value || !result.value?.list.includes(row)) return;
  selected.value = checked ? [...new Set([...selected.value, row.id])] : selected.value.filter(id => id !== row.id);
}
async function download() {
  if (!current() || !canManage.value || exporting.value || !result.value || !selected.value.length) return;
  const rows = result.value.list.filter(row => selected.value.includes(row.id)), source = result.value;
  if (rows.length !== selected.value.length) return;
  const generation = ++exportGeneration; exportController = new AbortController(); exporting.value = true; error.value = ''; notice.value = '';
  try {
    const manifest = await getSupplierFlowExport(rows, exportController.signal);
    if (!current() || !canManage.value || generation !== exportGeneration || result.value !== source) return;
    downloadLegacyExport(manifest); notice.value = `已下载 ${rows.length} 条选中流水`;
  } catch (cause) { if (current() && generation === exportGeneration) error.value = message(cause); }
  finally { if (generation === exportGeneration) exporting.value = false; }
}
async function openMark(row: SupplierFlow) {
  if (!current() || !canManage.value || saving.value || !result.value?.list.includes(row)) return;
  closeMark(); editingId.value = row.id; await readMark();
}
async function readMark() {
  if (!current() || !canManage.value || !editingId.value || saving.value) return;
  const id = editingId.value, generation = ++editGeneration, desired = unknown.value ? mark.value.trim() : undefined;
  editController?.abort(); editController = new AbortController(); markLoading.value = true; markError.value = ''; markContext.value = null;
  try {
    const value = await getSupplierFlowMark(id, auth.user!.supplier_id, editController.signal);
    if (!current() || !canManage.value || generation !== editGeneration || editingId.value !== id) return;
    markContext.value = value; mark.value = value.mark; unknown.value = false;
    if (desired !== undefined) markError.value = value.mark === desired ? '当前备注已与提交内容一致，请核对；未重复提交' : '当前备注与提交内容不同，请核对后重新编辑；未自动重试';
  } catch (cause) { if (current() && generation === editGeneration) markError.value = message(cause); }
  finally { if (generation === editGeneration) markLoading.value = false; }
}
async function saveMark() {
  if (!current() || !canManage.value || !markContext.value || saving.value || unknown.value || markLoading.value) return;
  const value = mark.value.trim(); if (!value || [...value].length > 200) { markError.value = '请输入1至200字备注'; return; }
  const source = markContext.value, id = editingId.value, generation = editGeneration;
  saving.value = true; markError.value = ''; editController = new AbortController();
  try {
    const updated = await saveSupplierFlowMark(id, auth.user!.supplier_id, value, source.revision, editController.signal);
    if (!current() || !canManage.value || generation !== editGeneration || editingId.value !== id) return;
    markContext.value = updated; mark.value = updated.mark;
    closeMark(); const refresh = load(), refreshGeneration = readGeneration; await refresh;
    if (current() && readGeneration === refreshGeneration) notice.value = '流水备注已保存';
  } catch (cause) {
    if (current() && generation === editGeneration) { unknown.value = true; markContext.value = null; markError.value = `${message(cause)}。请先核对原流水备注，未自动重试`; }
  } finally { if (generation === editGeneration) saving.value = false; }
}
function readRoute() {
  routeValid.value = false; clear(); const q = route.query;
  if (Object.keys(q).some(key => !['type', 'keyword', 'from', 'to'].includes(key)) || Object.values(q).some(v => typeof v !== 'string') || q.type !== undefined && !['', '1', '2'].includes(String(q.type))) { error.value = '流水筛选参数无效，请从资金流水入口重新打开'; return; }
  type.value = (q.type ?? '') as SupplierFlowQuery['type']; keyword.value = String(q.keyword ?? ''); from.value = String(q.from ?? ''); to.value = String(q.to ?? '');
  routeValid.value = true; void load();
}
watch(() => route.fullPath, readRoute, { flush: 'sync' }); onMounted(readRoute);
</script>

<template>
  <section class="flow-page">
    <header v-if="!props.embedded" class="page-heading"><div><h1>资金流水</h1><p>按交易人、交易类型和创建日期查询当前供应商流水</p></div></header>
    <p class="flow-note">时间按北京时间显示，日期筛选使用交易创建时间。备注只用于描述流水，不改变金额或结算状态。</p>
    <p v-if="!canRead" role="alert">当前会话无法查看流水，请重新登录或核对权限。</p>
    <form class="surface flow-filters" @submit.prevent="load()">
      <label>交易类型<select v-model="type" :disabled="!canRead"><option value="">全部类型</option><option value="1">支付订单</option><option value="2">退款订单</option></select></label>
      <label>交易搜索<input v-model="keyword" maxlength="80" :disabled="!canRead" placeholder="交易单号、关联订单、交易人或UID" /></label>
      <label>开始日期<input v-model="from" type="date" :disabled="!canRead" /></label>
      <label>结束日期<input v-model="to" type="date" :disabled="!canRead" /></label>
      <el-button native-type="submit" type="primary" :disabled="!canRead || !routeValid" :loading="loading">查询流水</el-button>
      <el-button :disabled="!canRead || !routeValid" @click="reset">重置筛选</el-button>
    </form>
    <p v-if="error" class="flow-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <section class="surface flow-panel" aria-label="资金流水列表" :aria-busy="loading">
      <div class="flow-heading"><h2>资金流水</h2><el-button v-if="canManage" type="primary" :disabled="!selected.length || exporting" @click="download">下载本页所选流水</el-button></div>
      <p v-if="loading" role="status">正在读取资金流水…</p><p v-if="exporting" role="status">正在准备选中流水文件…</p>
      <template v-if="result">
        <div class="flow-scroll" role="region" aria-label="流水交易列表" tabindex="0"><table>
          <thead><tr><th v-if="canManage">选择</th><th>交易单号</th><th>关联订单</th><th>交易时间</th><th>金额</th><th>交易人</th><th>交易类型</th><th>支付方式</th><th>结算状态</th><th>备注</th><th v-if="canManage">操作</th></tr></thead>
          <tbody><tr v-for="row in result.list" :key="row.id"><td v-if="canManage"><input type="checkbox" :aria-label="`选择流水 ${row.order_id}`" :checked="selected.includes(row.id)" :disabled="exporting" @change="toggle(row, ($event.target as HTMLInputElement).checked)" /></td>
            <th scope="row">{{ row.order_id }}</th><td>{{ row.link_id || '—' }}</td><td>{{ row.trade_time || '—' }}</td><td>{{ supplierBillMoney(row.number, row.pm) }}</td><td>{{ row.user_nickname }}</td><td>{{ row.type_name }}</td><td>{{ row.pay_type_name }}</td><td>{{ row.status === 1 ? '已结算' : row.status === 0 ? '待结算' : '无效' }}</td><td class="flow-mark">{{ row.mark || '—' }}</td>
            <td v-if="canManage"><el-button link type="primary" :disabled="saving" :aria-label="`${row.order_id} 编辑备注`" @click="openMark(row)">编辑备注</el-button></td></tr></tbody>
        </table></div>
        <p v-if="!result.count">当前筛选没有流水。</p>
        <div class="flow-pagination"><span>共 {{ result.count }} 条流水 · 第 {{ result.page }} 页</span><div><el-button :disabled="result.page <= 1" @click="load(result.page - 1)">上一页流水</el-button><el-button :disabled="result.page * result.limit >= result.count" @click="load(result.page + 1)">下一页流水</el-button></div></div>
      </template>
    </section>
    <section v-if="editingId" class="surface flow-panel" aria-label="流水备注编辑" :aria-busy="saving || markLoading">
      <div class="flow-heading"><h2>编辑流水备注 · {{ editingId }}</h2><el-button :disabled="saving" @click="closeMark">关闭备注</el-button></div>
      <p v-if="markLoading" role="status">正在核对当前备注…</p>
      <label class="flow-editor">流水备注<textarea v-model="mark" maxlength="200" rows="3" :disabled="!markContext || saving || unknown" /></label>
      <p v-if="markError" class="flow-error" role="alert">{{ markError }}</p>
      <div class="flow-actions"><el-button :disabled="saving || markLoading" @click="readMark">核对当前备注</el-button><el-button type="primary" :disabled="!markContext || saving || unknown || markLoading" @click="saveMark">保存流水备注</el-button></div>
    </section>
  </section>
</template>

<style scoped>
.flow-page{display:grid;gap:16px;min-width:0}.flow-note{margin:0;color:var(--text-muted,#64748b);line-height:1.6}.flow-filters,.flow-panel{padding:20px;min-width:0}.flow-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}.flow-page label{display:grid;gap:8px;font-size:14px;max-width:100%}.flow-page input:not([type=checkbox]),.flow-page select,.flow-page textarea{min-height:36px;max-width:100%;padding:6px 10px;border:1px solid var(--border,#dcdfe6);border-radius:5px;background:#fff;color:inherit;font:inherit;box-sizing:border-box}.flow-page input:focus-visible,.flow-page select:focus-visible,.flow-page textarea:focus-visible{outline:2px solid var(--accent,#10b9ae);outline-offset:2px}.flow-heading,.flow-pagination{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.flow-heading h2{margin:0;font-size:18px}.flow-scroll{max-width:100%;overflow:auto;margin-top:16px;overscroll-behavior-x:contain}.flow-scroll table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}.flow-scroll th,.flow-scroll td{padding:14px 12px;text-align:left;border-bottom:1px solid var(--border,#ebeef5);font-weight:400}.flow-scroll thead th{font-weight:600;color:var(--text-muted,#64748b)}.flow-mark{min-width:140px;max-width:300px;white-space:normal;overflow-wrap:anywhere}.flow-error{color:#b42318;line-height:1.6;margin:0}.flow-pagination{margin-top:18px}.flow-pagination>div,.flow-actions{display:flex;gap:8px;flex-wrap:wrap}.flow-editor{margin:18px 0}.flow-editor textarea{width:100%;min-height:100px}.flow-actions{margin-top:16px}.flow-page :deep(.el-button+.el-button){margin-left:0}
@media(max-width:600px){.flow-filters,.flow-panel{padding:14px}.flow-filters label,.flow-filters input:not([type=checkbox]),.flow-filters select{width:100%}.flow-pagination{align-items:flex-start;flex-direction:column}.flow-note{font-size:13px}.flow-heading{align-items:flex-start}}
</style>
