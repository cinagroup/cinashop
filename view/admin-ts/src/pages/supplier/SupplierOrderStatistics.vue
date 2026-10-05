<template>
  <div class="supplier-order-statistics">
    <el-card shadow="never">
      <template #header><div class="card-header"><div><strong>供应商订单统计</strong><p>按北京时间和供应商核对订单、退款与来源分布。</p></div></div></template>
      <el-alert v-if="!canView" title="当前账号没有供应商订单统计查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="filter-field">
            <span>供应商</span>
            <el-select v-model="supplierId" aria-label="选择供应商" clearable filterable placeholder="全部供应商" @change="loadAll">
              <el-option v-for="supplier in suppliers" :key="supplier.id" :label="supplier.supplierName" :value="supplier.id" />
            </el-select>
          </label>
          <label class="filter-field date-field">
            <span>统计日期（北京时间）</span>
            <el-date-picker v-model="dateRange" type="daterange" aria-label="统计日期范围"
              value-format="YYYY/MM/DD" format="YYYY/MM/DD" range-separator="至"
              start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" @change="loadAll" />
          </label>
          <el-button type="primary" :loading="statsLoading || tableLoading" @click="loadAll">查询</el-button>
        </div>
        <div class="shortcuts" aria-label="统计日期快捷选项">
          <el-button v-for="option in shortcuts" :key="option.key" link size="small" @click="selectShortcut(option.key)">{{ option.label }}</el-button>
        </div>
        <p class="time-note">统计日期两端均包含；默认查询最近 30 天。筛选变化会刷新统计。</p>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon class="notice" />
        <el-alert v-if="supplierError" :title="supplierError" type="error" :closable="false" show-icon class="notice" />
      </template>
    </el-card>

    <template v-if="canView && appliedScope">
      <el-alert v-if="statsError" :title="statsError" type="error" :closable="false" show-icon class="notice">
        <el-button link type="primary" @click="loadAll">重试统计</el-button>
      </el-alert>
      <el-row :gutter="16" v-loading="statsLoading" class="metrics">
        <el-col v-for="card in cards" :key="card.key" :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="metric">
            <span>{{ card.label }}</span><strong>{{ summary ? `${card.money ? '¥' : ''}${summary[card.key]}` : '—' }}</strong>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="section">
        <template #header><strong>营业趋势</strong></template>
        <div ref="trendEl" v-loading="statsLoading" class="trend-chart" role="img" aria-label="供应商订单与退款金额及数量趋势" />
        <p class="chart-note">趋势图右上角可下载图片。</p>
      </el-card>

      <el-row :gutter="16" class="analysis-row">
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="analysis-card">
            <template #header><strong>订单来源（订单数）</strong></template>
            <div ref="channelEl" class="distribution-chart" role="img" aria-label="五个来源的订单数分布" />
            <el-table :data="channel?.items ?? []" size="small" empty-text="暂无来源数据">
              <el-table-column prop="name" label="来源" min-width="110" />
              <el-table-column prop="value" label="订单数" min-width="90" />
              <el-table-column label="占比" min-width="90"><template #default="{ row }">{{ row.percent.toFixed(2) }}%</template></el-table-column>
            </el-table>
            <p class="chart-note">合计 {{ channel?.totalCount ?? '—' }} 单</p>
          </el-card>
        </el-col>
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="analysis-card">
            <template #header><strong>订单类型（订单金额）</strong></template>
            <div ref="typeEl" class="distribution-chart" role="img" aria-label="零至八类型的订单金额分布" />
            <el-table :data="typeDistribution?.items ?? []" size="small" empty-text="暂无类型数据">
              <el-table-column prop="name" label="类型" min-width="110" />
              <el-table-column label="订单金额" min-width="120"><template #default="{ row }">¥{{ row.value }}</template></el-table-column>
              <el-table-column label="占比" min-width="90"><template #default="{ row }">{{ row.percent.toFixed(2) }}%</template></el-table-column>
            </el-table>
            <p class="chart-note">合计 ¥{{ typeDistribution?.totalPrice ?? '—' }}</p>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="section">
        <template #header><div class="card-header"><strong>供应商统计表</strong><span>每页 20 条</span></div></template>
        <el-alert v-if="tableError" :title="tableError" type="error" :closable="false" show-icon class="notice">
          <el-button link type="primary" @click="loadTable(page)">重试当前页</el-button>
        </el-alert>
        <div class="table-scroll">
          <el-table :data="rows" v-loading="tableLoading" row-key="id" stripe empty-text="暂无供应商订单数据">
            <el-table-column prop="supplierName" label="供应商信息" min-width="170" show-overflow-tooltip />
            <el-table-column label="订单金额" min-width="125"><template #default="{ row }">¥{{ row.orderPrice }}</template></el-table-column>
            <el-table-column prop="orderCount" label="订单数" min-width="90" />
            <el-table-column label="退款金额" min-width="125"><template #default="{ row }">¥{{ row.refundOrderPrice }}</template></el-table-column>
            <el-table-column prop="refundOrderCount" label="退款订单数" min-width="110" />
          </el-table>
        </div>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20"
          :current-page="page" @current-change="loadTable" />
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import {
  apiSupplierOrderStatisticsChannel, apiSupplierOrderStatisticsSummary,
  apiSupplierOrderStatisticsSuppliers, apiSupplierOrderStatisticsTable,
  apiSupplierOrderStatisticsTrend, apiSupplierOrderStatisticsType,
  supplierOrderStatisticsTime, type SupplierOrderStatisticsChannel,
  type SupplierOrderStatisticsRow, type SupplierOrderStatisticsScope,
  type SupplierOrderStatisticsSummary, type SupplierOrderStatisticsSupplier,
  type SupplierOrderStatisticsTrend, type SupplierOrderStatisticsType,
} from "@/api/supplierOrderStatistics";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";

type Shortcut = "today" | "yesterday" | "last7" | "last30" | "lastMonth" | "month" | "year";
const shortcuts: Array<{ key: Shortcut; label: string }> = [
  { key: "today", label: "今天" }, { key: "yesterday", label: "昨天" },
  { key: "last7", label: "最近7天" }, { key: "last30", label: "最近30天" },
  { key: "lastMonth", label: "上月" }, { key: "month", label: "本月" },
  { key: "year", label: "本年" },
];

function shanghaiDate(stamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(stamp);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")}`;
}
function utcDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10).replaceAll("-", "/");
}
function shortcutRange(preset: Shortcut, now = Date.now()): string[] {
  const today = shanghaiDate(now), [year, month, day] = today.split("/").map(Number);
  if (preset === "today") return [today, today];
  if (preset === "yesterday") { const previous = utcDate(year, month, day - 1); return [previous, previous]; }
  if (preset === "last7") return [utcDate(year, month, day - 6), today];
  if (preset === "last30") return [utcDate(year, month, day - 29), today];
  if (preset === "lastMonth") return [utcDate(year, month - 1, 1), utcDate(year, month, 0)];
  if (preset === "month") return [utcDate(year, month, 1), today];
  return [utcDate(year, 1, 1), today];
}

const auth = useAuthStore();
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("supplier_order_statistics.view") &&
      session.uniqueAuth.includes("supplier_order_statistics.view")));
});

const suppliers = ref<SupplierOrderStatisticsSupplier[]>([]);
const supplierId = ref<number | "">("");
const dateRange = ref<string[]>(shortcutRange("last30"));
const appliedScope = ref<SupplierOrderStatisticsScope | null>(null);
const summary = ref<SupplierOrderStatisticsSummary | null>(null);
const trend = ref<SupplierOrderStatisticsTrend | null>(null);
const channel = ref<SupplierOrderStatisticsChannel | null>(null);
const typeDistribution = ref<SupplierOrderStatisticsType | null>(null);
const rows = ref<SupplierOrderStatisticsRow[]>([]);
const total = ref(0), page = ref(1);
const supplierError = ref(""), filterError = ref(""), statsError = ref(""), tableError = ref("");
const statsLoading = ref(false), tableLoading = ref(false);
const trendEl = ref<HTMLElement>(), channelEl = ref<HTMLElement>(), typeEl = ref<HTMLElement>();
const cards: Array<{ key: keyof SupplierOrderStatisticsSummary; label: string; money: boolean }> = [
  { key: "payPrice", label: "订单金额", money: true },
  { key: "payCount", label: "订单数", money: false },
  { key: "refundPrice", label: "退款金额", money: true },
  { key: "refundCount", label: "退款订单数", money: false },
];
let alive = false, generation = 0, supplierVersion = 0, tableVersion = 0;
let supplierAbort: AbortController | null = null, statsAbort: AbortController | null = null,
  tableAbort: AbortController | null = null;
let trendChart: echarts.ECharts | null = null, channelChart: echarts.ECharts | null = null,
  typeChart: echarts.ECharts | null = null;
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored: stored.value, generation }; }
function current(value: Stamp): boolean {
  return alive && canView.value && identity.value === value.identity && stored.value === value.stored &&
    stored.value === localStorage.getItem("admin_session") && generation === value.generation;
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : "供应商订单统计加载失败"; }
function disposeCharts(): void {
  trendChart?.dispose(); channelChart?.dispose(); typeChart?.dispose();
  trendChart = channelChart = typeChart = null;
}
function clearData(): void {
  generation++; tableVersion++;
  statsAbort?.abort(); statsAbort = null;
  tableAbort?.abort(); tableAbort = null;
  disposeCharts();
  appliedScope.value = null; summary.value = null; trend.value = null;
  channel.value = null; typeDistribution.value = null;
  rows.value = []; total.value = 0; page.value = 1;
  statsLoading.value = tableLoading.value = false;
  filterError.value = statsError.value = tableError.value = "";
}
function resetSession(): void {
  supplierVersion++; supplierAbort?.abort(); supplierAbort = null;
  suppliers.value = []; supplierError.value = "";
  clearData();
}
function requestedScope(): SupplierOrderStatisticsScope {
  return { time: supplierOrderStatisticsTime(dateRange.value), supplier_id: supplierId.value || "" };
}
async function loadSuppliers(): Promise<void> {
  if (!canView.value) return;
  supplierAbort?.abort(); const value = stamp(), version = ++supplierVersion;
  const controller = new AbortController(); supplierAbort = controller; supplierError.value = "";
  try {
    const result = await apiSupplierOrderStatisticsSuppliers(controller.signal);
    if (current(value) && supplierVersion === version && supplierAbort === controller) suppliers.value = result;
  } catch (failure) {
    if (current(value) && supplierVersion === version && !controller.signal.aborted) supplierError.value = errorMessage(failure);
  } finally { if (supplierAbort === controller) supplierAbort = null; }
}
async function renderCharts(value: Stamp): Promise<void> {
  await nextTick();
  if (!current(value)) return;
  if (trendEl.value && trend.value) {
    trendChart ??= echarts.init(trendEl.value);
    trendChart.setOption({
      tooltip: { trigger: "axis" }, legend: { top: 0, data: trend.value.series.map((line) => line.name) },
      toolbox: { feature: { saveAsImage: { name: "供应商营业趋势" } } },
      grid: { left: 55, right: 55, top: 60, bottom: 45 },
      xAxis: { type: "category", data: trend.value.xAxis },
      yAxis: [{ type: "value", name: "金额" }, { type: "value", name: "订单数" }],
      series: trend.value.series.map((line, index) => ({ ...line, yAxisIndex: index % 2,
        smooth: true, symbol: "none", color: ["#5470c6", "#91cc75", "#ee6666", "#fac858"][index] })),
    }, true);
  }
  if (channelEl.value && channel.value) {
    channelChart ??= echarts.init(channelEl.value);
    channelChart.setOption({
      tooltip: { trigger: "item", formatter: "{b}: {c} 单 ({d}%)" }, legend: { bottom: 0 },
      series: [{ type: "pie", radius: ["38%", "68%"], data: channel.value.items.map((item) =>
        ({ name: item.name, value: item.value })) }],
    }, true);
  }
  if (typeEl.value && typeDistribution.value) {
    typeChart ??= echarts.init(typeEl.value);
    typeChart.setOption({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 110, right: 35, top: 20, bottom: 40 },
      xAxis: { type: "value", name: "金额" },
      yAxis: { type: "category", data: typeDistribution.value.items.map((item) => item.name) },
      series: [{ type: "bar", data: typeDistribution.value.items.map((item) => Number(item.value)) }],
    }, true);
  }
}
async function loadAll(): Promise<void> {
  if (!canView.value) return;
  clearData();
  let scope: SupplierOrderStatisticsScope;
  try { scope = requestedScope(); }
  catch (failure) { filterError.value = errorMessage(failure); return; }
  appliedScope.value = scope;
  const value = stamp(), controller = new AbortController(); statsAbort = controller;
  statsLoading.value = true;
  void loadTable(1);
  try {
    const results = await Promise.allSettled([
      apiSupplierOrderStatisticsSummary(scope, controller.signal),
      apiSupplierOrderStatisticsTrend(scope, controller.signal),
      apiSupplierOrderStatisticsChannel(scope, controller.signal),
      apiSupplierOrderStatisticsType(scope, controller.signal),
    ]);
    if (!current(value) || statsAbort !== controller) return;
    if (results[0].status === "fulfilled") summary.value = results[0].value;
    if (results[1].status === "fulfilled") trend.value = results[1].value;
    if (results[2].status === "fulfilled") channel.value = results[2].value;
    if (results[3].status === "fulfilled") typeDistribution.value = results[3].value;
    const failures = results.map((result, index) => result.status === "rejected"
      ? `${["概览", "趋势", "来源", "类型"][index]}：${errorMessage(result.reason)}` : "").filter(Boolean);
    statsError.value = failures.join("；");
    await renderCharts(value);
  } catch (failure) {
    if (current(value) && !controller.signal.aborted) statsError.value = errorMessage(failure);
  } finally { if (statsAbort === controller) { statsAbort = null; statsLoading.value = false; } }
}
async function loadTable(targetPage = 1): Promise<void> {
  const scope = appliedScope.value;
  if (!canView.value || !scope) return;
  tableVersion++; tableAbort?.abort();
  const version = tableVersion, value = stamp(), controller = new AbortController();
  tableAbort = controller; tableLoading.value = true; tableError.value = "";
  rows.value = [];
  try {
    const result = await apiSupplierOrderStatisticsTable({ ...scope, page: targetPage, limit: 20 }, controller.signal);
    if (current(value) && tableVersion === version && tableAbort === controller && appliedScope.value === scope) {
      rows.value = result.list; total.value = result.count; page.value = result.page;
    }
  } catch (failure) {
    if (current(value) && tableVersion === version && !controller.signal.aborted) tableError.value = errorMessage(failure);
  } finally { if (tableAbort === controller) { tableAbort = null; tableLoading.value = false; } }
}
function selectShortcut(preset: Shortcut): void { dateRange.value = shortcutRange(preset); void loadAll(); }
function resize(): void { trendChart?.resize(); channelChart?.resize(); typeChart?.resize(); }
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
function onStorage(event: StorageEvent): void {
  if (event.key === "admin_token" || event.key === "admin_session" || event.key === null) syncSession();
}
watch([identity, canView, stored], () => {
  resetSession(); if (canView.value) { void loadSuppliers(); void loadAll(); }
});
watch([supplierId, dateRange], () => { if (alive) clearData(); }, { deep: true, flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("resize", resize);
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", onStorage);
  const before = `${identity.value}:${stored.value}:${canView.value}`;
  syncSession();
  if (before === `${identity.value}:${stored.value}:${canView.value}` && canView.value) {
    void loadSuppliers(); void loadAll();
  }
});
onBeforeUnmount(() => {
  alive = false; resetSession();
  window.removeEventListener("resize", resize);
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", onStorage);
});
</script>

<style scoped>
.supplier-order-statistics { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.card-header p, .time-note, .chart-note { margin: 5px 0 0; color: #7a8391; font-size: 12px; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 14px 0 8px; }
.filter-field { display: flex; flex: 1 1 210px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.date-field { flex: 2 1 330px; }
.filter-field :deep(.el-select), .filter-field :deep(.el-date-editor) { width: 100%; }
.shortcuts { display: flex; flex-wrap: wrap; gap: 4px; }
.notice { margin: 12px 0; }
.metrics, .analysis-row { row-gap: 16px; }
.metric :deep(.el-card__body) { min-height: 96px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.metric span { color: #7a8494; }.metric strong { color: #202632; font-size: 27px; }
.trend-chart { height: 390px; width: 100%; }
.distribution-chart { height: 320px; width: 100%; }
.analysis-card { height: 100%; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; margin-top: 16px; }
@media (max-width: 720px) { .trend-chart { height: 330px; } .distribution-chart { height: 270px; } }
</style>
