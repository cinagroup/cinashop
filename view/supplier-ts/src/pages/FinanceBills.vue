<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { getSupplierBillGroups, getSupplierBillDetails, supplierBillDateRange, supplierBillMoney,
  type SupplierBillPeriod, type SupplierBillStatus, type SupplierBillQuery, type SupplierBillGroup,
  type SupplierBillGroups, type SupplierBillDetails } from '@/api/supplierBills';

const auth = useAuthStore(), route = useRoute();
const timeType = ref<SupplierBillPeriod>('day'), status = ref<SupplierBillStatus>('');
const fromDate = ref(''), toDate = ref(''), keyword = ref('');
const groups = ref<SupplierBillGroups | null>(null), details = ref<SupplierBillDetails | null>(null);
const groupLoading = ref(false), detailLoading = ref(false), error = ref(''), detailError = ref('');
const detailPeriod = ref(''), active = ref(true);
const routeValid = ref(false);
let disposed = false, groupGeneration = 0, detailGeneration = 0;
let groupController: AbortController | undefined, detailController: AbortController | undefined;
let selectedQuery: SupplierBillQuery | undefined;
const canRead = computed(() => active.value && !!auth.token && !!auth.user?.id && !!auth.user?.supplier_id && auth.can('supplier.finance.view'));
const periodTitle = computed(() => ({ day: '日账单', week: '周账单', month: '月账单' })[timeType.value]);

function closeDetails() {
  detailGeneration++; detailController?.abort(); details.value = null;
  detailPeriod.value = ''; detailLoading.value = false; detailError.value = ''; keyword.value = ''; selectedQuery = undefined;
}
function clearGroups() {
  groupGeneration++; groupController?.abort(); groups.value = null; groupLoading.value = false; error.value = ''; closeDetails();
}
function invalidate() {
  clearGroups(); active.value = false; error.value = '登录会话或权限已改变，请重新打开周期账单';
}
const session = createSupplierSessionScope(invalidate);
function current() { return !disposed && session.isCurrent() && canRead.value && routeValid.value; }
function message(value: unknown) { return value instanceof Error ? value.message : '账单读取失败，请重新查询'; }
watch([timeType, status, fromDate, toDate], clearGroups, { flush: 'sync' });
watch(canRead, value => { if (!value) invalidate(); }, { flush: 'sync' });
watch(keyword, () => { detailGeneration++; detailController?.abort(); details.value = null; detailLoading.value = false; detailError.value = ''; }, { flush: 'sync' });
onScopeDispose(() => { disposed = true; clearGroups(); session.dispose(); });

async function loadGroups(page = 1) {
  if (!current()) return;
  const version = ++groupGeneration; groupController?.abort(); groupController = new AbortController();
  groups.value = null; closeDetails(); groupLoading.value = true; error.value = '';
  try {
    const query: SupplierBillQuery = { timeType: timeType.value, status: status.value,
      data: supplierBillDateRange(fromDate.value, toDate.value), page, limit: 20 };
    const result = await getSupplierBillGroups(query, auth.user!.supplier_id, groupController.signal);
    if (!current() || version !== groupGeneration) return;
    groups.value = result;
  } catch (cause) { if (current() && version === groupGeneration) error.value = message(cause); }
  finally { if (version === groupGeneration) groupLoading.value = false; }
}
async function changePeriod(type: SupplierBillPeriod) { if (!routeValid.value) return; timeType.value = type; await loadGroups(); }
async function openDetails(row: SupplierBillGroup) {
  if (!current() || !groups.value || !groups.value.list.some(value => value.period === row.period)) return;
  const source = groups.value; closeDetails(); detailPeriod.value = row.period;
  selectedQuery = { timeType: source.timeType, status: source.status, data: source.data, page: 1, limit: 20 };
  await loadDetails();
}
async function loadDetails(page = 1) {
  if (!current() || !detailPeriod.value || !selectedQuery) return;
  const version = ++detailGeneration; detailController?.abort(); detailController = new AbortController();
  details.value = null; detailLoading.value = true; detailError.value = '';
  const query = { ...selectedQuery, page, period: detailPeriod.value, keyword: keyword.value.trim() };
  try {
    const result = await getSupplierBillDetails(query, auth.user!.supplier_id, detailController.signal);
    if (!current() || version !== detailGeneration) return;
    details.value = result;
  } catch (cause) { if (current() && version === detailGeneration) detailError.value = message(cause); }
  finally { if (version === detailGeneration) detailLoading.value = false; }
}
function readRoute() {
  routeValid.value = false; clearGroups();
  const query = route.query;
  if (Object.keys(query).some(key => !['timeType', 'status', 'from', 'to'].includes(key)) ||
    Object.values(query).some(value => typeof value !== 'string') ||
    query.timeType !== undefined && !['day', 'week', 'month'].includes(String(query.timeType)) ||
    query.status !== undefined && !['', '-1', '0', '1'].includes(String(query.status))) {
    error.value = '账单页面筛选参数无效，请从周期账单入口重新打开'; return;
  }
  timeType.value = (query.timeType ?? 'day') as SupplierBillPeriod;
  status.value = (query.status ?? '') as SupplierBillStatus;
  fromDate.value = String(query.from ?? ''); toDate.value = String(query.to ?? '');
  routeValid.value = true;
  void loadGroups();
}
watch(() => route.fullPath, readRoute, { flush: 'sync' });
onMounted(readRoute);
</script>

<template>
  <section class="bill-page">
    <header class="page-heading"><div><h1>周期账单</h1><p>查看当前供应商的收入、支出与应入账金额</p></div></header>
    <p class="bill-note">时间按北京时间显示。日期筛选对应交易创建时间；“已结算”账单按结算日期分组，其他状态按创建日期分组。</p>
    <p v-if="!canRead" role="alert">当前会话无法查看账单，请重新登录或核对权限。</p>
    <div class="surface bill-filters">
      <div class="bill-periods" role="group" aria-label="账单周期">
        <el-button v-for="(label, type) in { day: '日账单', week: '周账单', month: '月账单' }" :key="type"
          :type="timeType === type ? 'primary' : 'default'" :aria-pressed="timeType === type" :disabled="!canRead || !routeValid" @click="changePeriod(type)">{{ label }}</el-button>
      </div>
      <form class="bill-filter-fields" @submit.prevent="loadGroups()">
        <label>结算状态<select v-model="status" :disabled="!canRead" @change="loadGroups()"><option value="">全部状态</option><option value="0">待结算</option><option value="1">已结算</option><option value="-1">无效</option></select></label>
        <label>开始日期<input v-model="fromDate" type="date" :disabled="!canRead" /></label>
        <label>结束日期<input v-model="toDate" type="date" :disabled="!canRead" /></label>
        <el-button native-type="submit" type="primary" :disabled="!canRead || !routeValid" :loading="groupLoading">查询账单</el-button>
      </form>
    </div>
    <p v-if="error" class="bill-error" role="alert">{{ error }}</p>
    <section class="surface bill-panel" :aria-busy="groupLoading" aria-label="账单列表">
      <h2>{{ periodTitle }}</h2>
      <p v-if="groupLoading" role="status">正在读取账单…</p>
      <template v-if="groups">
        <div class="bill-table-scroll" role="region" aria-label="账单金额列表" tabindex="0"><table>
          <thead><tr><th>账期</th><th>收入金额</th><th>支出金额</th><th>应入账金额</th><th>流水笔数</th><th>操作</th></tr></thead>
          <tbody><tr v-for="row in groups.list" :key="row.period"><th scope="row">{{ row.add_time }}</th>
            <td>{{ supplierBillMoney(row.income_num) }}</td><td>{{ supplierBillMoney(row.exp_num) }}</td><td><strong>{{ supplierBillMoney(row.entry_num) }}</strong></td><td>{{ row.detail_count }}</td>
            <td><el-button link type="primary" :aria-label="`${row.add_time} 账单详情`" @click="openDetails(row)">账单详情</el-button></td></tr></tbody>
        </table></div>
        <p v-if="!groups.count">当前筛选没有账单。</p>
        <div class="bill-pagination"><span>共 {{ groups.count }} 个账期 · 第 {{ groups.page }} 页</span><div>
          <el-button :disabled="groups.page <= 1" @click="loadGroups(groups.page - 1)">上一页账单</el-button>
          <el-button :disabled="groups.page * groups.limit >= groups.count" @click="loadGroups(groups.page + 1)">下一页账单</el-button></div></div>
      </template>
    </section>
    <section v-if="detailPeriod" class="surface bill-panel" :aria-busy="detailLoading" aria-label="账单详情">
      <div class="bill-detail-heading"><div><h2>账单详情</h2><p>{{ detailPeriod }} · {{ status === '1' ? '按结算日期' : '按创建日期' }}</p></div><el-button @click="closeDetails">关闭详情</el-button></div>
      <form class="bill-detail-filter" @submit.prevent="loadDetails()"><label>交易搜索<input v-model="keyword" maxlength="80" placeholder="交易单号或交易人" /></label><el-button native-type="submit" type="primary" :loading="detailLoading">搜索明细</el-button></form>
      <p v-if="detailError" class="bill-error" role="alert">{{ detailError }}</p>
      <p v-if="detailLoading" role="status">正在读取账单明细…</p>
      <template v-if="details">
        <div class="bill-table-scroll" role="region" aria-label="账单交易明细" tabindex="0"><table>
          <thead><tr><th>交易单号</th><th>关联订单</th><th>交易时间</th><th>金额</th><th>交易人</th><th>交易类型</th><th>支付方式</th><th>备注</th></tr></thead>
          <tbody><tr v-for="row in details.list" :key="row.id"><th scope="row">{{ row.order_id }}</th><td>{{ row.link_id || '—' }}</td><td>{{ row.trade_time || '—' }}</td><td>{{ supplierBillMoney(row.number, row.pm) }}</td><td>{{ row.user_nickname }}</td><td>{{ row.type_name }}</td><td>{{ row.pay_type_name }}</td><td class="bill-remark">{{ row.mark || row.remark || '—' }}</td></tr></tbody>
        </table></div>
        <p v-if="!details.count">当前筛选没有交易明细。</p>
        <div class="bill-pagination"><span>共 {{ details.count }} 条明细 · 第 {{ details.page }} 页</span><div>
          <el-button :disabled="details.page <= 1" @click="loadDetails(details.page - 1)">上一页明细</el-button>
          <el-button :disabled="details.page * details.limit >= details.count" @click="loadDetails(details.page + 1)">下一页明细</el-button></div></div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.bill-page{display:grid;gap:16px;min-width:0;max-width:100%}.bill-note,.bill-detail-heading p{margin:0;color:var(--text-muted,#64748b);line-height:1.6}.bill-filters,.bill-panel{padding:20px;min-width:0}.bill-panel h2{font-size:18px;margin:0 0 16px}.bill-filter-fields,.bill-periods,.bill-detail-filter{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}.bill-filter-fields{margin-top:18px}.bill-filter-fields label,.bill-detail-filter label{display:grid;gap:8px;font-size:14px}.bill-page input,.bill-page select{min-height:36px;padding:6px 10px;border:1px solid var(--border,#dcdfe6);border-radius:5px;background:#fff;color:inherit;font:inherit;box-sizing:border-box;max-width:100%}.bill-page input:focus-visible,.bill-page select:focus-visible{outline:2px solid var(--accent,#10b9ae);outline-offset:2px}.bill-table-scroll{max-width:100%;overflow:auto;margin-top:16px}.bill-table-scroll table{width:100%;border-collapse:collapse;font-size:14px;white-space:nowrap}.bill-table-scroll th,.bill-table-scroll td{padding:14px 12px;text-align:left;border-bottom:1px solid var(--border,#ebeef5);font-weight:400}.bill-table-scroll thead th{font-weight:600;color:var(--text-muted,#64748b)}.bill-table-scroll th:first-child,.bill-table-scroll td:first-child{padding-left:0}.bill-remark{max-width:300px;white-space:normal;overflow-wrap:anywhere;min-width:150px}.bill-pagination,.bill-detail-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap}.bill-detail-heading{margin-top:0;margin-bottom:18px}.bill-detail-heading h2{margin-bottom:6px}.bill-error{color:#b42318;margin:0;line-height:1.6}.bill-page :deep(.el-button+.el-button){margin-left:0}.bill-pagination>div{display:flex;gap:8px}.bill-periods{gap:8px}.bill-detail-filter input{width:300px}.bill-detail-filter label{max-width:100%}
@media(max-width:600px){.bill-filters,.bill-panel{padding:14px}.bill-filter-fields label{width:100%}.bill-filter-fields input,.bill-filter-fields select,.bill-detail-filter input{width:100%}.bill-detail-filter{align-items:stretch;flex-direction:column}.bill-detail-filter label{width:100%}.bill-pagination{align-items:flex-start;flex-direction:column}.bill-pagination>div{width:100%;flex-wrap:wrap}.bill-note{font-size:13px}.bill-table-scroll{overscroll-behavior-x:contain}.bill-periods :deep(.el-button){flex:1;padding-inline:10px}}
</style>
