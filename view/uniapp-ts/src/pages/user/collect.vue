<template>
  <view class="page">
    <view v-if="products.length" class="goods-grid">
      <view
        class="goods-card"
        v-for="item in products"
        :key="item.id"
        @tap="goDetail(item.id)"
      >
        <image class="goods-image" :src="item.image || placeholder" mode="aspectFill" />
        <view class="goods-info">
          <view class="goods-name">{{ item.store_name }}</view>
          <text class="price">¥{{ item.price }}</text>
        </view>
        <view class="unstar" @tap.stop="unstar(item.id)">取消收藏</view>
      </view>
    </view>
    <view v-else class="empty">暂无收藏</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { http } from "@/utils/request";
import type { GoodsItem } from "@/types/product";

interface CollectListResult {
  list: GoodsItem[];
  count: number;
}

const products = ref<GoodsItem[]>([]);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

async function unstar(id: number) {
  try {
    await http.post<null>("/collect/del", { ids: [id] });
    uni.showToast({ title: "已取消收藏", icon: "success" });
    products.value = products.value.filter((p) => p.id !== id);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "操作失败", icon: "none" });
  }
}

onShow(async () => {
  products.value = [];
  try {
    const result = await http.get<CollectListResult>("/collect/user", {
      page: 1,
      limit: 50,
      category: "product",
    });
    products.value = result.list ?? [];
  } catch (e) {
    products.value = [];
    console.error("收藏加载失败", e);
  }
});
</script>

<style scoped>
.page {
  padding: 20rpx;
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
}

.goods-image {
  width: 100%;
  height: 300rpx;
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

.price {
  color: #e93323;
  font-size: 30rpx;
  font-weight: 600;
  display: block;
  margin-top: 8rpx;
}

.unstar {
  text-align: center;
  font-size: 22rpx;
  color: #999;
  padding: 8rpx 0;
  border-top: 1rpx solid #f7f7f7;
}
</style>
