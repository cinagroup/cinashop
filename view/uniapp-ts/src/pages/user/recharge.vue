<template>
  <view class="recharge-page">
    <!-- 当前余额 -->
    <view class="balance-card">
      <view class="balance-label">当前余额 (元)</view>
      <view class="balance-num">{{ balance }}</view>
      <view class="logs-link" @tap="goLogs">📊 明细 ›</view>
    </view>

    <!-- 金额选择 -->
    <view class="amount-card">
      <view class="amount-title">选择充值金额</view>
      <view class="amount-grid">
        <view
          v-for="amt in amounts"
          :key="amt"
          class="amount-item"
          :class="{ active: selected === amt }"
          @tap="selected = amt"
        >
          ¥{{ amt }}
        </view>
      </view>
    </view>

    <view class="recharge-btn" @tap="submit">立即充值 ¥{{ selected }}</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

const balance = ref("0.00");
const amounts = ref<number[]>([50, 100, 200, 500, 1000]);
const selected = ref(100);

async function loadBalance() {
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    balance.value = String(info.now_money ?? "0.00");
  } catch {
    // 静默
  }
}

async function loadPackages() {
  try {
    const idx = (await http.get<unknown[]>("/recharge/index")) as { price: string }[];
    if (Array.isArray(idx) && idx.length) {
      const list = idx.map((i) => Number(i.price)).filter((n) => n > 0);
      if (list.length) {
        amounts.value = list;
        selected.value = list[0];
      }
    }
  } catch {
    // 使用默认金额
  }
}

async function submit() {
  try {
    const res = await http.post<{ orderId: string }>("/recharge/recharge", { price: selected.value, channel: "h5" });
    uni.showToast({ title: `充值订单 ${res.orderId} 已创建`, icon: "none" });
    loadBalance();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "充值失败", icon: "none" });
  }
}

function goLogs() {
  uni.navigateTo({ url: "/pages/user/balanceLogs" });
}

onMounted(() => {
  loadPackages();
  loadBalance();
});
</script>

<style scoped>
.recharge-page {
  padding: 20rpx;
}

.balance-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.balance-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.balance-num {
  font-size: 56rpx;
  font-weight: 700;
  margin-top: 10rpx;
}

.amount-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.amount-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.amount-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.amount-item {
  width: calc(33.33% - 11rpx);
  text-align: center;
  padding: 24rpx 0;
  border: 2rpx solid #eee;
  border-radius: 12rpx;
  font-size: 30rpx;
  font-weight: 600;
  color: #333;
  box-sizing: border-box;
}

.amount-item.active {
  border-color: #e93323;
  color: #e93323;
  background: #fff5f5;
}

.recharge-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 44rpx;
  padding: 24rpx 0;
  font-size: 30rpx;
  font-weight: 600;
  margin-top: 30rpx;
}
</style>
