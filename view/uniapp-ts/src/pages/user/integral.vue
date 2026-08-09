<template>
  <view class="integral-page">
    <!-- 我的积分 -->
    <view class="points-card">
      <view class="points-label">我的积分</view>
      <view class="points-num">{{ points }}</view>
      <view class="points-action" @tap="goSign">✍️ 去签到</view>
    </view>
    <view class="logs-link" @tap="goLogs">📊 积分明细 ›</view>

    <!-- 积分商品 -->
    <view v-if="list.length" class="goods-grid">
      <view v-for="g in list" :key="(g as any).id" class="goods-card">
        <image
          class="goods-image"
          :src="(g as any).image || placeholder"
          mode="aspectFill"
        />
        <view class="goods-info">
          <view class="goods-name">{{ (g as any).storeName }}</view>
          <view class="goods-bottom">
            <view class="integral-price">
              <text class="int-val">{{ (g as any).integral }}</text>
              <text class="int-unit">积分</text>
              <text v-if="Number((g as any).price) > 0" class="cash-price">+¥{{ (g as any).price }}</text>
            </view>
            <view class="exchange-btn" @tap="exchange(g)">兑换</view>
          </view>
          <view class="goods-stock" v-if="Number((g as any).stock) <= 0">已兑完</view>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无积分商品</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

const list = ref<unknown[]>([]);
const points = ref("0");
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function load() {
  try {
    list.value = await http.get<unknown[]>("/store_integral/list", { page: 1, limit: 20 });
  } catch {
    list.value = [];
  }
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    points.value = String(info.integral ?? "0");
  } catch {
    // 未登录静默
  }
}

async function exchange(item: unknown) {
  try {
    const res = await http.post<{ orderId: string }>(`/store_integral/exchange/${(item as any).id}`, { num: 1 });
    uni.showToast({ title: `兑换成功 ${res.orderId}`, icon: "none" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "兑换失败", icon: "none" });
  }
}

function goSign() {
  uni.navigateTo({ url: "/pages/user/sign" });
}

function goLogs() {
  uni.navigateTo({ url: "/pages/user/integralLogs" });
}

onMounted(load);
</script>

<style scoped>
.integral-page {
  padding: 20rpx;
}

.points-card {
  background: linear-gradient(135deg, #f5a623, #f76b1c);
  border-radius: 16rpx;
  padding: 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
  display: flex;
  align-items: center;
}

.points-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.points-num {
  font-size: 48rpx;
  font-weight: 700;
  flex: 1;
  padding-left: 20rpx;
}

.points-action {
  font-size: 24rpx;
  background: rgba(255, 255, 255, 0.2);
  padding: 10rpx 20rpx;
  border-radius: 28rpx;
}

.goods-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
}

.goods-card {
  width: 48%;
  background: #fff;
  border-radius: 12rpx;
  margin-bottom: 20rpx;
  overflow: hidden;
  position: relative;
}

.goods-image {
  width: 100%;
  height: 300rpx;
  background: #f7f7f7;
}

.goods-info {
  padding: 16rpx;
}

.goods-name {
  font-size: 26rpx;
  height: 72rpx;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10rpx;
}

.integral-price {
  display: flex;
  align-items: baseline;
}

.int-val {
  font-size: 32rpx;
  font-weight: 700;
  color: #f76b1c;
}

.int-unit {
  font-size: 20rpx;
  color: #f76b1c;
}

.cash-price {
  font-size: 20rpx;
  color: #999;
  margin-left: 6rpx;
}

.exchange-btn {
  background: #f76b1c;
  color: #fff;
  font-size: 24rpx;
  padding: 8rpx 20rpx;
  border-radius: 26rpx;
}

.goods-stock {
  position: absolute;
  top: 120rpx;
  left: 0;
  right: 0;
  text-align: center;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 26rpx;
  padding: 10rpx 0;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.logs-link {
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  color: #666;
  margin-bottom: 20rpx;
}
</style>
