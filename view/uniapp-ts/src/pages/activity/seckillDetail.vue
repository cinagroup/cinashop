<template>
  <view class="seckill-detail">
    <view v-if="info">
      <!-- 商品图 -->
      <image class="goods-img" :src="info.image || placeholder" mode="aspectFill" />

      <!-- 价格区 -->
      <view class="price-section">
        <view class="price-row">
          <text class="price">¥{{ info.price }}</text>
          <text class="ot-price">¥{{ info.otPrice }}</text>
          <text class="limit-tag">限购 {{ info.num }} 件</text>
        </view>
        <view class="meta-row">
          <text>已抢 {{ info.sales }}</text>
          <text v-if="info.quotaShow > 0">剩余 {{ info.quota }}</text>
        </view>
        <!-- 库存进度 -->
        <view class="progress-wrap" v-if="info.quotaShow > 0">
          <view class="progress-bar">
            <view class="progress-fill" :style="{ width: progressPercent + '%' }" />
          </view>
        </view>
      </view>

      <!-- 商品信息 -->
      <view class="info-section">
        <view class="goods-name">{{ info.storeName }}</view>
      </view>

      <!-- 底部操作栏 -->
      <view class="action-bar">
        <view class="action-btn" @tap="goDetail">
          <text class="action-icon">🔍</text>
          <text class="action-text">查看详情</text>
        </view>
        <view class="buy-btn" @tap="buyNow">立即抢购 ¥{{ info.price }}</view>
      </view>
    </view>
    <view v-else class="empty">秒杀商品不存在或已结束</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";
import { apiCartAdd } from "@/api/order";
import { useAuthStore } from "@/stores/auth";

const info = ref<any>(null);
const authStore = useAuthStore();
const seckillId = ref(0);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const progressPercent = computed(() => {
  if (!info.value || info.value.quotaShow <= 0) return 0;
  return Math.min(
    100,
    Math.round(((info.value.quotaShow - info.value.quota) / info.value.quotaShow) * 100),
  );
});

async function load(id: number) {
  try {
    info.value = await http.get<any>(`/seckill/detail/${id}`);
  } catch {
    info.value = null;
  }
}

function goDetail() {
  if (!info.value) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${info.value.productId}` });
}

async function buyNow() {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  if (!info.value) return;
  try {
    // 秒杀活动加购后统一进入结算页，地址和系统表单都在那里提交。
    const cart = await apiCartAdd({
      productId: info.value.productId,
      unique: "sku00001",
      cartNum: 1,
      type: 1,
      activityId: seckillId.value,
    });
    uni.navigateTo({
      url: `/pages/order/confirm?mode=buy&cartId=${cart.id}&type=1&seckillId=${seckillId.value}`,
    });
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "抢购失败", icon: "none" });
  }
}

onLoad((options) => {
  const id = Number(options?.id ?? 0);
  if (id) {
    seckillId.value = id;
    load(id);
  }
});
</script>

<style scoped>
.seckill-detail {
  padding-bottom: 140rpx;
}

.goods-img {
  width: 100%;
  height: 600rpx;
  background: #f5f5f5;
}

.price-section {
  background: #fff;
  padding: 24rpx;
}

.price-row {
  display: flex;
  align-items: baseline;
  gap: 16rpx;
}

.price {
  color: #e93323;
  font-size: 44rpx;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 26rpx;
}

.limit-tag {
  background: #fff5f4;
  color: #e93323;
  font-size: 22rpx;
  border-radius: 6rpx;
  padding: 4rpx 12rpx;
}

.meta-row {
  display: flex;
  gap: 40rpx;
  color: #999;
  font-size: 24rpx;
  margin-top: 12rpx;
}

.progress-wrap {
  margin-top: 16rpx;
}

.progress-bar {
  height: 14rpx;
  background: #ffe9e5;
  border-radius: 8rpx;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ff9a45, #e93323);
  border-radius: 8rpx;
}

.info-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.goods-name {
  font-size: 32rpx;
  font-weight: 600;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 16rpx 20rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-right: 20rpx;
}

.action-icon {
  font-size: 40rpx;
}

.action-text {
  font-size: 20rpx;
  color: #555;
}

.buy-btn {
  flex: 1;
  background: linear-gradient(90deg, #ff9a45, #e93323);
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
}

.empty {
  text-align: center;
  color: #999;
  padding: 100rpx 0;
  font-size: 26rpx;
}
</style>
