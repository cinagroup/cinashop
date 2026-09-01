<template>
  <view class="pink-detail">
    <view v-if="info" class="body">
      <!-- 商品 -->
      <view class="goods-card">
        <view class="goods-name">{{ (info as any).combination?.storeName }}</view>
        <view class="goods-price">
          <text class="price">¥{{ (info as any).price }}</text>
          <text class="ot-price">¥{{ (info as any).otPrice }}</text>
        </view>
        <view class="people-tip">{{ (info as any).people }} 人成团</view>
      </view>

      <!-- 进行中的团 -->
      <view class="pink-list">
        <view class="section-title">正在拼团 ({{ (info as any).pinkList?.length ?? 0 }})</view>
        <view v-if="(info as any).pinkList?.length" class="pink-item" v-for="p in (info as any).pinkList" :key="p.id">
          <view class="pink-info">
            <view class="pink-people">{{ p.people }} / {{ (info as any).people }} 人</view>
            <view class="progress"><view class="progress-bar" :style="{ width: Math.min(100, (p.people / (info as any).people) * 100) + '%' }" /></view>
          </view>
          <view v-if="p.status === 1" class="pink-actions">
            <text class="pink-status">拼团中</text>
            <text class="pink-join" @tap="join(Number(p.id))">参加该团</text>
          </view>
          <text class="pink-status done" v-else>已完成</text>
        </view>
        <view v-else class="empty">暂无进行中的拼团</view>
      </view>

      <view class="join-btn" @tap="join()">立即开团</view>
    </view>
    <view v-else class="empty">拼团活动不存在或已结束</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

const info = ref<any>(null);

async function load(id: number) {
  try {
    info.value = await http.get<any>(`/combination/pink/${id}`);
  } catch {
    info.value = null;
  }
}

async function join(pinkId = 0) {
  try {
    const combo = info.value?.combination;
    if (!combo) return;
    const cart = await http.post<{ id: number }>("/cart/add", {
      productId: combo.productId,
      unique: "sku00001",
      cartNum: 1,
      type: 3,
      activityId: combo.id,
    });
    uni.navigateTo({
      url: pinkId > 0
        ? `/pages/order/confirm?mode=buy&cartId=${cart.id}&type=3&pinkId=${pinkId}`
        : `/pages/order/confirm?mode=buy&cartId=${cart.id}&type=3&combinationId=${combo.id}`,
    });
  } catch (e) {
    uni.showToast({ title: (e as Error).message || (pinkId > 0 ? "参团失败" : "开团失败"), icon: "none" });
  }
}

onLoad((query) => {
  const id = Number(query?.id ?? 0);
  if (id) load(id);
});
</script>

<style scoped>
.body {
  padding: 20rpx;
}

.goods-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
}

.goods-name {
  font-size: 32rpx;
  font-weight: 600;
  color: #333;
}

.goods-price {
  display: flex;
  align-items: baseline;
  gap: 16rpx;
  margin-top: 16rpx;
}

.price {
  font-size: 44rpx;
  color: #e93323;
  font-weight: 700;
}

.ot-price {
  font-size: 24rpx;
  color: #999;
  text-decoration: line-through;
}

.people-tip {
  font-size: 24rpx;
  color: #666;
  margin-top: 12rpx;
}

.pink-list {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.pink-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.pink-info {
  flex: 1;
  margin-right: 20rpx;
}

.pink-people {
  font-size: 24rpx;
  color: #555;
  margin-bottom: 8rpx;
}

.progress {
  height: 10rpx;
  background: #f0f0f0;
  border-radius: 8rpx;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #e93323;
  border-radius: 8rpx;
}

.pink-status {
  font-size: 24rpx;
  color: #e93323;
}

.pink-actions {
  display: flex;
  align-items: center;
  gap: 14rpx;
}

.pink-join {
  background: #e93323;
  color: #fff;
  border-radius: 24rpx;
  padding: 8rpx 18rpx;
  font-size: 22rpx;
}

.pink-status.done {
  color: #999;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 60rpx 0;
}

.join-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 44rpx;
  padding: 24rpx 0;
  font-size: 30rpx;
  font-weight: 600;
}
</style>
