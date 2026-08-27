<template>
  <section aria-label="余额统计" v-loading="loading">
    <el-row :gutter="16">
      <el-col v-for="card in cards" :key="card.key" :xs="24" :sm="8">
        <el-card shadow="never" class="balance-card"><span>{{ card.label }}</span><strong>¥{{ Number(basic?.[card.key] ?? 0).toFixed(2) }}</strong><small>{{ card.desc }}</small></el-card>
      </el-col>
    </el-row>
    <el-card shadow="never" class="section-card">
      <template #header><div class="card-title"><span>余额变化趋势</span><small>仅统计有效流水</small></div></template>
      <div ref="trendEl" class="chart trend-chart"></div>
    </el-card>
    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="section-card"><template #header>余额来源</template><div class="distribution"><div ref="channelEl" class="chart pie-chart"></div><el-table :data="channel?.list ?? []" size="small"><el-table-column prop="name" label="来源" /><el-table-column prop="value" label="金额" /><el-table-column label="占比"><template #default="scope">{{ scope.row.percent }}%</template></el-table-column></el-table></div></el-card>
      </el-col>
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="section-card mobile-gap"><template #header>余额消耗</template><div class="distribution"><div ref="typeEl" class="chart pie-chart"></div><el-table :data="type?.list ?? []" size="small"><el-table-column prop="name" label="类型" /><el-table-column prop="value" label="金额" /><el-table-column label="占比"><template #default="scope">{{ scope.row.percent }}%</template></el-table-column></el-table></div></el-card>
      </el-col>
    </el-row>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import * as echarts from "echarts";
import {
  apiBalanceStatisticBasic, apiBalanceStatisticChannel, apiBalanceStatisticTrend, apiBalanceStatisticType,
  type BalanceStatisticBasic, type StatisticDistribution, type StatisticTrend,
} from "@/api/statistic";

const props = defineProps<{ range: string; reloadKey: number }>();
const loading = ref(false);
const basic = ref<BalanceStatisticBasic | null>(null);
const trend = ref<StatisticTrend | null>(null);
const channel = ref<StatisticDistribution | null>(null);
const type = ref<StatisticDistribution | null>(null);
const trendEl = ref<HTMLElement>(); const channelEl = ref<HTMLElement>(); const typeEl = ref<HTMLElement>();
let trendChart: echarts.ECharts | null = null; let channelChart: echarts.ECharts | null = null; let typeChart: echarts.ECharts | null = null;
const cards: Array<{ key: keyof BalanceStatisticBasic; label: string; desc: string }> = [
  { key: "now_balance", label: "当前用户余额", desc: "有效用户当前余额合计" },
  { key: "add_balance", label: "累计增加余额", desc: "有效收入流水生命周期累计" },
  { key: "sub_balance", label: "累计消耗余额", desc: "有效支出流水生命周期累计" },
];
function pie(chart: echarts.ECharts, data: StatisticDistribution): void {
  chart.setOption({ tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" }, legend: { bottom: 0 }, series: [{ type: "pie", radius: ["40%", "68%"], data: data.bing_data }] }, true);
}
async function render(): Promise<void> {
  await nextTick();
  if (trendEl.value && trend.value) {
    trendChart ??= echarts.init(trendEl.value);
    trendChart.setOption({ tooltip: { trigger: "axis" }, legend: { data: trend.value.series.map((item) => item.name) }, grid: { left: 58, right: 28, top: 55, bottom: 42 }, xAxis: { type: "category", data: trend.value.xAxis }, yAxis: { type: "value" }, series: trend.value.series.map((item) => ({ ...item, smooth: true, symbol: "none" })) }, true);
  }
  if (channelEl.value && channel.value) { channelChart ??= echarts.init(channelEl.value); pie(channelChart, channel.value); }
  if (typeEl.value && type.value) { typeChart ??= echarts.init(typeEl.value); pie(typeChart, type.value); }
}
async function load(): Promise<void> {
  loading.value = true;
  try { [basic.value, trend.value, channel.value, type.value] = await Promise.all([apiBalanceStatisticBasic(), apiBalanceStatisticTrend(props.range), apiBalanceStatisticChannel(props.range), apiBalanceStatisticType(props.range)]); await render(); }
  catch (error) { ElMessage.error((error as Error).message || "余额统计加载失败"); }
  finally { loading.value = false; }
}
function resize(): void { trendChart?.resize(); channelChart?.resize(); typeChart?.resize(); }
watch(() => props.reloadKey, load, { immediate: true });
window.addEventListener("resize", resize);
onBeforeUnmount(() => { window.removeEventListener("resize", resize); trendChart?.dispose(); channelChart?.dispose(); typeChart?.dispose(); });
</script>

<style scoped>
.balance-card, .section-card { margin-bottom: 16px; }
.balance-card :deep(.el-card__body) { display: flex; min-height: 118px; flex-direction: column; justify-content: center; gap: 10px; }
.balance-card span { color: #7a8494; } .balance-card strong { color: #202632; font-size: 28px; } .balance-card small, .card-title small { color: #9198a4; }
.card-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.chart { width: 100%; } .trend-chart { height: 390px; } .pie-chart { height: 300px; }
.distribution { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(240px, .9fr); align-items: center; gap: 10px; }
@media (max-width: 1100px) { .distribution { grid-template-columns: 1fr; } }
@media (max-width: 720px) { .trend-chart { height: 330px; } .mobile-gap { margin-top: 16px; } }
</style>
