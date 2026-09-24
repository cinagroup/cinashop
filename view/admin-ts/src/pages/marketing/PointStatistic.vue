<template>
  <div class="point-statistic">
    <el-card shadow="never" class="filter-card">
      <template #header><strong>积分统计</strong></template>
      <el-alert v-if="!canView" title="当前账号没有积分统计查看权限" type="warning" :closable="false" show-icon />
      <div v-else class="filter-row">
        <label for="point-range">统计日期（北京时间）</label>
        <el-date-picker
          id="point-range"
          v-model="dateRange"
          type="daterange"
          value-format="YYYY/MM/DD"
          format="YYYY/MM/DD"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          :clearable="false"
          @change="load"
        />
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </el-card>

    <template v-if="canView">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice">
        <template #default><el-button link type="primary" @click="load">重试</el-button></template>
      </el-alert>
      <div v-loading="loading">
        <el-row :gutter="16">
          <el-col v-for="card in cards" :key="card.key" :xs="24" :sm="8">
            <el-card shadow="never" class="metric"><span>{{ card.label }}</span><strong>{{ basic?.[card.key] ?? "—" }}</strong></el-card>
          </el-col>
        </el-row>
        <el-card shadow="never" class="section">
          <template #header><strong>积分使用趋势</strong></template>
          <div ref="trendEl" class="chart trend-chart" role="img" aria-label="积分积累与消耗趋势" />
        </el-card>
        <el-row :gutter="16">
          <el-col :xs="24" :lg="12">
            <el-card shadow="never" class="section">
              <template #header><strong>积分来源分析</strong></template>
              <p class="source-note">历史账单中“订单赠送”和“商品赠送”共用 gain 类型；两项及其占比会重复计入同一批积分。</p>
              <div ref="channelEl" class="chart pie-chart" role="img" aria-label="积分来源分布" />
              <el-table :data="channel?.list ?? []" size="small" empty-text="暂无数据">
                <el-table-column prop="name" label="来源" />
                <el-table-column prop="value" label="积分" />
                <el-table-column label="占比"><template #default="scope">{{ scope.row.percent }}%</template></el-table-column>
              </el-table>
            </el-card>
          </el-col>
          <el-col :xs="24" :lg="12">
            <el-card shadow="never" class="section">
              <template #header><strong>积分消耗</strong></template>
              <div ref="typeEl" class="chart pie-chart" role="img" aria-label="积分消耗分布" />
              <el-table :data="type?.list ?? []" size="small" empty-text="暂无数据">
                <el-table-column prop="name" label="类型" />
                <el-table-column prop="value" label="积分" />
                <el-table-column label="占比"><template #default="scope">{{ scope.row.percent }}%</template></el-table-column>
              </el-table>
            </el-card>
          </el-col>
        </el-row>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import type { StatisticDistribution, StatisticTrend } from "@/api/statistic";
import {
  apiPointBasic, apiPointChannel, apiPointTrend, apiPointType,
  type PointStatisticBasic,
} from "@/api/pointStatistic";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";

const DAY_MS = 86_400_000;
function shanghaiDate(time: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(time);
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")}`;
}

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("point_statistic.view")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);
const today = Date.now();
const dateRange = ref<string[]>([shanghaiDate(today - 29 * DAY_MS), shanghaiDate(today)]);
const basic = ref<PointStatisticBasic | null>(null);
const trend = ref<StatisticTrend | null>(null);
const channel = ref<StatisticDistribution | null>(null);
const type = ref<StatisticDistribution | null>(null);
const loading = ref(false);
const error = ref("");
const trendEl = ref<HTMLElement>();
const channelEl = ref<HTMLElement>();
const typeEl = ref<HTMLElement>();
const cards: Array<{ key: keyof PointStatisticBasic; label: string }> = [
  { key: "now_point", label: "当前积分" },
  { key: "all_point", label: "累计总积分" },
  { key: "pay_point", label: "累计消耗积分" },
];
let trendChart: echarts.ECharts | null = null;
let channelChart: echarts.ECharts | null = null;
let typeChart: echarts.ECharts | null = null;
let mounted = false;
let generation = 0;
let request: AbortController | null = null;

function current(stamp: string, index: number): boolean {
  return mounted && canView.value && sessionKey.value === stamp && generation === index;
}

function disposeCharts() {
  trendChart?.dispose();
  channelChart?.dispose();
  typeChart?.dispose();
  trendChart = null;
  channelChart = null;
  typeChart = null;
}

function clear() {
  generation++;
  request?.abort();
  request = null;
  disposeCharts();
  basic.value = null;
  trend.value = null;
  channel.value = null;
  type.value = null;
  error.value = "";
  loading.value = false;
}

function pie(chart: echarts.ECharts, data: StatisticDistribution) {
  chart.setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { bottom: 0 },
    series: [{ type: "pie", radius: ["40%", "68%"], data: data.bing_data }],
  }, true);
}

async function renderCharts(stamp: string, index: number) {
  await nextTick();
  if (!current(stamp, index)) return;
  if (trendEl.value && trend.value) {
    trendChart ??= echarts.init(trendEl.value);
    trendChart.setOption({
      tooltip: { trigger: "axis" },
      legend: { data: trend.value.series.map((item) => item.name) },
      toolbox: { feature: { saveAsImage: { name: "积分使用" } } },
      grid: { left: 58, right: 28, top: 55, bottom: 42 },
      xAxis: { type: "category", data: trend.value.xAxis },
      yAxis: { type: "value" },
      series: trend.value.series.map((item) => ({ ...item, smooth: true, symbol: "none" })),
    }, true);
  }
  if (channelEl.value && channel.value) { channelChart ??= echarts.init(channelEl.value); pie(channelChart, channel.value); }
  if (typeEl.value && type.value) { typeChart ??= echarts.init(typeEl.value); pie(typeChart, type.value); }
}

async function load() {
  if (!mounted || !canView.value) return;
  const [start, stop] = dateRange.value ?? [];
  clear();
  if (!start || !stop) { error.value = "请选择完整日期范围"; return; }
  const time = `${start}-${stop}`;
  const stamp = sessionKey.value;
  const index = ++generation;
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  try {
    const result = await Promise.all([
      apiPointBasic(time, controller.signal),
      apiPointTrend(time, controller.signal),
      apiPointChannel(time, controller.signal),
      apiPointType(time, controller.signal),
    ]);
    if (!current(stamp, index)) return;
    [basic.value, trend.value, channel.value, type.value] = result;
    await renderCharts(stamp, index);
  } catch (cause) {
    if (current(stamp, index) && !controller.signal.aborted) {
      disposeCharts();
      error.value = cause instanceof Error ? cause.message : "积分统计加载失败";
    }
  } finally {
    if (generation === index) {
      request = null;
      loading.value = false;
    }
  }
}

function resize() { trendChart?.resize(); channelChart?.resize(); typeChart?.resize(); }
function syncSession() {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
watch([sessionKey, canView], () => { clear(); if (canView.value) void load(); });
onMounted(() => {
  mounted = true;
  window.addEventListener("resize", resize);
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value) void load();
});
onBeforeUnmount(() => {
  mounted = false;
  clear();
  window.removeEventListener("resize", resize);
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
});
</script>

<style scoped>
.filter-card, .section, .metric { margin-bottom: 16px; }
.filter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.filter-row label { color: #5e6878; }
.notice { margin-bottom: 16px; }
.source-note { margin: 0 0 8px; color: #666f7b; font-size: 13px; line-height: 1.5; }
.metric :deep(.el-card__body) { display: flex; min-height: 98px; flex-direction: column; justify-content: center; gap: 8px; }
.metric span { color: #7a8494; }
.metric strong { color: #202632; font-size: 27px; }
.chart { width: 100%; }
.trend-chart { height: 390px; }
.pie-chart { height: 300px; }
@media (max-width: 720px) { .trend-chart { height: 320px; } }
</style>
