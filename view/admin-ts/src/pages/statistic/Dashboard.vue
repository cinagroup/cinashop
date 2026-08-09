<template>
  <div class="stats-page">
    <el-row :gutter="16">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>销售趋势</span>
              <el-radio-group v-model="days" size="small" @change="loadTrend">
                <el-radio-button :value="7">近7天</el-radio-button>
                <el-radio-button :value="30">近30天</el-radio-button>
              </el-radio-group>
            </div>
          </template>
          <div ref="trendChart" class="chart-box" v-loading="trendLoading"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px;">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>商品销量 TOP 10</template>
          <el-table :data="rankList" v-loading="rankLoading" border>
            <el-table-column type="index" label="排名" width="70" />
            <el-table-column prop="productId" label="商品ID" width="90" />
            <el-table-column prop="name" label="商品名称" min-width="200" show-overflow-tooltip />
            <el-table-column prop="salesCount" label="销量" width="100" sortable />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, onBeforeUnmount } from "vue";
import * as echarts from "echarts";
import request, { getData } from "@/utils/request";

const days = ref(7);
const trendChart = ref<HTMLElement>();
const trendLoading = ref(false);
const rankLoading = ref(false);
const rankList = ref<{ productId: number; name: string; salesCount: number }[]>([]);
let chart: echarts.ECharts | null = null;

async function loadTrend() {
  trendLoading.value = true;
  try {
    const data = await getData(
      request.get<{ date: string; orderCount: number; sales: number }[]>("/statistic/trend", {
        params: { days: days.value },
      }),
    );
    const trendData: { date: string; orderCount: number; sales: number }[] = (data || []) as any;
    await nextTick();
    if (!chart && trendChart.value) chart = echarts.init(trendChart.value);
    if (chart) {
      chart.setOption({
        tooltip: { trigger: "axis" },
        legend: { data: ["销售额(¥)", "订单数"] },
        grid: { left: 50, right: 50, bottom: 30, top: 40 },
        xAxis: { type: "category", data: trendData.map((d) => d.date.slice(5)) },
        yAxis: [
          { type: "value", name: "销售额" },
          { type: "value", name: "订单数" },
        ],
        series: [
          {
            name: "销售额(¥)",
            type: "line",
            smooth: true,
            areaStyle: { opacity: 0.1 },
            itemStyle: { color: "#e93323" },
            data: trendData.map((d) => d.sales),
          },
          {
            name: "订单数",
            type: "bar",
            yAxisIndex: 1,
            itemStyle: { color: "#409eff" },
            data: trendData.map((d) => d.orderCount),
          },
        ],
      });
    }
  } catch {
    // ignore
  } finally {
    trendLoading.value = false;
  }
}

async function loadRank() {
  rankLoading.value = true;
  try {
    rankList.value = await getData(
      request.get<{ productId: number; name: string; salesCount: number }[]>("/statistic/rank", {
        params: { limit: 10 },
      }),
    );
  } catch {
    rankList.value = [];
  } finally {
    rankLoading.value = false;
  }
}

function handleResize() {
  chart?.resize();
}

onMounted(() => {
  loadTrend();
  loadRank();
  window.addEventListener("resize", handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  chart?.dispose();
});
</script>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chart-box {
  width: 100%;
  height: 340px;
}
</style>
