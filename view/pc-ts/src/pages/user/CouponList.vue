<template>
  <div class="coupon-list container">
    <h2 class="title">我的优惠券</h2>
    <el-tabs v-model="activeTab" @tab-change="load">
      <el-tab-pane label="未使用" name="0" />
      <el-tab-pane label="已使用" name="1" />
      <el-tab-pane label="已过期" name="2" />
    </el-tabs>
    <div v-if="coupons.length" class="coupon-grid">
      <div v-for="coupon in coupons" :key="(coupon as any).id" class="coupon-card">
        <div class="coupon-left">
          <span class="amount">¥{{ (coupon as any).coupon_price }}</span>
          <span class="min">满{{ (coupon as any).use_min_price }}可用</span>
        </div>
        <div class="coupon-right">
          <div class="coupon-name">{{ (coupon as any).coupon_title }}</div>
          <div class="coupon-time">
            {{ (coupon as any).start_time?.slice?.(0, 10) }} ~
            {{ (coupon as any).end_time?.slice?.(0, 10) }}
          </div>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无优惠券" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiMyCoupons } from "@/api/user";

const activeTab = ref("0");
const coupons = ref<unknown[]>([]);

async function load() {
  try {
    coupons.value = await apiMyCoupons(Number(activeTab.value));
  } catch (e) {
    console.error("优惠券加载失败", e);
  }
}

onMounted(load);
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.coupon-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.coupon-card {
  display: flex;
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  min-height: 100px;
}

.coupon-left {
  flex: 0 0 120px;
  background: linear-gradient(135deg, #e64340, #ff7a45);
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.amount {
  font-size: 28px;
  font-weight: 700;
}

.min {
  font-size: 12px;
  opacity: 0.85;
}

.coupon-right {
  flex: 1;
  padding: 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}

.coupon-name {
  font-size: 15px;
}

.coupon-time {
  font-size: 12px;
  color: #999;
}
</style>
