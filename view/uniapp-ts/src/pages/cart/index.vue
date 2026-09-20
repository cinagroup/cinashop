<template>
  <view class="cart-page">
    <view v-if="cartStore.loading" class="empty" role="status">正在读取购物车报价…</view>
    <view v-else-if="cartStore.error" class="empty" role="alert"><view>{{ cartStore.error }}</view><button @tap="reload">重新读取购物车</button><button v-if="!auth.isLoggedIn" @tap="login">去登录</button></view>
    <view v-else-if="cartStore.items.length" class="cart-list">
      <view class="cart-item" v-for="item in cartStore.items" :key="item.id">
        <view class="check" :class="{ checked: item.checked }" :aria-disabled="blocked || !item.isValid" @tap="toggle(item.id)">
          <text v-if="item.checked">✓</text>
        </view>
        <image
          class="cart-image"
          :src="item.productInfo?.image || placeholder"
          mode="aspectFill"
          @tap="goDetail(item.productId)"
        />
        <view class="cart-info">
          <view class="cart-name">{{ item.productInfo?.storeName ?? '商品已失效' }}</view>
          <view>{{ item.productInfo?.suk }}</view>
          <view class="cart-bottom">
            <view v-if="item.isValid"><text class="cart-price">¥{{ cartUnitPrice(item) }}</text><view class="price-label">{{ cartPriceLabel(item) }}</view></view><text v-else>已失效</text>
            <view v-if="item.isValid" class="num-control">
              <button class="num-btn" :disabled="blocked || item.cartNum <= 1" @tap="changeNum(item, -1)">-</button>
              <text class="num">{{ item.cartNum }}</text>
              <button class="num-btn" :disabled="blocked || item.cartNum >= Math.min(item.productInfo?.stock ?? 0, 32767)" @tap="changeNum(item, 1)">+</button>
            </view>
          </view>
        </view>
      </view>
    </view>
    <view v-else class="empty">购物车是空的</view>

    <view v-if="cartStore.ready" class="estimate-note">商品预估金额，不含运费及其他优惠，以结算报价为准</view>
    <view class="checkout-bar" v-if="cartStore.items.length && !cartStore.error && !cartStore.loading">
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
      <button class="checkout-btn" :disabled="blocked || !cartStore.checkedItems.length" @tap="goCheckout">去结算</button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { useCartStore } from "@/stores/cart";
import { useAuthStore } from '@/stores/auth';
import { cartUnitPrice, cartPriceLabel, type CartDisplayItem } from '../../../../common/cartPrice';

const cartStore = useCartStore();
const auth = useAuthStore(), visible = ref(false);
let disposed = false;
const blocked = computed(() => !visible.value || !cartStore.ready || cartStore.loading || cartStore.updating);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const allChecked = computed(() =>
  cartStore.items.some(i => i.isValid) && cartStore.items.filter(i => i.isValid).every((i) => i.checked),
);

function toggle(id: number) {
  if (blocked.value) return;
  const item = cartStore.items.find((i) => i.id === id);
  if (item) cartStore.toggleChecked(id, !item.checked);
}

function toggleAll() {
  if (blocked.value) return;
  cartStore.toggleAll(!allChecked.value);
}

async function changeNum(item: CartDisplayItem, delta: number) {
  if (blocked.value || !cartStore.items.includes(item)) return;
  await cartStore.updateQuantity(item.id, item.cartNum + delta);
}

function goDetail(id: number) {
  if (blocked.value || !cartStore.items.some(row => row.productId === id && row.isValid)) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

function goCheckout() {
  if (blocked.value) return;
  if (!cartStore.checkedItems.length) {
    return uni.showToast({ title: "请选择商品", icon: "none" });
  }
  uni.navigateTo({ url: "/pages/order/confirm" });
}

async function reload() { if (visible.value && !disposed) await cartStore.fetchList().catch(() => {}); }
function login() { if (visible.value && !disposed && !auth.isLoggedIn) uni.navigateTo({ url: '/pages/auth/login' }); }
watch(() => auth.sessionVersion, () => { void Promise.resolve().then(reload); }, { flush: 'sync' });
onShow(() => { visible.value = true; void reload(); });
onHide(() => { visible.value = false; cartStore.cancelPending(); });
onUnload(() => { disposed = true; visible.value = false; cartStore.cancelPending(); });
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
  padding: 0;
  margin: 0;
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
  bottom: var(--window-bottom, 0px);
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
  line-height: 1.5;
  margin: 0;
  background: #e93323;
  color: #fff;
  border-radius: 40rpx;
  padding: 16rpx 50rpx;
  font-size: 28rpx;
}
.price-label { color: #9b5717; font-size: 22rpx; }
.estimate-note { color: #666; font-size: 22rpx; padding: 16rpx 0; }
</style>
