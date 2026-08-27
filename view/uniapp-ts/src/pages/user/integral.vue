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
      <view v-for="g in list" :key="g.id" class="goods-card">
        <image
          class="goods-image"
          :src="g.image || placeholder"
          mode="aspectFill"
        />
        <view class="goods-info">
          <view class="goods-name">{{ g.storeName }}</view>
          <view class="goods-bottom">
            <view class="integral-price">
              <text class="int-val">{{ g.integral }}</text>
              <text class="int-unit">积分</text>
              <text v-if="Number(g.price) > 0" class="cash-price">+¥{{ g.price }}</text>
            </view>
            <view class="exchange-btn" @tap="exchange(g)">兑换</view>
          </view>
          <view class="goods-stock" v-if="Number(g.stock) <= 0">已兑完</view>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无积分商品</view>

    <view v-if="skuVisible" class="mask" @tap="closeSku()">
      <view class="sku-sheet" @tap.stop>
        <view class="sku-title">{{ pendingDetail?.storeInfo.storeName }}</view>
        <view class="sku-options">
          <view
            v-for="sku in pendingDetail?.skus ?? []"
            :key="sku.id"
            class="sku-option"
            :class="{ active: selectedSku?.id === sku.id, disabled: sku.stock <= 0 }"
            @tap="sku.stock > 0 && (selectedSku = sku)"
          >
            <text>{{ sku.suk || "默认规格" }}</text>
            <text>{{ sku.integral }}积分 + ¥{{ sku.price }}</text>
          </view>
        </view>
        <view class="quantity-row">
          <text>兑换数量</text>
          <view class="quantity-stepper">
            <button size="mini" @tap="quantity = Math.max(1, quantity - 1)">−</button>
            <text>{{ quantity }}</text>
            <button size="mini" @tap="increaseQuantity">＋</button>
          </view>
        </view>
        <view class="sku-actions">
          <button @tap="closeSku()">取消</button>
          <button class="confirm-button" :loading="submitting" @tap="confirmExchange">去结算</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";
import { apiCartAdd } from "@/api/order";

interface IntegralItem {
  id: number;
  image: string;
  storeName: string;
  integral: number;
  price: string;
  stock: number;
  systemFormId: number;
}

interface IntegralSku {
  id: number;
  unique: string;
  suk: string;
  image: string;
  price: string;
  integral: number;
  stock: number;
}

interface IntegralDetail {
  storeInfo: IntegralItem & { productId: number; onceNum: number };
  skus: IntegralSku[];
}

const list = ref<IntegralItem[]>([]);
const points = ref("0");
const skuVisible = ref(false);
const pendingDetail = ref<IntegralDetail | null>(null);
const selectedSku = ref<IntegralSku | null>(null);
const quantity = ref(1);
const submitting = ref(false);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function load() {
  try {
    list.value = await http.get<IntegralItem[]>("/store_integral/list", { page: 1, limit: 20 });
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

async function exchange(item: IntegralItem) {
  if (submitting.value || item.stock <= 0) return;
  submitting.value = true;
  try {
    const detail = await http.get<IntegralDetail>(`/store_integral/detail/${item.id}`);
    const first = detail.skus.find((sku) => sku.stock > 0) ?? null;
    if (!first) throw new Error("积分商品规格已兑完");
    pendingDetail.value = detail;
    selectedSku.value = first;
    quantity.value = 1;
    skuVisible.value = true;
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "积分商品加载失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

async function confirmExchange() {
  if (submitting.value || !pendingDetail.value || !selectedSku.value) return;
  submitting.value = true;
  try {
    const detail = pendingDetail.value;
    const cart = await apiCartAdd({
      productId: detail.storeInfo.productId,
      unique: selectedSku.value.unique,
      cartNum: quantity.value,
      type: 4,
      activityId: detail.storeInfo.id,
    });
    closeSku(true);
    uni.navigateTo({
      url: `/pages/order/confirm?mode=buy&cartId=${cart.id}&type=4`,
    });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "加入结算失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

function increaseQuantity() {
  const limit = Math.min(
    selectedSku.value?.stock ?? 1,
    pendingDetail.value?.storeInfo.onceNum && pendingDetail.value.storeInfo.onceNum > 0
      ? pendingDetail.value.storeInfo.onceNum
      : Number.MAX_SAFE_INTEGER,
  );
  quantity.value = Math.min(quantity.value + 1, limit);
}

function closeSku(force = false) {
  if (submitting.value && force !== true) return;
  skuVisible.value = false;
  pendingDetail.value = null;
  selectedSku.value = null;
  quantity.value = 1;
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

.mask { position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.5); display: flex; align-items: flex-end; }
.sku-sheet { width: 100%; max-height: 80vh; padding: 28rpx 20rpx; box-sizing: border-box; background: #f5f5f5; border-radius: 24rpx 24rpx 0 0; }
.sku-title { font-size: 30rpx; font-weight: 600; margin-bottom: 20rpx; }
.sku-options { display: flex; flex-wrap: wrap; gap: 14rpx; max-height: 42vh; overflow-y: auto; }
.sku-option { display: flex; flex-direction: column; gap: 6rpx; min-width: 200rpx; padding: 16rpx; background: #fff; border: 2rpx solid #eee; border-radius: 12rpx; font-size: 24rpx; }
.sku-option.active { color: #f76b1c; border-color: #f76b1c; }
.sku-option.disabled { opacity: 0.45; }
.quantity-row { display: flex; align-items: center; justify-content: space-between; margin-top: 24rpx; }
.quantity-stepper { display: flex; align-items: center; gap: 20rpx; }
.quantity-stepper button { margin: 0; }
.sku-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx; padding-top: 24rpx; }
.confirm-button { background: #f76b1c; color: #fff; }
</style>
