<template>
  <div class="dashboard">
    <!-- 统计卡片 -->
    <el-row :gutter="20">
      <el-col :span="8" v-for="card in cards" :key="card.key">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-title">{{ card.title }}</div>
          <div class="stat-value">{{ card.value }}</div>
          <div class="stat-meta">
            <span>今日: {{ card.today }}</span>
            <span>昨日: {{ card.yesterday }}</span>
            <span class="ratio">环比 {{ card.ratio }}%</span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 待办提醒 -->
    <el-card class="todo-card" shadow="never">
      <template #header>待办提醒</template>
      <el-descriptions :column="3" border>
        <el-descriptions-item label="待发货订单">{{ push.ordernum }}</el-descriptions-item>
        <el-descriptions-item label="库存预警">0</el-descriptions-item>
        <el-descriptions-item label="待审核评论">0</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <!-- 平台总览 (M9 新增) -->
    <el-card class="todo-card" shadow="never" v-if="overview">
      <template #header>平台总览</template>
      <el-row :gutter="20">
        <el-col :span="6">
          <div class="overview-item">
            <div class="overview-val">¥{{ overview.total.sales }}</div>
            <div class="overview-label">累计销售额</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="overview-item">
            <div class="overview-val">{{ overview.total.orderCount }}</div>
            <div class="overview-label">累计订单</div>
          </div>
        </el-col>
        <el-col :span="6">
          <div class="overview-item">
            <div class="overview-val">{{ overview.total.productCount }}</div>
            <div class="overview-label">商品总数</div>
          </div>
        </el-col>
        <el-col :span="6">
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
import { computed, ref, onMounted } from "vue";
import { apiDashboard, apiNewPush } from "@/api/auth";
import { apiAdminStatisticOverview } from "@/api/coupon";
import type { DashboardData } from "@/types/admin";

const data = ref<DashboardData | null>(null);
const push = ref({ ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0 });
const overview = ref<Awaited<ReturnType<typeof apiAdminStatisticOverview>> | null>(null);

const cards = computed(() => {
  if (!data.value) return [];
  return [
    {
      key: "sales",
      title: data.value.sales.title,
      value: `¥${data.value.sales.today}`,
      today: data.value.sales.today,
      yesterday: data.value.sales.yesterday,
      ratio: data.value.sales.today_ratio,
    },
    {
      key: "order",
      title: data.value.order.title,
      value: `${data.value.order.today} 单`,
      today: data.value.order.today,
      yesterday: data.value.order.yesterday,
      ratio: data.value.order.today_ratio,
    },
    {
      key: "user",
      title: data.value.user.title,
      value: `${data.value.user.today} 人`,
      today: data.value.user.today,
      yesterday: data.value.user.yesterday,
      ratio: data.value.user.today_ratio,
    },
  ];
});

onMounted(async () => {
  try {
    data.value = await apiDashboard();
  } catch (e) {
    console.error("Dashboard 加载失败", e);
  }
  try {
    push.value = await apiNewPush();
  } catch {
    // ignore
  }
  try {
    overview.value = await apiAdminStatisticOverview();
  } catch {
    // ignore
  }
});
</script>

<style scoped>
.stat-card {
  text-align: center;
  margin-bottom: 20px;
}

.stat-title {
  color: #999;
  font-size: 14px;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: #333;
  margin: 12px 0;
}

.stat-meta {
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: 13px;
  color: #666;
}

.ratio {
  color: #409eff;
}

.todo-card {
  margin-top: 20px;
}

.overview-item {
  text-align: center;
  padding: 16px 0;
}

.overview-val {
  font-size: 28px;
  font-weight: 700;
  color: #409eff;
}

.overview-label {
  font-size: 13px;
  color: #999;
  margin-top: 8px;
}
</style>
