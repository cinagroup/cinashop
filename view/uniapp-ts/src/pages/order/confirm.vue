<template>
  <view class="confirm-page">
    <!-- 地址 -->
    <view class="section" @tap="showAddress">
      <template v-if="selectedAddr">
        <view class="addr-top">
          <text class="addr-name">{{ selectedAddr.real_name }}</text>
          <text class="addr-phone">{{ selectedAddr.phone }}</text>
          <text class="addr-more">切换 ›</text>
        </view>
        <view class="addr-detail">
          {{ selectedAddr.province }}{{ selectedAddr.city }}{{ selectedAddr.district
          }}{{ selectedAddr.detail }}
        </view>
      </template>
      <view v-else class="addr-empty">请选择收货地址 ›</view>
    </view>

    <!-- 商品 -->
    <view class="section">
      <view class="cart-line" v-for="item in displayItems" :key="item.id">
        <image
          class="cart-image"
          :src="item.productInfo?.image || placeholder"
          mode="aspectFill"
        />
        <view class="cart-info">
          <view class="cart-name">{{ item.productInfo?.storeName }}</view>
          <view class="cart-bottom">
            <text class="cart-price">¥{{ item.productInfo?.price }}</text>
            <text class="cart-num">x{{ item.cartNum }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 优惠券 -->
    <view class="section row" @tap="openCouponSheet">
      <text class="row-label">优惠券</text>
      <text v-if="selectedCoupon" class="coupon-discount">
        -¥{{ couponDiscount }}
      </text>
      <text v-else-if="usableCoupons.length" class="row-value">
        {{ usableCoupons.length }} 张可用
      </text>
      <text v-else class="row-value muted">暂无可用</text>
      <text class="row-arrow">›</text>
    </view>

    <!-- 备注 -->
    <view class="section">
      <textarea
        v-model="mark"
        class="mark-input"
        placeholder="订单备注 (选填)"
        :maxlength="200"
      />
    </view>

    <!-- 支付方式 -->
    <view class="section">
      <view class="pay-title">支付方式</view>
      <view
        class="pay-item"
        :class="{ active: payType === 'yue' }"
        @tap="payType = 'yue'"
      >
        <text class="pay-icon">💰</text>
        <text class="pay-name">余额支付</text>
        <text class="pay-check">{{ payType === "yue" ? "✓" : "" }}</text>
      </view>
      <view class="pay-item disabled" @tap="payWeixin">
        <text class="pay-icon">💚</text>
        <text class="pay-name">微信支付 (暂未接入)</text>
      </view>
    </view>

    <!-- 提交 -->
    <view class="submit-bar">
      <view class="total-area">
        <text class="total-label">合计: </text>
        <text class="total-price">¥{{ totalPay }}</text>
        <text v-if="couponDiscount > 0" class="total-save">(已优惠 ¥{{ couponDiscount }})</text>
      </view>
      <view class="submit-btn" :class="{ disabled: submitting }" @tap="submit">
        {{ submitting ? "提交中..." : "提交订单" }}
      </view>
    </view>

    <!-- 地址选择弹窗 -->
    <view v-if="addrSheetVisible" class="mask" @tap="addrSheetVisible = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">选择收货地址</view>
        <scroll-view scroll-y class="sheet-scroll">
          <view
            v-for="addr in addresses"
            :key="addr.id"
            class="addr-opt"
            :class="{ active: selectedAddr?.id === addr.id }"
            @tap="pickAddress(addr)"
          >
            <view class="addr-opt-top">
              <text class="addr-opt-name">{{ addr.real_name }}</text>
              <text class="addr-opt-phone">{{ addr.phone }}</text>
              <text v-if="addr.is_default" class="default-tag">默认</text>
            </view>
            <view class="addr-opt-detail">
              {{ addr.province }}{{ addr.city }}{{ addr.district }}{{ addr.detail }}
            </view>
          </view>
        </scroll-view>
        <view class="sheet-btn secondary" @tap="goAddAddress">＋ 新增地址</view>
      </view>
    </view>

    <!-- 优惠券弹窗 -->
    <view v-if="couponSheetVisible" class="mask" @tap="couponSheetVisible = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">选择优惠券</view>
        <scroll-view scroll-y class="sheet-scroll">
          <view
            v-for="c in usableCoupons"
            :key="c.id"
            class="coupon-opt"
            :class="{ active: selectedCoupon?.id === c.id }"
            @tap="pickCoupon(c)"
          >
            <view class="coupon-price">¥{{ c.couponPrice }}</view>
            <view class="coupon-info">
              <view class="coupon-name">{{ c.couponTitle }}</view>
              <view class="coupon-min">满 {{ c.useMinPrice }} 可用</view>
            </view>
          </view>
          <view v-if="!usableCoupons.length" class="coupon-empty">暂无可用优惠券</view>
        </scroll-view>
        <view class="sheet-btn secondary" @tap="selectedCoupon = null; couponSheetVisible = false">
          不使用优惠券
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import { useCartStore } from "@/stores/cart";
import {
  apiAddressList,
  apiOrderCreate,
} from "@/api/order";
import type { UserAddress, CartItem } from "@/types/order";

interface UserCoupon {
  id: number;
  couponTitle?: string;
  couponPrice: string;
  useMinPrice: string;
  status: number;
  type: number;
  endTime?: string | null;
}

const cartStore = useCartStore();
const addresses = ref<UserAddress[]>([]);
const selectedAddr = ref<UserAddress | null>(null);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

// ─── 模式: cart=购物车结算 buy=立即购买(单个) ───
const mode = ref<"cart" | "buy">("cart");
const buyCartId = ref(0);

// ─── 优惠券 ───
const usableCoupons = ref<UserCoupon[]>([]);
const selectedCoupon = ref<UserCoupon | null>(null);

// ─── 支付/备注 ───
const payType = ref("yue");
const mark = ref("");
const submitting = ref(false);

// ─── 弹窗 ───
const addrSheetVisible = ref(false);
const couponSheetVisible = ref(false);

/** 结算商品: buy 模式只显示指定 cart */
const displayItems = computed<CartItem[]>(() => {
  if (mode.value === "buy" && buyCartId.value) {
    return cartStore.items.filter((i) => i.id === buyCartId.value);
  }
  return cartStore.checkedItems;
});

const goodsTotal = computed(() =>
  displayItems.value.reduce((sum, i) => {
    const p = Number(i.productInfo?.price ?? 0);
    return sum + p * i.cartNum;
  }, 0),
);

const couponDiscount = computed(() => {
  if (!selectedCoupon.value) return 0;
  const c = selectedCoupon.value;
  if (Number(c.type) === 2) {
    const rate = Math.max(0.1, Math.min(1, Number(c.couponPrice) / 10));
    return Math.round(goodsTotal.value * (1 - rate) * 100) / 100;
  }
  return Math.min(Number(c.couponPrice), goodsTotal.value);
});

const totalPay = computed(() =>
  Math.max(0, Math.round((goodsTotal.value - couponDiscount.value) * 100) / 100).toFixed(2),
);

async function loadAddresses() {
  try {
    addresses.value = await apiAddressList();
    selectedAddr.value =
      addresses.value.find((a) => a.is_default) ?? addresses.value[0] ?? null;
  } catch {
    // ignore
  }
}

async function loadCoupons() {
  try {
    const list = await httpGetCoupons();
    const now = Date.now();
    usableCoupons.value = list.filter((c) => {
      if (c.status !== 0) return false;
      if (c.endTime && new Date(c.endTime).getTime() < now) return false;
      if (Number(c.useMinPrice) > 0 && goodsTotal.value < Number(c.useMinPrice)) return false;
      return true;
    });
  } catch {
    usableCoupons.value = [];
  }
}

function showAddress() {
  if (!addresses.value.length) {
    uni.showToast({ title: "暂无地址, 请先添加", icon: "none" });
    setTimeout(goAddAddress, 500);
    return;
  }
  addrSheetVisible.value = true;
}

function pickAddress(addr: UserAddress) {
  selectedAddr.value = addr;
  addrSheetVisible.value = false;
}

function goAddAddress() {
  addrSheetVisible.value = false;
  uni.navigateTo({ url: "/pages/user/address" });
}

function openCouponSheet() {
  if (!usableCoupons.value.length) {
    uni.showToast({ title: "暂无可用优惠券", icon: "none" });
    return;
  }
  couponSheetVisible.value = true;
}

function payWeixin() {
  payType.value = "yue";
  uni.showToast({ title: "微信支付暂未接入, 请使用余额支付", icon: "none" });
}

function pickCoupon(c: UserCoupon) {
  selectedCoupon.value = c;
  couponSheetVisible.value = false;
}

async function submit() {
  if (submitting.value) return;
  if (!selectedAddr.value) return uni.showToast({ title: "请选择收货地址", icon: "none" });
  const items = displayItems.value;
  if (!items.length) return uni.showToast({ title: "请选择商品", icon: "none" });

  const addr = selectedAddr.value;
  const key = `uni_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  submitting.value = true;
  try {
    const result = await apiOrderCreate(key, {
      cartIds: items.map((i) => i.id),
      realName: addr.real_name,
      userPhone: addr.phone,
      province: addr.province,
      userAddress: `${addr.city}${addr.district}${addr.detail}`,
      couponId: selectedCoupon.value?.id,
      mark: mark.value,
    });
    uni.showToast({ title: "订单创建成功", icon: "success" });
    if (mode.value !== "buy") await cartStore.fetchList();
    setTimeout(() => {
      uni.redirectTo({ url: `/pages/order/detail?orderId=${result.orderId}` });
    }, 800);
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "下单失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

/** 拉取用户优惠券 (未使用) */
async function httpGetCoupons(): Promise<UserCoupon[]> {
  const { http } = await import("@/utils/request");
  return http.get<UserCoupon[]>("/coupons/user/0");
}

onLoad((options) => {
  if (options?.mode === "buy" && options?.cartId) {
    mode.value = "buy";
    buyCartId.value = Number(options.cartId);
  }
});

onShow(() => {
  // buy 模式: 需要拉购物车找到对应项
  if (mode.value === "buy" && buyCartId.value) {
    cartStore.fetchList().then(() => {
      const target = cartStore.items.find((i) => i.id === buyCartId.value);
      if (target) {
        cartStore.items.forEach((i) => (i.checked = i.id === buyCartId.value));
      } else {
        // 加购项可能未同步, 刷新一次
        cartStore.fetchList();
      }
    });
  } else if (!cartStore.items.length) {
    cartStore.fetchList();
  }
  loadAddresses();
  loadCoupons();
});
</script>

<style scoped>
.confirm-page {
  padding: 20rpx;
  padding-bottom: 160rpx;
}

.section {
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.row {
  display: flex;
  align-items: center;
}

.row-label {
  font-size: 28rpx;
  color: #333;
}

.row-value {
  flex: 1;
  text-align: right;
  font-size: 26rpx;
  color: #e93323;
}

.row-value.muted {
  color: #999;
}

.coupon-discount {
  flex: 1;
  text-align: right;
  color: #e93323;
  font-size: 28rpx;
  font-weight: 600;
}

.row-arrow {
  color: #bbb;
  margin-left: 8rpx;
  font-size: 30rpx;
}

.addr-top {
  display: flex;
  gap: 16rpx;
  align-items: center;
}

.addr-name {
  font-weight: 600;
  font-size: 30rpx;
}

.addr-phone {
  color: #999;
  font-size: 26rpx;
}

.addr-more {
  margin-left: auto;
  color: #999;
  font-size: 24rpx;
}

.addr-detail {
  font-size: 26rpx;
  color: #666;
  margin-top: 8rpx;
}

.addr-empty {
  color: #999;
  font-size: 28rpx;
}

.cart-line {
  display: flex;
  padding: 16rpx 0;
}

.cart-image {
  width: 120rpx;
  height: 120rpx;
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
  margin-top: 12rpx;
}

.cart-price {
  color: #e93323;
  font-weight: 600;
}

.cart-num {
  color: #999;
}

.mark-input {
  width: 100%;
  height: 90rpx;
  font-size: 26rpx;
}

.pay-title {
  font-size: 28rpx;
  color: #333;
  margin-bottom: 12rpx;
}

.pay-item {
  display: flex;
  align-items: center;
  padding: 20rpx 16rpx;
  border: 2rpx solid #f0f0f0;
  border-radius: 12rpx;
  margin-bottom: 12rpx;
}

.pay-item.active {
  border-color: #e93323;
  background: #fff5f4;
}

.pay-item.disabled {
  opacity: 0.55;
}

.pay-icon {
  font-size: 32rpx;
  margin-right: 16rpx;
}

.pay-name {
  flex: 1;
  font-size: 26rpx;
}

.pay-check {
  color: #e93323;
  font-size: 30rpx;
}

.submit-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 20rpx 30rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
}

.total-area {
  flex: 1;
}

.total-price {
  color: #e93323;
  font-size: 36rpx;
  font-weight: 700;
}

.total-save {
  color: #999;
  font-size: 22rpx;
  margin-left: 8rpx;
}

.submit-btn {
  background: #e93323;
  color: #fff;
  border-radius: 40rpx;
  padding: 20rpx 60rpx;
  font-size: 30rpx;
}

.submit-btn.disabled {
  opacity: 0.6;
}

/* ─── 弹窗通用 ─── */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}

.sheet {
  background: #fff;
  width: 100%;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}

.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  text-align: center;
  margin-bottom: 24rpx;
}

.sheet-scroll {
  max-height: 420rpx;
}

.sheet-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 40rpx;
  font-size: 30rpx;
  margin-top: 20rpx;
}

.sheet-btn.secondary {
  background: #fff;
  color: #666;
  border: 2rpx solid #ddd;
}

/* 地址选项 */
.addr-opt {
  border: 2rpx solid #f0f0f0;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
}

.addr-opt.active {
  border-color: #e93323;
  background: #fff5f4;
}

.addr-opt-top {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.addr-opt-name {
  font-size: 28rpx;
  font-weight: 600;
}

.addr-opt-phone {
  font-size: 24rpx;
  color: #999;
}

.default-tag {
  background: #e93323;
  color: #fff;
  font-size: 20rpx;
  border-radius: 6rpx;
  padding: 2rpx 10rpx;
}

.addr-opt-detail {
  font-size: 24rpx;
  color: #666;
  margin-top: 8rpx;
}

/* 优惠券选项 */
.coupon-opt {
  display: flex;
  align-items: center;
  border: 2rpx solid #f0f0f0;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
}

.coupon-opt.active {
  border-color: #e93323;
  background: #fff5f4;
}

.coupon-price {
  width: 120rpx;
  color: #e93323;
  font-size: 32rpx;
  font-weight: 700;
  text-align: center;
}

.coupon-name {
  font-size: 26rpx;
  color: #333;
}

.coupon-min {
  font-size: 22rpx;
  color: #999;
  margin-top: 6rpx;
}

.coupon-empty {
  text-align: center;
  color: #999;
  padding: 60rpx 0;
  font-size: 26rpx;
}
</style>
