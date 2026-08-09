<template>
  <view class="cart-page">
    <view v-if="cartStore.items.length" class="cart-list">
      <view class="cart-item" v-for="item in cartStore.items" :key="item.id">
        <view class="check" :class="{ checked: item.checked }" @tap="toggle(item.id)">
          <text v-if="item.checked">✓</text>
        </view>
        <image
          class="cart-image"
          :src="item.productInfo?.image || placeholder"
          mode="aspectFill"
          @tap="goDetail(item.productId)"
        />
        <view class="cart-info">
          <view class="cart-name">{{ item.productInfo?.storeName }}</view>
          <view class="cart-bottom">
            <text class="cart-price">¥{{ item.productInfo?.price }}</text>
            <view class="num-control">
              <view class="num-btn" @tap="changeNum(item, -1)">-</view>
              <text class="num">{{ item.cartNum }}</text>
              <view class="num-btn" @tap="changeNum(item, 1)">+</view>
            </view>
          </view>
        </view>
      </view>
    </view>
    <view v-else class="empty">购物车是空的</view>

    <view class="checkout-bar" v-if="cartStore.items.length">
      <view class="check-all" @tap="toggleAll">
        <view class="check" :class="{ checked: allChecked }">
          <text v-if="allChecked">✓</text>
        </view>
        <text>全选</text>
      </view>
      <view class="total-area">
        <text class="total-label">合计: </text>
        <text class="total-price">¥{{ cartStore.totalPrice }}</text>
      </view>
      <view class="checkout-btn" @tap="goCheckout">去结算</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { useCartStore } from "@/stores/cart";
import { apiCartNum } from "@/api/order";
import type { CartItem } from "@/types/order";

const cartStore = useCartStore();
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const allChecked = computed(() =>
  cartStore.items.length > 0 && cartStore.items.every((i) => i.checked),
);

function toggle(id: number) {
  const item = cartStore.items.find((i) => i.id === id);
  if (item) cartStore.toggleChecked(id, !item.checked);
}

function toggleAll() {
  cartStore.toggleAll(!allChecked.value);
}

async function changeNum(item: CartItem, delta: number) {
  const num = Math.max(1, item.cartNum + delta);
  try {
    await apiCartNum(item.id, num);
    cartStore.fetchList();
  } catch (e) {
    uni.showToast({ title: "修改失败", icon: "none" });
  }
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

function goCheckout() {
  if (!cartStore.checkedItems.length) {
    return uni.showToast({ title: "请选择商品", icon: "none" });
  }
  uni.navigateTo({ url: "/pages/order/confirm" });
}

onShow(() => {
  cartStore.fetchList();
});
</script>

<style scoped>
.cart-page {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.cart-item {
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}

.check {
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  border: 2rpx solid #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 16rpx;
  color: #fff;
  font-size: 24rpx;
  flex-shrink: 0;
}

.check.checked {
  background: #e93323;
  border-color: #e93323;
}

.cart-image {
  width: 140rpx;
  height: 140rpx;
  border-radius: 8rpx;
  flex-shrink: 0;
}

.cart-info {
  flex: 1;
  margin-left: 16rpx;
}

.cart-name {
  font-size: 26rpx;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.cart-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 16rpx;
}

.cart-price {
  color: #e93323;
  font-size: 30rpx;
  font-weight: 600;
}

.num-control {
  display: flex;
  align-items: center;
}

.num-btn {
  width: 48rpx;
  height: 48rpx;
  border: 1rpx solid #ddd;
  border-radius: 6rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28rpx;
}

.num {
  padding: 0 20rpx;
  font-size: 26rpx;
}

.checkout-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 20rpx 30rpx;
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
}

.check-all {
  display: flex;
  align-items: center;
  font-size: 26rpx;
}

.total-area {
  flex: 1;
  text-align: right;
  margin-right: 20rpx;
}

.total-price {
  color: #e93323;
  font-size: 36rpx;
  font-weight: 700;
}

.checkout-btn {
  background: #e93323;
  color: #fff;
  border-radius: 40rpx;
  padding: 16rpx 50rpx;
  font-size: 28rpx;
}
</style>
