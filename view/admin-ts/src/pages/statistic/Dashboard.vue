<template>
  <div class="stats-page">
    <el-card shadow="never" class="filter-card">
      <div class="toolbar">
        <el-tabs v-model="activeTab" class="domain-tabs" @tab-change="handleTabChange">
          <el-tab-pane label="订单统计" name="order" />
          <el-tab-pane label="商品统计" name="product" />
          <el-tab-pane label="用户统计" name="user" />
          <el-tab-pane label="交易统计" name="trade" />
          <el-tab-pane label="余额统计" name="balance" />
        </el-tabs>
        <div class="filters">
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            value-format="YYYY/MM/DD"
            format="YYYY/MM/DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            :clearable="false"
          />
          <el-button v-if="activeTab === 'product'" :loading="exportLoading" @click="exportProduct">导出 CSV</el-button>
          <el-button type="primary" :loading="activeLoading" @click="loadActive">查询</el-button>
        </div>
      </div>
    </el-card>

    <section v-show="activeTab === 'order'" aria-label="订单统计">
      <el-row :gutter="16">
        <el-col v-for="card in orderCards" :key="card.key" :xs="24" :sm="12" :lg="8" :xl="4">
          <el-card shadow="never" class="metric-card">
            <span>{{ card.label }}</span>
            <strong>{{ formatOrderValue(card.key, orderBasic?.[card.key]) }}</strong>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="section-card">
        <template #header>
          <div class="card-title"><span>营业趋势</span><small>东八区 · {{ queryRange }}</small></div>
        </template>
        <div ref="orderTrendEl" class="chart chart-wide" v-loading="orderLoading"></div>
      </el-card>

      <el-row :gutter="16" class="distribution-row">
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="distribution-card">
            <template #header>订单来源分析</template>
            <div class="distribution-layout">
              <div ref="orderChannelEl" class="chart chart-pie" v-loading="orderLoading"></div>
              <el-table :data="orderChannel?.list ?? []" size="small" max-height="300">
                <el-table-column prop="name" label="来源" min-width="84" />
                <el-table-column prop="value" label="订单量" width="82" />
                <el-table-column label="占比" width="82">
                  <template #default="scope">{{ scope.row.percent }}%</template>
                </el-table-column>
              </el-table>
            </div>
          </el-card>
        </el-col>
        <el-col :xs="24" :lg="12">
          <el-card shadow="never" class="distribution-card mobile-gap">
            <template #header>订单类型分析</template>
            <div class="distribution-layout">
              <div ref="orderTypeEl" class="chart chart-pie" v-loading="orderLoading"></div>
              <el-table :data="orderType?.list ?? []" size="small" max-height="300">
                <el-table-column prop="name" label="类型" min-width="96" />
                <el-table-column label="金额" width="90">
                  <template #default="scope">¥{{ Number(scope.row.value).toFixed(2) }}</template>
                </el-table-column>
                <el-table-column label="占比" width="82">
                  <template #default="scope">{{ scope.row.percent }}%</template>
                </el-table-column>
              </el-table>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </section>

    <section v-show="activeTab === 'product'" aria-label="商品统计">
      <el-row :gutter="16">
        <el-col v-for="card in productCards" :key="card.key" :xs="24" :sm="12" :lg="6" :xl="6">
          <el-card shadow="never" class="metric-card product-metric">
            <span>{{ card.label }}</span>
            <strong>{{ formatProductValue(card.key, productBasic?.[card.key]?.num) }}</strong>
            <small :class="trendClass(productBasic?.[card.key]?.percent)">
              环比 {{ formatPercent(productBasic?.[card.key]?.percent) }}
            </small>
          </el-card>
        </el-col>
      </el-row>

      <el-card shadow="never" class="section-card">
        <template #header>
          <div class="card-title"><span>商品经营趋势</span><small>访问、支付与退款同窗对照</small></div>
        </template>
        <div ref="productTrendEl" class="chart chart-wide" v-loading="productLoading"></div>
      </el-card>

      <el-card shadow="never" class="section-card ranking-card">
        <template #header>
          <div class="card-title ranking-title">
            <span>商品经营排行</span>
            <el-select v-model="rankingSort" style="width: 180px" @change="loadRanking">
              <el-option v-for="item in rankingOptions" :key="item.value" :label="`按${item.label}排序`" :value="item.value" />
            </el-select>
          </div>
        </template>
        <el-table :data="ranking" v-loading="rankingLoading" border>
          <el-table-column type="index" label="排名" width="66" />
          <el-table-column label="商品" min-width="220" fixed="left">
            <template #default="scope">
              <div class="product-cell">
                <el-image :src="scope.row.image" fit="cover" class="product-image" />
                <div><strong>{{ scope.row.store_name }}</strong><small>ID {{ scope.row.product_id }}</small></div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="visit" label="浏览量" width="90" sortable />
          <el-table-column prop="user" label="访客数" width="90" sortable />
          <el-table-column prop="cart" label="加购" width="82" sortable />
          <el-table-column prop="orders" label="下单" width="82" sortable />
          <el-table-column prop="pay" label="支付件数" width="100" sortable />
          <el-table-column label="支付金额" width="112" sortable prop="price">
            <template #default="scope">¥{{ Number(scope.row.price).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="毛利率" width="94" sortable prop="profit">
            <template #default="scope">{{ Number(scope.row.profit).toFixed(2) }}%</template>
          </el-table-column>
          <el-table-column prop="collect" label="收藏" width="82" sortable />
          <el-table-column label="访客转化" width="100" sortable prop="changes">
            <template #default="scope">{{ Number(scope.row.changes).toFixed(2) }}%</template>
          </el-table-column>
          <el-table-column label="状态" width="82" fixed="right">
            <template #default="scope"><el-tag :type="scope.row.is_show ? 'success' : 'info'">{{ scope.row.is_show ? "上架" : "下架" }}</el-tag></template>
          </el-table-column>
        </el-table>
      </el-card>
    </section>

    <UserStatisticsPanel
      v-if="activeTab === 'user'"
      :range="queryRange"
      :reload-key="reloadKey"
    />
    <TradeStatisticsPanel
      v-if="activeTab === 'trade'"
      :range="queryRange"
      :reload-key="reloadKey"
    />
    <BalanceStatisticsPanel
      v-if="activeTab === 'balance'"
      :range="queryRange"
      :reload-key="reloadKey"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import * as echarts from "echarts";
import {
  apiOrderStatisticBasic,
  apiOrderStatisticChannel,
  apiOrderStatisticTrend,
  apiOrderStatisticType,
  apiProductStatisticBasic,
  apiProductStatisticExport,
  apiProductStatisticRanking,
  apiProductStatisticTrend,
  type OrderStatisticBasic,
  type ProductRankingRow,
  type ProductRankingSort,
  type ProductStatisticBasic,
  type StatisticDistribution,
  type StatisticTrend,
} from "@/api/statistic";
import UserStatisticsPanel from "./components/UserStatisticsPanel.vue";
import TradeStatisticsPanel from "./components/TradeStatisticsPanel.vue";
import BalanceStatisticsPanel from "./components/BalanceStatisticsPanel.vue";

type OrderMetricKey = keyof OrderStatisticBasic;
type ProductMetricKey = keyof ProductStatisticBasic;

function formatDate(date: Date): string {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function defaultDates(): [string, string] {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return [formatDate(start), formatDate(end)];
}

const activeTab = ref<"order" | "product" | "user" | "trade" | "balance">("order");
const dateRange = ref<[string, string]>(defaultDates());
const reloadKey = ref(0);
const orderLoading = ref(false);
const productLoading = ref(false);
const rankingLoading = ref(false);
const exportLoading = ref(false);
const orderBasic = ref<OrderStatisticBasic | null>(null);
const orderTrend = ref<StatisticTrend | null>(null);
const orderChannel = ref<StatisticDistribution | null>(null);
const orderType = ref<StatisticDistribution | null>(null);
const productBasic = ref<ProductStatisticBasic | null>(null);
const productTrend = ref<StatisticTrend | null>(null);
const ranking = ref<ProductRankingRow[]>([]);
const rankingSort = ref<ProductRankingSort>("visit");

const orderTrendEl = ref<HTMLElement>();
const orderChannelEl = ref<HTMLElement>();
const orderTypeEl = ref<HTMLElement>();
const productTrendEl = ref<HTMLElement>();
let orderTrendChart: echarts.ECharts | null = null;
let orderChannelChart: echarts.ECharts | null = null;
let orderTypeChart: echarts.ECharts | null = null;
let productTrendChart: echarts.ECharts | null = null;

const queryRange = computed(() => `${dateRange.value[0]}-${dateRange.value[1]}`);
const activeLoading = computed(() => {
  if (activeTab.value === "order") return orderLoading.value;
  if (activeTab.value === "product") return productLoading.value;
  return false;
});

const orderCards: Array<{ key: OrderMetricKey; label: string }> = [
  { key: "pay_count", label: "支付订单数" },
  { key: "pay_price", label: "实付金额" },
  { key: "refund_count", label: "退款订单量" },
  { key: "refund_price", label: "退款金额" },
  { key: "coupon_price", label: "用券金额" },
  { key: "coupon_count", label: "用券数量" },
];

const productCards: Array<{ key: ProductMetricKey; label: string }> = [
  { key: "browse", label: "商品浏览量" },
  { key: "user", label: "商品访客数" },
  { key: "cart", label: "加购件数" },
  { key: "order", label: "下单件数" },
  { key: "pay", label: "支付件数" },
  { key: "payPrice", label: "支付金额" },
  { key: "cost", label: "成本金额" },
  { key: "refundPrice", label: "退款金额" },
  { key: "refund", label: "退款件数" },
  { key: "payPercent", label: "访客付款转化率" },
];

const rankingOptions: Array<{ value: ProductRankingSort; label: string }> = [
  { value: "visit", label: "浏览量" },
  { value: "user", label: "访客数" },
  { value: "cart", label: "加购件数" },
  { value: "orders", label: "下单件数" },
  { value: "pay", label: "支付件数" },
  { value: "price", label: "支付金额" },
  { value: "profit", label: "毛利率" },
  { value: "collect", label: "收藏数" },
  { value: "changes", label: "访客转化率" },
];

function formatOrderValue(key: OrderMetricKey, value: string | number | undefined): string {
  if (key.endsWith("price")) return `¥${Number(value ?? 0).toFixed(2)}`;
  return String(value ?? 0);
}

function formatProductValue(key: ProductMetricKey, value: number | undefined): string {
  if (key === "payPrice" || key === "cost" || key === "refundPrice") return `¥${Number(value ?? 0).toFixed(2)}`;
  if (key === "payPercent") return `${Number(value ?? 0).toFixed(2)}%`;
  return String(value ?? 0);
}

function formatPercent(value: number | undefined): string {
  const numeric = Number(value ?? 0);
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function trendClass(value: number | undefined): string {
  return Number(value ?? 0) >= 0 ? "trend-up" : "trend-down";
}

function setTrendOption(chart: echarts.ECharts, data: StatisticTrend, dualAxis: boolean): void {
  chart.setOption({
    tooltip: { trigger: "axis" },
    legend: { type: "scroll", data: data.series.map((item) => item.name) },
    grid: { left: 58, right: dualAxis ? 58 : 28, bottom: 42, top: 58 },
    xAxis: { type: "category", data: data.xAxis, axisLabel: { hideOverlap: true } },
    yAxis: dualAxis
      ? [{ type: "value", name: "金额" }, { type: "value", name: "数量", minInterval: 1 }]
      : [{ type: "value" }],
    series: data.series.map((item) => ({
      ...item,
      smooth: item.smooth === "true" || item.type === "line",
      symbol: item.type === "line" ? "none" : undefined,
      yAxisIndex: item.yAxisIndex ?? (dualAxis && ["订单量", "退款订单量", "用券数量"].includes(item.name) ? 1 : 0),
    })),
  }, true);
}

function setPieOption(chart: echarts.ECharts, data: StatisticDistribution): void {
  chart.setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { type: "scroll", bottom: 0, data: data.bing_xdata },
    series: [{ type: "pie", radius: ["38%", "67%"], center: ["50%", "43%"], data: data.bing_data }],
  }, true);
}

async function renderOrder(): Promise<void> {
  await nextTick();
  if (orderTrendEl.value && orderTrend.value) {
    orderTrendChart ??= echarts.init(orderTrendEl.value);
    setTrendOption(orderTrendChart, orderTrend.value, true);
  }
  if (orderChannelEl.value && orderChannel.value) {
    orderChannelChart ??= echarts.init(orderChannelEl.value);
    setPieOption(orderChannelChart, orderChannel.value);
  }
  if (orderTypeEl.value && orderType.value) {
    orderTypeChart ??= echarts.init(orderTypeEl.value);
    setPieOption(orderTypeChart, orderType.value);
  }
}

async function renderProduct(): Promise<void> {
  await nextTick();
  if (productTrendEl.value && productTrend.value) {
    productTrendChart ??= echarts.init(productTrendEl.value);
    setTrendOption(productTrendChart, productTrend.value, true);
  }
}

async function loadOrder(): Promise<void> {
  orderLoading.value = true;
  try {
    [orderBasic.value, orderTrend.value, orderChannel.value, orderType.value] = await Promise.all([
      apiOrderStatisticBasic(queryRange.value),
      apiOrderStatisticTrend(queryRange.value),
      apiOrderStatisticChannel(queryRange.value),
      apiOrderStatisticType(queryRange.value),
    ]);
    await renderOrder();
  } catch (error) {
    ElMessage.error((error as Error).message || "订单统计加载失败");
  } finally {
    orderLoading.value = false;
  }
}

async function loadRanking(): Promise<void> {
  rankingLoading.value = true;
  try {
    ranking.value = await apiProductStatisticRanking(queryRange.value, rankingSort.value, 20);
  } catch (error) {
    ElMessage.error((error as Error).message || "商品排行加载失败");
  } finally {
    rankingLoading.value = false;
  }
}

async function loadProduct(): Promise<void> {
  productLoading.value = true;
  try {
    [productBasic.value, productTrend.value] = await Promise.all([
      apiProductStatisticBasic(queryRange.value),
      apiProductStatisticTrend(queryRange.value),
    ]);
    await Promise.all([renderProduct(), loadRanking()]);
  } catch (error) {
    ElMessage.error((error as Error).message || "商品统计加载失败");
  } finally {
    productLoading.value = false;
  }
}

function downloadCsv(metadata: Awaited<ReturnType<typeof apiProductStatisticExport>>): void {
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = metadata.export.map((row) => metadata.filekey.map((key) => row[key] ?? ""));
  const csv = [metadata.header, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${metadata.filename}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportProduct(): Promise<void> {
  exportLoading.value = true;
  try {
    downloadCsv(await apiProductStatisticExport(queryRange.value));
  } catch (error) {
    ElMessage.error((error as Error).message || "商品统计导出失败");
  } finally {
    exportLoading.value = false;
  }
}

async function loadActive(): Promise<void> {
  if (activeTab.value === "order") await loadOrder();
  else if (activeTab.value === "product") await loadProduct();
  else reloadKey.value += 1;
}

async function handleTabChange(): Promise<void> {
  await nextTick();
  if (activeTab.value === "order") {
    if (orderBasic.value) resizeCharts();
    else await loadOrder();
  } else if (activeTab.value === "product" && productBasic.value) {
    resizeCharts();
  } else if (activeTab.value === "product") {
    await loadProduct();
  }
}

function resizeCharts(): void {
  orderTrendChart?.resize();
  orderChannelChart?.resize();
  orderTypeChart?.resize();
  productTrendChart?.resize();
}

onMounted(async () => {
  window.addEventListener("resize", resizeCharts);
  await loadOrder();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resizeCharts);
  orderTrendChart?.dispose();
  orderChannelChart?.dispose();
  orderTypeChart?.dispose();
  productTrendChart?.dispose();
});
</script>

<style scoped>
.stats-page { min-width: 0; }
.filter-card { margin-bottom: 16px; }
.toolbar, .card-title, .ranking-title, .filters, .product-cell { display: flex; align-items: center; }
.toolbar { justify-content: space-between; gap: 20px; }
.domain-tabs { min-width: 500px; }
.domain-tabs :deep(.el-tabs__header) { margin: 0; }
.filters { gap: 10px; }
.metric-card { margin-bottom: 16px; }
.metric-card :deep(.el-card__body) { display: flex; min-height: 102px; flex-direction: column; justify-content: center; gap: 10px; }
.metric-card span { color: #7a8494; font-size: 14px; }
.metric-card strong { color: #202632; font-size: 27px; line-height: 1; }
.product-metric small { font-size: 12px; }
.trend-up { color: #e34d59; }
.trend-down { color: #18a058; }
.section-card { margin-bottom: 16px; }
.card-title { justify-content: space-between; gap: 12px; }
.card-title small { color: #9198a4; font-weight: normal; }
.chart { width: 100%; }
.chart-wide { height: 390px; }
.chart-pie { min-width: 260px; height: 300px; }
.distribution-row { margin-bottom: 16px; }
.distribution-card { height: 100%; }
.distribution-layout { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(245px, .9fr); align-items: center; gap: 8px; }
.ranking-title { width: 100%; }
.product-cell { gap: 10px; min-width: 0; }
.product-image { width: 46px; height: 46px; flex: 0 0 auto; border-radius: 6px; background: #f3f5f8; }
.product-cell div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.product-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.product-cell small { color: #98a0ad; }

@media (max-width: 1100px) {
  .distribution-layout { grid-template-columns: 1fr; }
  .chart-pie { min-width: 0; }
}

@media (max-width: 720px) {
  .toolbar { align-items: stretch; flex-direction: column; }
  .filters { align-items: stretch; flex-direction: column; }
  .filters :deep(.el-date-editor) { width: 100%; }
  .domain-tabs { min-width: 0; }
  .metric-card strong { font-size: 24px; }
  .chart-wide { height: 330px; }
  .mobile-gap { margin-top: 16px; }
  .card-title { align-items: flex-start; flex-direction: column; }
  .ranking-title :deep(.el-select) { width: 100% !important; }
}
</style>
