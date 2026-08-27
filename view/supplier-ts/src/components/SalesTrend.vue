<script setup lang="ts">
import { init, use, type ECharts } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DashboardStats } from "@/types";

const props = defineProps<{ trend: DashboardStats["trend"] }>();
const root = ref<HTMLDivElement | null>(null);
use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

let chart: ECharts | null = null;
let resizeObserver: ResizeObserver | null = null;

function render() {
  if (!root.value) return;
  if (!chart) chart = init(root.value, undefined, { renderer: "canvas" });
  chart.setOption({
    animationDuration: 450,
    color: ["#08a6a0", "#3988f7"],
    grid: { left: 16, right: 18, top: 44, bottom: 10, containLabel: true },
    tooltip: { trigger: "axis", backgroundColor: "#0e2344", borderWidth: 0, textStyle: { color: "#fff" } },
    legend: { top: 4, left: 8, itemWidth: 20, itemHeight: 3, textStyle: { color: "#687386", fontSize: 12 } },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: props.trend.map((item) => item.date),
      axisLine: { lineStyle: { color: "#dce3eb" } },
      axisTick: { show: false },
      axisLabel: { color: "#687386", fontSize: 12 },
    },
    yAxis: [
      {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#8792a5", fontSize: 11 },
        splitLine: { lineStyle: { color: "#edf0f4", type: "dashed" } },
      },
      {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#8792a5", fontSize: 11 },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "销售额（元）",
        type: "line",
        smooth: 0.35,
        symbolSize: 6,
        data: props.trend.map((item) => Number(item.sales)),
        lineStyle: { width: 2.5 },
        areaStyle: { color: "rgba(8,166,160,.08)" },
      },
      {
        name: "订单数（单）",
        type: "line",
        yAxisIndex: 1,
        smooth: 0.35,
        symbolSize: 5,
        data: props.trend.map((item) => item.orders),
        lineStyle: { width: 2 },
      },
    ],
  });
}

watch(() => props.trend, () => nextTick(render), { deep: true });

onMounted(() => {
  render();
  if (root.value) {
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(root.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  chart?.dispose();
});
</script>

<template>
  <div ref="root" class="trend-chart" role="img" aria-label="近七日销售额和订单趋势图" />
</template>
