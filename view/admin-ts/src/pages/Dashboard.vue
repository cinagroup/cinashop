<template>
  <div class="dashboard">
    <el-row :gutter="16">
      <el-col
        v-for="card in cards"
        :key="card.title"
        :xs="24"
        :sm="12"
        :lg="6"
      >
        <el-card shadow="hover" class="stat-card">
          <div class="stat-head">
            <span class="stat-title">{{ card.title }}</span>
            <el-tag size="small" type="success">{{ card.date }}</el-tag>
          </div>
          <div class="stat-value">{{ primaryValue(card) }}</div>
          <div class="stat-meta">
            <span>昨日 {{ card.yesterday }}</span>
            <span :class="Number(card.today_ratio) >= 0 ? 'trend-up' : 'trend-down'">
              环比 {{ card.today_ratio }}%
            </span>
          </div>
          <div class="stat-total">
            <span>{{ card.total_name }}</span>
            <strong>{{ card.total }}</strong>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="section-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>订单趋势</span>
          <el-radio-group v-model="orderCycle" size="small" @change="loadOrderChart">
            <el-radio-button value="thirtyday">30 天</el-radio-button>
            <el-radio-button value="week">周</el-radio-button>
            <el-radio-button value="month">月</el-radio-button>
            <el-radio-button value="year">年</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <div class="comparison" v-if="orderData">
        <span>本期订单 {{ orderData.cycle.count.data }}，较上期 {{ trendText(orderData.cycle.count) }}</span>
        <span>本期金额 ¥{{ orderData.cycle.price.data }}，较上期 {{ trendText(orderData.cycle.price) }}</span>
      </div>
      <div ref="orderChartEl" class="chart chart-wide" v-loading="orderLoading"></div>
    </el-card>

    <el-row :gutter="16" class="section-row">
      <el-col :xs="24" :lg="16">
        <el-card shadow="never">
          <template #header>近 30 天新增用户</template>
          <div ref="userChartEl" class="chart" v-loading="userLoading"></div>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="mobile-gap">
          <template #header>购买用户分层</template>
          <div ref="userPieEl" class="chart" v-loading="userLoading"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="section-card" shadow="never">
      <template #header>待办提醒</template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="待发货订单">{{ push.ordernum }}</el-descriptions-item>
        <el-descriptions-item label="库存预警">{{ push.inventory }}</el-descriptions-item>
        <el-descriptions-item label="待审核评论">{{ push.commentnum }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <el-card class="section-card" shadow="never" v-if="overview">
      <template #header>平台总览</template>
      <el-row :gutter="20">
        <el-col :xs="12" :sm="6">
          <div class="overview-item">
            <div class="overview-val">¥{{ overview.total.sales }}</div>
            <div class="overview-label">累计销售额</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="overview-item">
            <div class="overview-val">{{ overview.total.orderCount }}</div>
            <div class="overview-label">累计订单</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="overview-item">
            <div class="overview-val">{{ overview.total.productCount }}</div>
            <div class="overview-label">商品总数</div>
          </div>
        </el-col>
        <el-col :xs="12" :sm="6">
          <div class="overview-item">
            <div class="overview-val">{{ overview.total.userCount }}</div>
            <div class="overview-label">注册用户</div>
          </div>
        </el-col>
      </el-row>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import * as echarts from "echarts";
import { apiDashboard, apiDashboardOrder, apiDashboardUser, apiNewPush } from "@/api/auth";
import { apiAdminStatisticOverview } from "@/api/coupon";
import type {
  DashboardCycle,
  DashboardData,
  DashboardOrderChart,
  DashboardUserChart,
  StatCard,
} from "@/types/admin";

const data = ref<DashboardData | null>(null);
const orderData = ref<DashboardOrderChart | null>(null);
const userData = ref<DashboardUserChart | null>(null);
const orderCycle = ref<DashboardCycle>("thirtyday");
const orderLoading = ref(false);
const userLoading = ref(false);
const push = ref({ ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0 });
const overview = ref<Awaited<ReturnType<typeof apiAdminStatisticOverview>> | null>(null);
const orderChartEl = ref<HTMLElement>();
const userChartEl = ref<HTMLElement>();
const userPieEl = ref<HTMLElement>();
let orderChart: echarts.ECharts | null = null;
let userChart: echarts.ECharts | null = null;
let userPie: echarts.ECharts | null = null;

const cards = computed(() => data.value?.info ?? []);

function primaryValue(card: StatCard): string {
  if (card.title === "销售额") return `¥${card.today}`;
  const unit = card.title === "订单量" ? " 单" : card.title === "新增用户" ? " 人" : " Pv";
  return `${card.today}${unit}`;
}

function trendText(item: { percent: number; is_plus: -1 | 0 | 1 }): string {
  if (item.is_plus === 0) return "持平";
  return `${item.is_plus > 0 ? "增长" : "下降"} ${item.percent}%`;
}

async function loadOrderChart(): Promise<void> {
  orderLoading.value = true;
  try {
    orderData.value = await apiDashboardOrder(orderCycle.value);
    await nextTick();
    if (!orderChart && orderChartEl.value) orderChart = echarts.init(orderChartEl.value);
    orderChart?.setOption({
      tooltip: { trigger: "axis" },
      legend: { data: orderData.value.legend },
      grid: { left: 55, right: 55, bottom: 35, top: 45 },
      xAxis: { type: "category", data: orderData.value.xAxis },
      yAxis: [
        { type: "value", name: "金额" },
        { type: "value", name: "数量", minInterval: 1 },
      ],
      series: orderData.value.series.map((series, index) => ({
        ...series,
        smooth: series.type === "line",
        symbol: series.type === "line" ? "none" : undefined,
        itemStyle: { color: index % 2 === 0 ? "#409eff" : "#19be6b" },
      })),
    }, true);
  } catch (error) {
    console.error("订单趋势加载失败", error);
  } finally {
    orderLoading.value = false;
  }
}

async function loadUserCharts(): Promise<void> {
  userLoading.value = true;
  try {
    userData.value = await apiDashboardUser();
    await nextTick();
    if (!userChart && userChartEl.value) userChart = echarts.init(userChartEl.value);
    if (!userPie && userPieEl.value) userPie = echarts.init(userPieEl.value);
    userChart?.setOption({
      tooltip: { trigger: "axis" },
      grid: { left: 45, right: 20, bottom: 35, top: 20 },
      xAxis: { type: "category", data: userData.value.xAxis },
      yAxis: { type: "value", minInterval: 1 },
      series: [{
        name: "新增用户",
        type: "line",
        smooth: true,
        symbol: "none",
        areaStyle: { opacity: 0.12 },
        itemStyle: { color: "#409eff" },
        data: userData.value.series,
      }],
    }, true);
    userPie?.setOption({
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [{
        name: "用户分层",
        type: "pie",
        radius: ["42%", "68%"],
        center: ["50%", "44%"],
        data: userData.value.bing_data,
      }],
    }, true);
  } catch (error) {
    console.error("用户统计加载失败", error);
  } finally {
    userLoading.value = false;
  }
}

function resizeCharts(): void {
  orderChart?.resize();
  userChart?.resize();
  userPie?.resize();
}

onMounted(async () => {
  window.addEventListener("resize", resizeCharts);
  await Promise.allSettled([
    apiDashboard().then((result) => { data.value = result; }),
    apiNewPush().then((result) => { push.value = result; }),
    apiAdminStatisticOverview().then((result) => { overview.value = result; }),
    loadOrderChart(),
    loadUserCharts(),
  ]);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resizeCharts);
  orderChart?.dispose();
  userChart?.dispose();
  userPie?.dispose();
});
</script>

<style scoped>
.stat-card {
  margin-bottom: 16px;
}

.stat-head,
.card-head,
.stat-meta,
.stat-total,
.comparison {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.stat-title {
  color: #606266;
  font-size: 14px;
}

.stat-value {
  margin: 18px 0 12px;
  color: #303133;
  font-size: 30px;
  font-weight: 700;
}

.stat-meta {
  justify-content: flex-start;
  color: #909399;
  font-size: 13px;
}

.trend-up {
  color: #e93323;
}

.trend-down {
  color: #19be6b;
}

.stat-total {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #ebeef5;
  color: #606266;
  font-size: 13px;
}

.section-card,
.section-row {
  margin-top: 16px;
}

.comparison {
  justify-content: flex-start;
  margin-bottom: 8px;
  color: #606266;
  font-size: 13px;
}

.chart {
  width: 100%;
  height: 320px;
}

.chart-wide {
  height: 360px;
}

.overview-item {
  padding: 16px 0;
  text-align: center;
}

.overview-val {
  color: #409eff;
  font-size: 28px;
  font-weight: 700;
}

.overview-label {
  margin-top: 8px;
  color: #909399;
  font-size: 13px;
}

@media (max-width: 1199px) {
  .mobile-gap {
    margin-top: 16px;
  }
}

@media (max-width: 767px) {
  .card-head,
  .comparison {
    align-items: flex-start;
    flex-direction: column;
  }

  .chart,
  .chart-wide {
    height: 300px;
  }
}
</style>
