<template>
  <div class="division-statistics">
    <el-card shadow="never" class="filter-card">
      <template #header><strong>事业部统计</strong></template>
      <el-alert v-if="!canView" title="当前账号没有事业部统计查看权限" type="warning" :closable="false" show-icon />
      <div v-else class="filters">
        <label for="division-statistics-range">统计日期（北京时间）</label>
        <el-date-picker id="division-statistics-range" v-model="dateRange" type="daterange"
          value-format="YYYY/MM/DD" format="YYYY/MM/DD" range-separator="至"
          start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false"
          @change="loadTrend" />
        <el-button :loading="trendLoading" @click="loadTrend">刷新趋势</el-button>
        <div class="shortcuts" aria-label="统计日期快捷选项">
          <el-button v-for="option in shortcuts" :key="option.key" link size="small" @click="selectShortcut(option.key)">
            {{ option.label }}
          </el-button>
        </div>
      </div>
    </el-card>

    <template v-if="canView">
      <el-alert v-if="summaryError" :title="summaryError" type="error" :closable="false" show-icon class="notice">
        <el-button link type="primary" @click="loadSummary">重试概览</el-button>
      </el-alert>
      <el-row :gutter="16" v-loading="summaryLoading" class="metrics">
        <el-col v-for="card in cards" :key="card.key" :xs="24" :sm="12" :lg="8">
          <el-card shadow="never" class="metric">
            <span>{{ card.label }}</span><strong>{{ summary?.[card.key] ?? "—" }}</strong>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="section">
        <template #header><strong>营业趋势</strong></template>
        <el-alert v-if="trendError" :title="trendError" type="error" :closable="false" show-icon class="notice">
          <el-button link type="primary" @click="loadTrend">重试趋势</el-button>
        </el-alert>
        <div v-loading="trendLoading" ref="trendEl" class="trend-chart" role="img" aria-label="事业部订单金额与订单量趋势" />
      </el-card>

      <el-card shadow="never" class="section">
        <template #header><strong>推广排行榜</strong></template>
        <el-alert v-if="rankingError" :title="rankingError" type="error" :closable="false" show-icon class="notice">
          <el-button link type="primary" @click="loadRanking">重试排行</el-button>
        </el-alert>
        <el-table :data="ranking" v-loading="rankingLoading" border empty-text="暂无数据" class="ranking-table">
          <el-table-column type="index" label="排行" width="72" align="center" />
          <el-table-column prop="nickname" label="名称" min-width="180" align="center" />
          <el-table-column prop="spreadAgent" label="代理商数量" min-width="135" sortable align="center" />
          <el-table-column prop="orderNum" label="订单数" min-width="115" sortable align="center" />
          <el-table-column prop="spreadStaff" label="员工数量" min-width="125" sortable align="center" />
          <el-table-column prop="orderPrice" label="订单金额" min-width="130" sortable :sort-method="sortOrderPrice" align="center" />
          <el-table-column prop="brokeragePrice" label="佣金" min-width="120" sortable :sort-method="sortBrokerage" align="center" />
        </el-table>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import {
  apiDivisionStatisticsRanking, apiDivisionStatisticsSummary, apiDivisionStatisticsTrend,
  divisionStatisticsTime, type DivisionStatisticsRankingItem, type DivisionStatisticsSummary,
  type DivisionStatisticsTrend,
} from "@/api/divisionStatistics";
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
  const item = (name: string) => parts.find((part) => part.type === name)?.value ?? "";
  return `${item("year")}/${item("month")}/${item("day")}`;
}
function utcDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10).replaceAll("-", "/");
}
function shortcutRange(preset: Shortcut, now = Date.now()): string[] {
  const today = shanghaiDate(now);
  const [year, month, day] = today.split("/").map(Number);
  if (preset === "today") return [today, today];
  if (preset === "yesterday") { const previous = utcDate(year, month, day - 1); return [previous, previous]; }
  if (preset === "last7") return [utcDate(year, month, day - 6), today];
  if (preset === "last30") return [utcDate(year, month, day - 29), today];
  if (preset === "lastMonth") return [utcDate(year, month - 1, 1), utcDate(year, month, 0)];
  if (preset === "month") return [utcDate(year, month, 1), today];
  return [utcDate(year, 1, 1), today];
}

const auth = useAuthStore();
const dateRange = ref<string[]>(shortcutRange("last30"));
const summary = ref<DivisionStatisticsSummary | null>(null);
const trend = ref<DivisionStatisticsTrend | null>(null);
const ranking = ref<DivisionStatisticsRankingItem[]>([]);
const summaryLoading = ref(false), trendLoading = ref(false), rankingLoading = ref(false);
const summaryError = ref(""), trendError = ref(""), rankingError = ref("");
const trendEl = ref<HTMLElement>();
const cards: Array<{ key: keyof DivisionStatisticsSummary; label: string }> = [
  { key: "divisionNum", label: "区域代理数量" }, { key: "agentNum", label: "代理商数量" },
  { key: "staffNum", label: "员工数量" }, { key: "orderNum", label: "总订单数" },
  { key: "orderPrice", label: "总订单金额" }, { key: "brokeragePrice", label: "获得佣金金额" },
];
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") && session.userInfo.id === auth.userInfo.id &&
    session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("division_statistics.view") &&
      session.uniqueAuth.includes("division_statistics.view")));
});
let alive = false, generation = 0, trendVersion = 0;
let summaryAbort: AbortController | null = null, rankingAbort: AbortController | null = null,
  trendAbort: AbortController | null = null, trendChart: echarts.ECharts | null = null;
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: identity.value, stored: stored.value, generation }; }
function current(stamp: Scope): boolean {
  return alive && canView.value && identity.value === stamp.identity && stored.value === stamp.stored &&
    stored.value === localStorage.getItem("admin_session") && generation === stamp.generation;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "事业部统计加载失败"; }
function clear(): void {
  generation++; trendVersion++;
  summaryAbort?.abort(); rankingAbort?.abort(); trendAbort?.abort();
  summaryAbort = rankingAbort = trendAbort = null;
  trendChart?.dispose(); trendChart = null;
  summary.value = null; trend.value = null; ranking.value = [];
  summaryLoading.value = trendLoading.value = rankingLoading.value = false;
  summaryError.value = trendError.value = rankingError.value = "";
}
function sortOrderPrice(a: DivisionStatisticsRankingItem, b: DivisionStatisticsRankingItem): number {
  return compareMoney(a.orderPrice, b.orderPrice);
}
function sortBrokerage(a: DivisionStatisticsRankingItem, b: DivisionStatisticsRankingItem): number {
  return compareMoney(a.brokeragePrice, b.brokeragePrice);
}
function compareMoney(first: string, second: string): number {
  const cents = (value: string): bigint => {
    const negative = value.startsWith("-");
    const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
    const unsigned = BigInt(whole) * 100n + BigInt(fraction);
    return negative ? -unsigned : unsigned;
  };
  const left = cents(first), right = cents(second);
  return left < right ? -1 : left > right ? 1 : 0;
}
async function renderTrend(stamp: Scope, version: number): Promise<void> {
  await nextTick();
  if (!current(stamp) || version !== trendVersion || !trend.value || !trendEl.value) return;
  trendChart ??= echarts.init(trendEl.value);
  trendChart.setOption({
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { top: 0, data: trend.value.series.map((item) => item.name) },
    toolbox: { feature: { saveAsImage: { name: "事业部营业趋势" } } },
    grid: { left: "4%", right: "5%", bottom: "15%", containLabel: true },
    xAxis: { type: "category", boundaryGap: true, data: trend.value.xAxis, axisLabel: { interval: 0, rotate: 40 } },
    yAxis: { type: "value" },
    series: trend.value.series.map((line, index) => ({ ...line, smooth: true,
      color: ["#5B8FF9", "#5AD8A6"][index] })),
  }, true);
}
async function loadSummary(): Promise<void> {
  if (!current(scope())) return;
  summaryAbort?.abort(); const stamp = scope(), controller = new AbortController(); summaryAbort = controller;
  summaryLoading.value = true; summaryError.value = "";
  try {
    const result = await apiDivisionStatisticsSummary(controller.signal);
    if (current(stamp) && summaryAbort === controller) summary.value = result;
  } catch (error) {
    if (current(stamp) && summaryAbort === controller && !controller.signal.aborted) summaryError.value = errorMessage(error);
  } finally { if (summaryAbort === controller) { summaryAbort = null; summaryLoading.value = false; } }
}
async function loadRanking(): Promise<void> {
  if (!current(scope())) return;
  rankingAbort?.abort(); const stamp = scope(), controller = new AbortController(); rankingAbort = controller;
  rankingLoading.value = true; rankingError.value = "";
  try {
    const result = await apiDivisionStatisticsRanking(controller.signal);
    if (current(stamp) && rankingAbort === controller) ranking.value = result;
  } catch (error) {
    if (current(stamp) && rankingAbort === controller && !controller.signal.aborted) rankingError.value = errorMessage(error);
  } finally { if (rankingAbort === controller) { rankingAbort = null; rankingLoading.value = false; } }
}
async function loadTrend(): Promise<void> {
  if (!current(scope())) return;
  trendVersion++; trendAbort?.abort(); trendAbort = null;
  trend.value = null; trendChart?.clear(); trendLoading.value = false; trendError.value = "";
  let time: string;
  try { time = divisionStatisticsTime(dateRange.value); }
  catch (error) { trendError.value = errorMessage(error); return; }
  const stamp = scope(), version = trendVersion, controller = new AbortController(); trendAbort = controller;
  trendLoading.value = true;
  try {
    const result = await apiDivisionStatisticsTrend(time, controller.signal);
    if (current(stamp) && trendAbort === controller && trendVersion === version) {
      trend.value = result; await renderTrend(stamp, version);
    }
  } catch (error) {
    if (current(stamp) && trendAbort === controller && trendVersion === version && !controller.signal.aborted)
      trendError.value = errorMessage(error);
  } finally { if (trendAbort === controller) { trendAbort = null; trendLoading.value = false; } }
}
function selectShortcut(preset: Shortcut): void { dateRange.value = shortcutRange(preset); void loadTrend(); }
function loadAll(): void { void loadSummary(); void loadRanking(); void loadTrend(); }
function resize(): void { trendChart?.resize(); }
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
watch([identity, canView, stored], () => { clear(); if (canView.value) loadAll(); });
onMounted(() => {
  alive = true; window.addEventListener("resize", resize);
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const before = `${identity.value}:${stored.value}:${canView.value}`;
  syncSession();
  if (before === `${identity.value}:${stored.value}:${canView.value}` && canView.value) loadAll();
});
onBeforeUnmount(() => {
  alive = false; clear(); window.removeEventListener("resize", resize);
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
});
</script>

<style scoped>
.division-statistics { display: flex; flex-direction: column; gap: 16px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.filters label { color: #5e6878; }
.shortcuts { display: flex; flex-wrap: wrap; gap: 4px; }
.metrics { row-gap: 16px; }
.metric :deep(.el-card__body) { min-height: 96px; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.metric span { color: #7a8494; }
.metric strong { color: #202632; font-size: 27px; }
.trend-chart { height: 400px; width: 100%; }
.notice { margin-bottom: 12px; }
.ranking-table { width: 100%; }
@media (max-width: 720px) { .trend-chart { height: 320px; } }
</style>
