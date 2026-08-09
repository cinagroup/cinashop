<template>
  <view class="bargain-detail">
    <view v-if="bargain">
      <!-- 商品图 -->
      <image class="goods-img" :src="bargain.image || placeholder" mode="aspectFill" />

      <!-- 砍价进度区 -->
      <view class="price-section">
        <view class="price-row">
          <view class="price-item">
            <text class="price-label">当前价</text>
            <text class="price">¥{{ myBargain?.bargainPrice ?? bargain.price }}</text>
          </view>
          <view class="price-item">
            <text class="price-label">原价</text>
            <text class="ot-price">¥{{ bargain.price }}</text>
          </view>
          <view class="price-item">
            <text class="price-label">最低可砍至</text>
            <text class="min-price">¥{{ bargain.minPrice }}</text>
          </view>
        </view>
        <!-- 进度条 -->
        <view class="progress-wrap">
          <view class="progress-bar">
            <view class="progress-fill" :style="{ width: progressPercent + '%' }" />
          </view>
        </view>
      </view>

      <!-- 操作区 -->
      <view class="info-section">
        <view class="goods-name">{{ bargain.storeName }}</view>
        <view class="tips" v-if="!myBargain">发起砍价后邀请好友帮砍, 砍到最低价即可购买</view>
        <view class="tips" v-else-if="myBargain.status === 3">已砍到最低价, 可以购买了!</view>
        <view class="tips" v-else>已砍至 ¥{{ myBargain.bargainPrice }}, 继续邀请好友帮砍</view>
      </view>

      <!-- 我的砍价记录 -->
      <view v-if="myBargain" class="info-section">
        <view class="section-title">我的砍价</view>
        <view class="bargain-line">
          <text>记录 #{{ myBargain.id }}</text>
          <text class="status-text">{{ statusText(myBargain.status) }}</text>
        </view>
      </view>

      <!-- 底部操作栏 -->
      <view class="action-bar">
        <view class="action-btn" @tap="goDetail">
          <text class="action-icon">🔍</text>
          <text class="action-text">查看详情</text>
        </view>
        <view v-if="!myBargain" class="buy-btn" @tap="startBargain">发起砍价</view>
        <view v-else-if="myBargain.status === 3" class="buy-btn" @tap="buyNow">
          立即购买 ¥{{ myBargain.bargainPrice }}
        </view>
        <view v-else class="buy-btn disabled" @tap="helpSelf">帮自己砍一刀</view>
      </view>
    </view>
    <view v-else class="empty">砍价活动不存在或已结束</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";
import { apiCartAdd, apiOrderCreate, apiAddressList } from "@/api/order";
import { useAuthStore } from "@/stores/auth";

const bargain = ref<any>(null);
const myBargain = ref<any>(null);
const authStore = useAuthStore();
const bargainId = ref(0);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const progressPercent = computed(() => {
  if (!bargain.value) return 0;
  const current = Number(myBargain.value?.bargainPrice ?? bargain.value.price);
  const max = Number(bargain.value.price);
  const min = Number(bargain.value.minPrice);
  if (max <= min) return 100;
  return Math.min(100, Math.round(((max - current) / (max - min)) * 100));
});

function statusText(s: number) {
  return { 1: "砍价中", 2: "已取消", 3: "可购买", 4: "已购买" }[s] || "未知";
}

async function load(id: number) {
  try {
    bargain.value = await http.get<any>(`/bargain/detail/${id}`);
  } catch {
    bargain.value = null;
  }
}

async function loadMyBargain() {
  try {
    const list = await http.get<any[]>(`/bargain/user/list`);
    myBargain.value =
      list.find((b: any) => b.bargainId === bargainId.value && b.isDel !== 1) ?? null;
  } catch {
    myBargain.value = null;
  }
}

async function startBargain() {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  try {
    const res = await http.post<{ id: number }>("/bargain/start", { bargain_id: bargainId.value });
    myBargain.value = { id: res.id, bargainPrice: bargain.value.price, status: 1 };
    uni.showToast({ title: "砍价已开启", icon: "success" });
    loadMyBargain();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "发起失败", icon: "none" });
  }
}

async function helpSelf() {
  if (!myBargain.value) return;
  try {
    await http.post("/bargain/help", { bargain_user_id: myBargain.value.id });
    loadMyBargain();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "帮砍失败", icon: "none" });
  }
}

async function buyNow() {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  if (!myBargain.value || myBargain.value.status !== 3) return;
  try {
    const addrs = await apiAddressList().catch(() => [] as any[]);
    const addr = addrs.find((a: any) => a.is_default === 1) ?? addrs[0];
    if (!addr) {
      uni.showToast({ title: "请先添加收货地址", icon: "none" });
      uni.navigateTo({ url: "/pages/user/address" });
      return;
    }
    const cart = await apiCartAdd({
      productId: bargain.value.productId,
      unique: "sku00001",
      cartNum: 1,
    });
    const key = `bargain-${Date.now()}`;
    const order = await apiOrderCreate(key, {
      cartIds: [cart.id],
      realName: (addr as any).real_name ?? (addr as any).realName,
      userPhone: (addr as any).phone,
      province: (addr as any).province ?? "",
      userAddress: `${(addr as any).city ?? ""}${(addr as any).district ?? ""}${(addr as any).detail ?? ""}`,
      type: 2,
      bargainUserId: myBargain.value.id,
    });
    uni.showToast({ title: "下单成功", icon: "success" });
    setTimeout(() => uni.redirectTo({ url: `/pages/order/detail?orderId=${order.orderId}` }), 800);
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "购买失败", icon: "none" });
  }
}

function goDetail() {
  if (!bargain.value) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${bargain.value.productId}` });
}

onLoad((options) => {
  const id = Number(options?.id ?? 0);
  if (id) {
    bargainId.value = id;
    load(id);
    loadMyBargain();
  }
});
</script>

<style scoped>
.bargain-detail {
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
  justify-content: space-between;
}

.price-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
}

.price-label {
  font-size: 22rpx;
  color: #999;
}

.price {
  color: #e93323;
  font-size: 36rpx;
  font-weight: 700;
}

.ot-price {
  color: #999;
  font-size: 30rpx;
  text-decoration: line-through;
}

.min-price {
  color: #ff9a45;
  font-size: 30rpx;
  font-weight: 600;
}

.progress-wrap {
  margin-top: 20rpx;
}

.progress-bar {
  height: 16rpx;
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

.tips {
  font-size: 24rpx;
  color: #ff9a45;
  margin-top: 12rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.bargain-line {
  display: flex;
  justify-content: space-between;
  font-size: 26rpx;
  color: #666;
}

.status-text {
  color: #e93323;
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
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
}

.buy-btn.disabled {
  background: #ff9a45;
}

.empty {
  text-align: center;
  color: #999;
  padding: 100rpx 0;
  font-size: 26rpx;
}
</style>
