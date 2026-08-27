<template>
  <section aria-label="用户统计">
    <el-card shadow="never" class="panel-toolbar">
      <div class="panel-actions">
        <div>
          <strong>用户经营概况</strong>
          <small>注册、访问、成交与会员统一口径</small>
        </div>
        <div class="action-group">
          <el-select v-model="channel" style="width: 150px" @change="load">
            <el-option label="全部渠道" value="" />
            <el-option label="公众号" value="wechat" />
            <el-option label="小程序" value="routine" />
            <el-option label="H5" value="h5" />
            <el-option label="PC" value="pc" />
            <el-option label="APP" value="app" />
          </el-select>
          <el-button :loading="exportLoading" @click="exportCsv">导出 CSV</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" v-loading="loading">
      <el-col v-for="card in cards" :key="card.key" :xs="24" :sm="12" :lg="6" :xl="4">
        <el-card shadow="never" class="metric-card">
          <span>{{ card.label }}</span>
          <strong>{{ formatMetric(card.key, basic?.[card.key]?.num) }}</strong>
          <small :class="trendClass(basic?.[card.key]?.percent)">
            环比 {{ formatPercent(basic?.[card.key]?.percent) }} · 上期 {{ formatMetric(card.key, basic?.[card.key]?.last_num) }}
          </small>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="section-card">
      <template #header><div class="card-title"><span>用户趋势</span><small>{{ range }}</small></div></template>
      <div ref="trendEl" class="chart chart-wide"></div>
    </el-card>

    <template v-if="channel === 'wechat'">
      <el-row :gutter="16">
        <el-col v-for="card in wechatCards" :key="card.key" :xs="24" :sm="12" :lg="6">
          <el-card shadow="never" class="metric-card wechat-card">
            <span>{{ card.label }}</span>
            <strong>{{ wechatBasic?.[card.key]?.num ?? 0 }}</strong>
            <small :class="trendClass(wechatBasic?.[card.key]?.percent)">环比 {{ formatPercent(wechatBasic?.[card.key]?.percent) }}</small>
          </el-card>
        </el-col>
      </el-row>
      <el-card shadow="never" class="section-card">
        <template #header>微信关注趋势</template>
        <div ref="wechatTrendEl" class="chart chart-wide"></div>
      </el-card>
    </template>

    <el-row :gutter="16" class="distribution-row">
      <el-col :xs="24" :lg="15">
        <el-card shadow="never" class="section-card">
          <template #header><div class="card-title"><span>用户地域</span><small>按支付金额排序</small></div></template>
          <div ref="regionEl" class="chart region-chart"></div>
          <el-table :data="region" size="small" max-height="330">
            <el-table-column prop="province" label="地区" min-width="100" />
            <el-table-column prop="allNum" label="累计用户" width="100" />
            <el-table-column prop="newNum" label="新增用户" width="100" />
            <el-table-column prop="visitNum" label="访客" width="90" />
            <el-table-column label="支付金额" width="120"><template #default="scope">¥{{ Number(scope.row.payPrice).toFixed(2) }}</template></el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="9">
        <el-card shadow="never" class="section-card mobile-gap">
          <template #header>新增用户性别</template>
          <div ref="sexEl" class="chart sex-chart"></div>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import * as echarts from "echarts";
import {
  apiUserStatisticBasic,
  apiUserStatisticExport,
  apiUserStatisticRegion,
  apiUserStatisticSex,
  apiUserStatisticTrend,
  apiUserStatisticWechat,
  apiUserStatisticWechatTrend,
  type MetricComparison,
  type SexRow,
  type UserRegionRow,
  type UserStatisticBasic,
  type ValueTrend,
} from "@/api/statistic";

const props = defineProps<{ range: string; reloadKey: number }>();
type UserKey = keyof UserStatisticBasic;

const loading = ref(false);
const exportLoading = ref(false);
const channel = ref("");
const basic = ref<UserStatisticBasic | null>(null);
const trend = ref<ValueTrend | null>(null);
const wechatBasic = ref<Record<string, MetricComparison> | null>(null);
const wechatTrend = ref<ValueTrend | null>(null);
const region = ref<UserRegionRow[]>([]);
const sex = ref<SexRow[]>([]);
const trendEl = ref<HTMLElement>();
const wechatTrendEl = ref<HTMLElement>();
const regionEl = ref<HTMLElement>();
const sexEl = ref<HTMLElement>();
let trendChart: echarts.ECharts | null = null;
let wechatChart: echarts.ECharts | null = null;
let regionChart: echarts.ECharts | null = null;
let sexChart: echarts.ECharts | null = null;

const cards: Array<{ key: UserKey; label: string }> = [
  { key: "people", label: "访客数" }, { key: "browse", label: "浏览量" },
  { key: "newUser", label: "新增用户" }, { key: "payPeople", label: "成交用户" },
  { key: "payPercent", label: "访问支付转化" }, { key: "payUser", label: "激活付费会员" },
  { key: "rechargePeople", label: "充值用户" }, { key: "payPrice", label: "客单价" },
  { key: "cumulativeUser", label: "累计用户" }, { key: "cumulativePayUser", label: "累计付费会员" },
  { key: "cumulativeRechargePeople", label: "累计充值用户" }, { key: "cumulativePayPeople", label: "累计成交用户" },
];
const wechatCards = [
  { key: "subscribe", label: "新增关注" }, { key: "unSubscribe", label: "新增取关" },
  { key: "increaseSubscribe", label: "净增关注" }, { key: "cumulativeSubscribe", label: "累计关注" },
  { key: "cumulativeUnSubscribe", label: "累计取关" },
];

function formatMetric(key: UserKey, value: number | undefined): string {
  if (key === "payPrice") return `¥${Number(value ?? 0).toFixed(2)}`;
  if (key === "payPercent") return `${Number(value ?? 0).toFixed(2)}%`;
  return Math.round(Number(value ?? 0)).toLocaleString("zh-CN");
}
function formatPercent(value: number | undefined): string {
  const number = Number(value ?? 0);
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}
function trendClass(value: number | undefined): string { return Number(value ?? 0) >= 0 ? "trend-up" : "trend-down"; }

function setValueTrend(chart: echarts.ECharts, data: ValueTrend): void {
  chart.setOption({
    tooltip: { trigger: "axis" }, legend: { type: "scroll", data: data.series.map((item) => item.name) },
    grid: { left: 55, right: 28, top: 58, bottom: 42 },
    xAxis: { type: "category", data: data.xAxis, axisLabel: { hideOverlap: true } }, yAxis: { type: "value" },
    series: data.series.map((item) => ({ name: item.name, type: "line", smooth: true, symbol: "none", data: item.value })),
  }, true);
}

async function render(): Promise<void> {
  await nextTick();
  if (trendEl.value && trend.value) { trendChart ??= echarts.init(trendEl.value); setValueTrend(trendChart, trend.value); }
  if (channel.value === "wechat" && wechatTrendEl.value && wechatTrend.value) {
    wechatChart ??= echarts.init(wechatTrendEl.value); setValueTrend(wechatChart, wechatTrend.value);
  }
  if (regionEl.value) {
    regionChart ??= echarts.init(regionEl.value);
    const top = region.value.slice(0, 8).reverse();
    regionChart.setOption({
      tooltip: { trigger: "axis" }, grid: { left: 52, right: 28, top: 20, bottom: 35 },
      xAxis: { type: "value" }, yAxis: { type: "category", data: top.map((item) => item.province) },
      series: [{ name: "支付金额", type: "bar", data: top.map((item) => item.payPrice), itemStyle: { color: "#5b8ff9" } }],
    }, true);
  }
  if (sexEl.value) {
    sexChart ??= echarts.init(sexEl.value);
    sexChart.setOption({
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" }, legend: { bottom: 0 },
      series: [{ type: "pie", radius: ["42%", "70%"], data: sex.value }],
    }, true);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const requests = [
      apiUserStatisticBasic(props.range, channel.value), apiUserStatisticTrend(props.range, channel.value),
      apiUserStatisticRegion(props.range, channel.value, "payPrice"), apiUserStatisticSex(props.range, channel.value),
    ] as const;
    [basic.value, trend.value, region.value, sex.value] = await Promise.all(requests);
    if (channel.value === "wechat") {
      [wechatBasic.value, wechatTrend.value] = await Promise.all([
        apiUserStatisticWechat(props.range), apiUserStatisticWechatTrend(props.range),
      ]);
    }
    await render();
  } catch (error) {
    ElMessage.error((error as Error).message || "用户统计加载失败");
  } finally { loading.value = false; }
}

async function exportCsv(): Promise<void> {
  exportLoading.value = true;
  try {
    const metadata = await apiUserStatisticExport(props.range, channel.value);
    const escape = (value: unknown) => {
      const text = String(value ?? "");
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const rows = metadata.export.map((row) => metadata.filekey.map((key) => row[key] ?? ""));
    const csv = [metadata.header, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${metadata.filename}.csv`;
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) { ElMessage.error((error as Error).message || "用户统计导出失败"); }
  finally { exportLoading.value = false; }
}

function resize(): void { trendChart?.resize(); wechatChart?.resize(); regionChart?.resize(); sexChart?.resize(); }
watch(() => props.reloadKey, load, { immediate: true });
window.addEventListener("resize", resize);
onBeforeUnmount(() => {
  window.removeEventListener("resize", resize);
  trendChart?.dispose(); wechatChart?.dispose(); regionChart?.dispose(); sexChart?.dispose();
});
</script>

<style scoped>
.panel-toolbar, .section-card { margin-bottom: 16px; }
.panel-actions, .action-group, .card-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel-actions > div:first-child { display: flex; flex-direction: column; gap: 5px; }
.panel-actions small, .card-title small { color: #9198a4; font-weight: normal; }
.metric-card { margin-bottom: 16px; }
.metric-card :deep(.el-card__body) { display: flex; min-height: 112px; flex-direction: column; justify-content: center; gap: 9px; }
.metric-card span { color: #7a8494; font-size: 14px; }
.metric-card strong { color: #202632; font-size: 25px; line-height: 1; }
.metric-card small { font-size: 12px; white-space: nowrap; }
.trend-up { color: #e34d59; } .trend-down { color: #18a058; }
.chart { width: 100%; } .chart-wide { height: 390px; } .region-chart { height: 260px; } .sex-chart { height: 430px; }
@media (max-width: 720px) {
  .panel-actions { align-items: stretch; flex-direction: column; }
  .action-group { align-items: stretch; flex-direction: column; }
  .action-group :deep(.el-select) { width: 100% !important; }
  .chart-wide { height: 330px; } .sex-chart { height: 320px; } .mobile-gap { margin-top: 16px; }
}
</style>
