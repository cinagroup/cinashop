<template>
  <view class="sign-page">
    <!-- 签到头部 -->
    <view class="sign-card">
      <view class="sign-title">每日签到</view>
      <view class="sign-points">我的积分: {{ points }}</view>
      <view class="sign-btn" :class="{ done: signed }" @tap="doSign">
        {{ signed ? "今日已签到" : "立即签到" }}
      </view>
    </view>

    <!-- 签到规则 -->
    <view class="rule-card">
      <view class="rule-title">签到规则</view>
      <view class="rule-item">· 每天签到可获得 {{ signIntegral }} 积分</view>
      <view class="rule-item">· 连续签到奖励更多</view>
      <view class="rule-item">· 积分可在积分商城兑换好物</view>
    </view>

    <view class="go-shop" @tap="goIntegral">去积分商城逛逛 ›</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

const points = ref("0");
const signed = ref(false);
const signIntegral = ref(1);

async function load() {
  try {
    const status = await http.get<{ signedToday?: boolean; isSign?: number; continuousDays: number; integral?: number }>("/sign/status");
    signed.value = status.signedToday === true || status.isSign === 1;
    signIntegral.value = status.integral || 1;
  } catch {
    // 静默
  }
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    points.value = String(info.integral ?? "0");
  } catch {
    // 静默
  }
}

async function doSign() {
  if (signed.value) return uni.showToast({ title: "今日已签到", icon: "none" });
  try {
    await http.post<null>("/sign/integral");
    uni.showToast({ title: `签到成功 +${signIntegral.value} 积分`, icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "签到失败", icon: "none" });
  }
}

function goIntegral() {
  uni.navigateTo({ url: "/pages/user/integral" });
}

onMounted(load);
</script>

<style scoped>
.sign-page {
  padding: 20rpx;
}

.sign-card {
  background: linear-gradient(135deg, #f5a623, #f76b1c);
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
  text-align: center;
  margin-bottom: 20rpx;
}

.sign-title {
  font-size: 34rpx;
  font-weight: 700;
}

.sign-points {
  font-size: 24rpx;
  opacity: 0.9;
  margin: 12rpx 0 30rpx;
}

.sign-btn {
  background: #fff;
  color: #f76b1c;
  font-size: 30rpx;
  font-weight: 600;
  border-radius: 40rpx;
  padding: 18rpx 0;
  width: 300rpx;
  margin: 0 auto;
}

.sign-btn.done {
  background: rgba(255, 255, 255, 0.3);
  color: #fff;
}

.rule-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.rule-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.rule-item {
  font-size: 24rpx;
  color: #666;
  padding: 8rpx 0;
}

.go-shop {
  text-align: center;
  color: #f76b1c;
  font-size: 26rpx;
  padding: 20rpx;
}
</style>
