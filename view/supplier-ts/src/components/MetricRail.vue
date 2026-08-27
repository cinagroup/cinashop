<script setup lang="ts">
import { computed } from "vue";
import { Box, Headset, Tickets, Van, Wallet } from "@element-plus/icons-vue";
import type { DashboardStats } from "@/types";

const props = defineProps<{ stats: DashboardStats }>();

function money(value: string) {
  return `¥ ${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const items = computed(() => [
  { label: "今日销售额", value: money(props.stats.today_sales), icon: Wallet, tone: "teal" },
  { label: "今日订单", value: props.stats.today_orders.toLocaleString("zh-CN"), icon: Tickets, tone: "blue" },
  { label: "待发货", value: props.stats.pending_delivery.toLocaleString("zh-CN"), icon: Van, tone: "amber" },
  { label: "商品总数", value: props.stats.product_count.toLocaleString("zh-CN"), icon: Box, tone: "violet" },
  { label: "售后待处理", value: props.stats.refund_count.toLocaleString("zh-CN"), icon: Headset, tone: "red" },
]);
</script>

<template>
  <section class="metric-rail" aria-label="经营指标">
    <article v-for="item in items" :key="item.label" class="metric-item">
      <div class="metric-icon" :class="item.tone"><el-icon><component :is="item.icon" /></el-icon></div>
      <div>
        <div class="metric-label">{{ item.label }}</div>
        <div class="metric-value">{{ item.value }}</div>
      </div>
    </article>
  </section>
</template>
