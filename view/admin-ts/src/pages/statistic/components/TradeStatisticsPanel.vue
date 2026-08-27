<template>
  <section aria-label="交易统计" v-loading="loading">
    <el-card shadow="never" class="section-card">
      <template #header><div class="card-title"><span>今日交易</span><small>东八区 · 与昨日同期口径对照</small></div></template>
      <el-row :gutter="16">
        <el-col :xs="24" :lg="12">
          <div class="today-total"><span>今日营业额</span><strong>¥{{ Number(top?.left.series[0]?.money ?? 0).toFixed(2) }}</strong></div>
          <div ref="todayEl" class="chart today-chart"></div>
        </el-col>
        <el-col :xs="24" :lg="12">
          <div class="pulse-grid">
            <article v-for="pulse in pulses" :key="pulse.name">
              <span>{{ pulse.name }}</span><strong>{{ pulse.now_money }}</strong>
              <small>上期 {{ pulse.last_money }} · <i :class="trendClass(pulse.rate)">{{ formatPercent(pulse.rate) }}</i></small>
            </article>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-card shadow="never" class="section-card">
      <template #header><div class="card-title"><span>交易概况</span><el-button @click="downloadTrade">导出 CSV</el-button></div></template>
      <el-row :gutter="16">
        <el-col v-for="item in bottom?.series ?? []" :key="item.name" :xs="24" :sm="12" :lg="6" :xl="5">
          <el-tooltip :content="item.desc" placement="top">
            <article class="trade-card"><span>{{ item.name }}</span><strong>¥{{ Number(item.money).toFixed(2) }}</strong><small :class="trendClass(item.rate)">环比 {{ formatPercent(item.rate) }}</small></article>
          </el-tooltip>
        </el-col>
      </el-row>
      <div ref="bottomEl" class="chart bottom-chart"></div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import * as echarts from "echarts";
import { apiTradeStatisticBottom, apiTradeStatisticTop, type TradeBottom, type TradeTop } from "@/api/statistic";

const props = defineProps<{ range: string; reloadKey: number }>();
const loading = ref(false);
const top = ref<TradeTop | null>(null);
const bottom = ref<TradeBottom | null>(null);
const todayEl = ref<HTMLElement>();
const bottomEl = ref<HTMLElement>();
let todayChart: echarts.ECharts | null = null;
let bottomChart: echarts.ECharts | null = null;
const pulses = computed(() => [...(top.value?.right.today.series ?? []), ...(top.value?.right.month ?? [])]);
function formatPercent(value: number): string { return `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}%`; }
function trendClass(value: number): string { return Number(value) >= 0 ? "trend-up" : "trend-down"; }

async function render(): Promise<void> {
  await nextTick();
  if (todayEl.value && top.value) {
    todayChart ??= echarts.init(todayEl.value);
    todayChart.setOption({
      tooltip: { trigger: "axis" }, legend: { data: ["今天", "昨天"] }, grid: { left: 55, right: 22, top: 48, bottom: 38 },
      xAxis: { type: "category", data: top.value.left.x }, yAxis: { type: "value" },
      series: [
        { name: "今天", type: "line", smooth: true, symbol: "none", areaStyle: { opacity: .12 }, data: top.value.left.series[0]?.value ?? [] },
        { name: "昨天", type: "line", smooth: true, symbol: "none", data: top.value.left.series[1]?.value ?? [] },
      ],
    }, true);
  }
  if (bottomEl.value && bottom.value) {
    bottomChart ??= echarts.init(bottomEl.value);
    const series = bottom.value.series.filter((item) => item.type === 1);
    bottomChart.setOption({
      tooltip: { trigger: "axis" }, legend: { type: "scroll", data: series.map((item) => item.name) },
      grid: { left: 58, right: 28, top: 58, bottom: 42 }, xAxis: { type: "category", data: bottom.value.x, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value" }, series: series.map((item) => ({ name: item.name, type: "line", smooth: true, symbol: "none", data: item.value })),
    }, true);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try { [top.value, bottom.value] = await Promise.all([apiTradeStatisticTop(), apiTradeStatisticBottom(props.range)]); await render(); }
  catch (error) { ElMessage.error((error as Error).message || "交易统计加载失败"); }
  finally { loading.value = false; }
}

function downloadTrade(): void {
  if (!bottom.value?.export) return;
  const link = document.createElement("a"); link.href = bottom.value.export; link.download = "交易统计.csv";
  document.body.append(link); link.click(); link.remove();
}
function resize(): void { todayChart?.resize(); bottomChart?.resize(); }
watch(() => props.reloadKey, load, { immediate: true });
window.addEventListener("resize", resize);
onBeforeUnmount(() => { window.removeEventListener("resize", resize); todayChart?.dispose(); bottomChart?.dispose(); });
</script>

<style scoped>
.section-card { margin-bottom: 16px; }
.card-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-title small { color: #9198a4; font-weight: normal; }
.today-total { display: flex; flex-direction: column; gap: 8px; padding: 4px 8px; }
.today-total span, .trade-card span, .pulse-grid span { color: #7a8494; font-size: 14px; }
.today-total strong { font-size: 30px; }
.chart { width: 100%; } .today-chart { height: 280px; } .bottom-chart { height: 410px; margin-top: 8px; }
.pulse-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; height: 100%; align-content: center; }
.pulse-grid article, .trade-card { display: flex; flex-direction: column; gap: 9px; border: 1px solid #edf0f4; border-radius: 8px; padding: 18px; }
.pulse-grid strong, .trade-card strong { color: #202632; font-size: 24px; }
.pulse-grid small, .trade-card small { color: #8c95a3; font-size: 12px; font-style: normal; }
.trade-card { min-height: 92px; margin-bottom: 16px; }
.trend-up { color: #e34d59 !important; } .trend-down { color: #18a058 !important; }
@media (max-width: 720px) {
  .pulse-grid { grid-template-columns: 1fr; } .bottom-chart { height: 340px; }
  .card-title { align-items: flex-start; flex-direction: column; }
}
</style>
