<template>
  <div class="supplier-bills">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div><strong>供应商账单</strong><p>按日、周、月核对收入、支出与供应商应入账金额。</p></div>
          <el-button v-if="canView" :loading="groupLoading" @click="loadGroups(page)">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有供应商账单查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="filter-field">
            <span>账单状态</span>
            <el-select :model-value="routeStatus" aria-label="账单状态" @change="changeStatus">
              <el-option label="全部账单" value="" />
              <el-option label="待结算" value="0" />
              <el-option label="已结算" value="1" />
              <el-option label="无效" value="-1" />
            </el-select>
          </label>
          <label class="filter-field">
            <span>选择供应商</span>
            <el-select v-model="supplierId" aria-label="选择供应商" clearable filterable placeholder="全部供应商">
              <el-option v-for="supplier in suppliers" :key="supplier.id"
                :label="supplier.supplier_name" :value="supplier.id" />
            </el-select>
          </label>
          <label class="filter-field date-field">
            <span>创建时间（北京时间）</span>
            <el-date-picker v-model="timeRange" type="datetimerange" aria-label="创建时间范围"
              format="YYYY/MM/DD HH:mm:ss" value-format="YYYY/MM/DD HH:mm:ss"
              start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" clearable />
          </label>
          <div class="filter-actions">
            <el-button type="primary" :loading="groupLoading" @click="loadGroups(1)">查询</el-button>
            <el-button :disabled="groupLoading" @click="resetFilters">重置</el-button>
          </div>
        </div>
        <p v-if="routeStatus === '1'" class="time-note">已结算账单按完成时间归组，日期条件仍筛选创建时间。</p>
        <p class="time-note">日期范围两端均包含；两端相同或结束时间为 00:00:00 时，沿用旧账单的次日边界。</p>
        <el-alert v-if="groupError" :title="groupError" type="error" :closable="false" show-icon class="notice" />
        <el-tabs v-model="timeType" class="period-tabs" @tab-change="changePeriod">
          <el-tab-pane label="日账单" name="day" />
          <el-tab-pane label="周账单" name="week" />
          <el-tab-pane label="月账单" name="month" />
        </el-tabs>
        <div v-if="groups.length" class="page-totals">
          <span>本页 {{ groups.length }} 组</span>
          <span>收入 <b class="income">¥{{ pageTotals.income }}</b></span>
          <span>支出 <b class="expense">¥{{ pageTotals.expense }}</b></span>
          <span>应入账 <b>¥{{ pageTotals.entry }}</b></span>
        </div>
        <div class="table-scroll">
          <el-table :data="groups" v-loading="groupLoading" row-key="period" stripe empty-text="暂无账单">
            <el-table-column prop="id" label="ID" width="75" />
            <el-table-column prop="title" label="标题" min-width="130" />
            <el-table-column prop="add_time" label="日期" min-width="145" />
            <el-table-column label="收入金额" min-width="120"><template #default="{ row }"><b class="income">¥{{ row.income_num }}</b></template></el-table-column>
            <el-table-column label="支出金额" min-width="120"><template #default="{ row }"><b class="expense">¥{{ row.exp_num }}</b></template></el-table-column>
            <el-table-column label="供应商应入账金额" min-width="160"><template #default="{ row }">¥{{ row.entry_num }}</template></el-table-column>
            <el-table-column label="操作" min-width="170" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetails(row)">账单详情</el-button>
                <el-button link type="primary" :loading="exportingPeriod === row.period" :disabled="!!exportingPeriod" @click="download(row)">下载</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="15"
          :current-page="page" @current-change="loadGroups" />
      </template>
    </el-card>

    <el-dialog v-model="detailVisible" :title="activeGroup ? `${activeGroup.title} · 账单详情` : '账单详情'"
      width="min(1120px, calc(100vw - 24px))" destroy-on-close @closed="closeDetails">
      <template v-if="activeGroup && canView">
        <div class="detail-filters">
          <label class="filter-field">
            <span>选择供应商</span>
            <el-select v-model="detailSupplierId" aria-label="详情供应商" clearable filterable
              placeholder="全部供应商" :disabled="appliedScope?.supplier_id !== ''" @change="loadDetails(1)">
              <el-option v-for="supplier in suppliers" :key="supplier.id"
                :label="supplier.supplier_name" :value="supplier.id" />
            </el-select>
          </label>
          <label class="filter-field search-field">
            <span>订单搜索</span>
            <el-input v-model="detailKeyword" aria-label="交易单号或交易人" maxlength="80" clearable
              placeholder="交易单号或交易人" @keyup.enter="loadDetails(1)" />
          </label>
          <el-button type="primary" :loading="detailLoading" @click="loadDetails(1)">搜索</el-button>
          <el-button :disabled="detailLoading" @click="resetDetails">重置</el-button>
        </div>
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon class="notice" />
        <div class="table-scroll">
          <el-table :data="details" v-loading="detailLoading" row-key="id" stripe empty-text="暂无交易记录">
            <el-table-column prop="order_id" label="交易单号" min-width="150" />
            <el-table-column prop="link_id" label="关联订单" min-width="150" />
            <el-table-column prop="trade_time" label="交易时间" min-width="165" />
            <el-table-column v-if="appliedScope?.status === '1'" prop="finish_time" label="完成时间" min-width="165" />
            <el-table-column label="交易金额" min-width="115">
              <template #default="{ row }"><span :class="row.pm === 1 ? 'income' : 'expense'">{{ row.pm === 1 ? '+' : '-' }} ¥{{ row.number }}</span></template>
            </el-table-column>
            <el-table-column prop="user_nickname" label="交易人" min-width="120" show-overflow-tooltip />
            <el-table-column prop="type_name" label="交易类型" min-width="115" />
            <el-table-column prop="pay_type_name" label="支付方式" min-width="110" />
            <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
          </el-table>
        </div>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="detailTotal"
          :page-size="10" :current-page="detailPage" @current-change="loadDetails" />
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import {
  apiSupplierBillDetails, apiSupplierBillExport, apiSupplierBillGroups, apiSupplierBillSuppliers,
  supplierBillCsv, supplierBillDataRange, type SupplierBillDetail, type SupplierBillGroup,
  type SupplierBillGroupScope, type SupplierBillScope, type SupplierBillStatus,
  type SupplierBillSupplier, type SupplierBillTimeType,
} from "@/api/supplierBill";

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("supplier_bill.view") &&
      session.uniqueAuth.includes("supplier_bill.view")));
});
const routeStatus = computed<SupplierBillStatus>(() => {
  const value = route.query.status;
  return value === "0" || value === "1" || value === "-1" ? value : "";
});
const suppliers = ref<SupplierBillSupplier[]>([]);
const supplierId = ref<number | "">("");
const timeRange = ref<string[] | null>(null);
const timeType = ref<SupplierBillTimeType>("day");
const groups = ref<SupplierBillGroup[]>([]), total = ref(0), page = ref(1);
const groupLoading = ref(false), groupError = ref("");
const detailVisible = ref(false), activeGroup = ref<SupplierBillGroup | null>(null);
const details = ref<SupplierBillDetail[]>([]), detailTotal = ref(0), detailPage = ref(1);
const detailSupplierId = ref<number | "">(""), detailKeyword = ref("");
const detailLoading = ref(false), detailError = ref("");
const exportingPeriod = ref("");
let appliedScope: SupplierBillScope | null = null;
let alive = false, sessionGeneration = 0, supplierVersion = 0, groupVersion = 0, detailVersion = 0, exportVersion = 0;
let supplierAbort: AbortController | null = null, groupAbort: AbortController | null = null,
  detailAbort: AbortController | null = null, exportAbort: AbortController | null = null;
type ScopeStamp = { identity: string; stored: string | null; sessionGeneration: number };
function stamp(): ScopeStamp { return { identity: identity.value, stored: stored.value, sessionGeneration }; }
function current(value: ScopeStamp): boolean {
  return alive && canView.value && identity.value === value.identity && stored.value === value.stored &&
    stored.value === localStorage.getItem("admin_session") && sessionGeneration === value.sessionGeneration;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "供应商账单加载失败"; }
function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = "00"] = (negative ? value.slice(1) : value).split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -amount : amount;
}
function money(value: bigint): string {
  const negative = value < 0n;
  const amount = negative ? -value : value;
  return `${negative ? "-" : ""}${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}
const pageTotals = computed(() => {
  const sum = (key: "income_num" | "exp_num" | "entry_num") =>
    money(groups.value.reduce((total, row) => total + cents(row[key]), 0n));
  return { income: sum("income_num"), expense: sum("exp_num"), entry: sum("entry_num") };
});
function invalidateDetails(): void {
  detailVersion++; detailAbort?.abort(); detailAbort = null;
  details.value = []; detailTotal.value = 0; detailPage.value = 1;
  detailLoading.value = false; detailError.value = "";
  detailVisible.value = false; activeGroup.value = null;
}
function invalidateGroups(): void {
  groupVersion++; groupAbort?.abort(); groupAbort = null;
  exportVersion++; exportAbort?.abort(); exportAbort = null; exportingPeriod.value = "";
  invalidateDetails(); appliedScope = null;
  groups.value = []; total.value = 0; page.value = 1;
  groupLoading.value = false; groupError.value = "";
}
function resetSession(): void {
  sessionGeneration++; supplierVersion++; supplierAbort?.abort(); supplierAbort = null;
  suppliers.value = []; invalidateGroups();
}
function requestedScope(): SupplierBillScope {
  return { timeType: timeType.value, data: supplierBillDataRange(timeRange.value),
    supplier_id: supplierId.value || "", status: routeStatus.value };
}
async function loadSuppliers(): Promise<void> {
  if (!canView.value) return;
  supplierAbort?.abort(); const value = stamp(), version = ++supplierVersion;
  const controller = new AbortController(); supplierAbort = controller;
  try {
    const result = await apiSupplierBillSuppliers(controller.signal);
    if (current(value) && supplierVersion === version && supplierAbort === controller) suppliers.value = result;
  } catch (error) {
    if (current(value) && supplierVersion === version && !controller.signal.aborted) ElMessage.error(message(error));
  } finally { if (supplierAbort === controller) supplierAbort = null; }
}
async function loadGroups(targetPage = 1): Promise<void> {
  if (!canView.value) return;
  invalidateGroups();
  let query: SupplierBillScope;
  try { query = requestedScope(); }
  catch (error) { groupError.value = message(error); return; }
  const value = stamp(), version = ++groupVersion, controller = new AbortController();
  groupAbort = controller; groupLoading.value = true;
  try {
    const result = await apiSupplierBillGroups({ ...query, page: targetPage, limit: 15 }, controller.signal);
    if (current(value) && groupVersion === version && groupAbort === controller) {
      groups.value = result.list; total.value = result.count; page.value = targetPage; appliedScope = query;
    }
  } catch (error) {
    if (current(value) && groupVersion === version && !controller.signal.aborted) groupError.value = message(error);
  } finally { if (groupAbort === controller) { groupAbort = null; groupLoading.value = false; } }
}
function changePeriod(): void { void loadGroups(1); }
function changeStatus(value: string): void {
  const status = value === "0" || value === "1" || value === "-1" ? value : "";
  if (status === routeStatus.value) { void loadGroups(1); return; }
  invalidateGroups();
  void router.push({ path: "/supplier/bills", query: { ...route.query, status: status || undefined } });
}
function resetFilters(): void {
  supplierId.value = ""; timeRange.value = null; void loadGroups(1);
}
function groupScope(group: SupplierBillGroup): SupplierBillGroupScope | null {
  return appliedScope && groups.value.includes(group)
    ? { ...appliedScope, period: group.period } : null;
}
function openDetails(group: SupplierBillGroup): void {
  if (!canView.value || !groupScope(group)) return;
  invalidateDetails(); activeGroup.value = group; detailVisible.value = true;
  detailSupplierId.value = appliedScope?.supplier_id ?? ""; detailKeyword.value = "";
  void loadDetails(1);
}
async function loadDetails(targetPage = 1): Promise<void> {
  const group = activeGroup.value;
  if (!group || !canView.value) return;
  const base = groupScope(group);
  if (!base) return;
  detailAbort?.abort(); const value = stamp(), version = ++detailVersion;
  const controller = new AbortController(); detailAbort = controller;
  details.value = []; detailTotal.value = 0; detailPage.value = 1;
  detailLoading.value = true; detailError.value = "";
  try {
    const result = await apiSupplierBillDetails({ ...base,
      supplier_id: appliedScope?.supplier_id || detailSupplierId.value || "",
      keyword: detailKeyword.value.trim(), page: targetPage, limit: 10 }, controller.signal);
    if (current(value) && detailVersion === version && detailAbort === controller && activeGroup.value?.period === group.period) {
      details.value = result.list; detailTotal.value = result.count; detailPage.value = targetPage;
    }
  } catch (error) {
    if (current(value) && detailVersion === version && !controller.signal.aborted) detailError.value = message(error);
  } finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
function resetDetails(): void {
  detailSupplierId.value = appliedScope?.supplier_id ?? ""; detailKeyword.value = ""; void loadDetails(1);
}
function closeDetails(): void { invalidateDetails(); }
async function download(group: SupplierBillGroup): Promise<void> {
  const query = groupScope(group);
  if (!query || !canView.value || exportingPeriod.value) return;
  exportAbort?.abort(); const value = stamp(), version = ++exportVersion, controller = new AbortController();
  exportAbort = controller; exportingPeriod.value = group.period;
  try {
    const result = await apiSupplierBillExport(query, controller.signal);
    if (!current(value) || exportVersion !== version || exportAbort !== controller || !groupScope(group)) return;
    const csv = supplierBillCsv(result);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${result.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").slice(0, 100) || "供应商账单"}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    if (current(value) && exportVersion === version && !controller.signal.aborted) ElMessage.error(message(error));
  } finally { if (exportAbort === controller) { exportAbort = null; exportingPeriod.value = ""; } }
}
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
watch([identity, canView, stored], () => {
  resetSession(); if (canView.value) { void loadSuppliers(); void loadGroups(1); }
});
watch(() => route.query.status, () => {
  if (!alive || !canView.value) return;
  void loadGroups(1);
});
watch([supplierId, timeRange], () => { if (alive) invalidateGroups(); }, { deep: true, flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const before = `${identity.value}:${stored.value}:${canView.value}`;
  syncSession();
  if (before === `${identity.value}:${stored.value}:${canView.value}` && canView.value) {
    void loadSuppliers(); void loadGroups(1);
  }
});
onBeforeUnmount(() => {
  alive = false; resetSession();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
});
</script>

<style scoped>
.supplier-bills { min-width: 0; }
.card-header { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
.card-header p, .time-note { margin: 5px 0 0; color: #7a8391; font-size: 12px; }
.filters, .detail-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 12px 0; }
.filter-field { display: flex; flex: 1 1 170px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.date-field { flex: 2 1 340px; }.search-field { flex: 2 1 220px; }
.filter-field :deep(.el-select), .filter-field :deep(.el-date-editor), .filter-field :deep(.el-input) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }.period-tabs { margin-top: 16px; }
.notice { margin-top: 12px; }.table-scroll { max-width: 100%; overflow-x: auto; }
.page-totals { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 0 14px; color: #596574; font-size: 13px; }
.income { color: #dc4c3f; }.expense { color: #238e68; }
.pager { display: flex; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 640px) { .filters, .detail-filters { display: grid; grid-template-columns: minmax(0, 1fr); }.filter-actions { justify-content: flex-start; }.pager { justify-content: center; } }
</style>
