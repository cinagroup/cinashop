<template>
  <view class="work-page">
    <!-- #ifdef H5 -->
    <button class="back" @tap="back">‹ 返回订单</button>
    <view v-if="access.error.value || routeError" class="notice error" role="alert">{{ access.error.value || routeError }}<button v-if="!routeError" @tap="load">重新授权或重试</button></view>
    <view v-else-if="loading" class="notice">正在读取订单详情…</view>
    <template v-else-if="order">
      <view class="card">
        <text class="state">{{ order._status?._title || "订单详情" }}</text>
        <text class="muted">订单号 {{ order.order_id }}</text>
        <text class="muted">下单时间 {{ order._add_time }}</text>
      </view>
      <view class="card"><text class="heading">客户与收货</text>
        <view class="row"><text>客户</text><text>{{ shopper?.nickname || shopper?.real_name || "暂无" }}</text></view>
        <view class="row"><text>收货人</text><text>{{ order.real_name || "暂无" }}</text></view>
        <view class="row"><text>电话</text><text>{{ order.user_phone || "暂无" }}</text></view>
        <view class="row"><text>地址</text><text>{{ order.user_address || "暂无" }}</text></view>
      </view>
      <view class="card"><text class="heading">商品</text>
        <view v-for="(item, index) in order.cartInfo" :key="index" class="product">
          <image v-if="item.productInfo?.image" :src="item.productInfo.image" class="photo" mode="aspectFill" />
          <view class="product-name"><text>{{ item.productInfo?.store_name || "商品" }}</text><text class="muted">{{ item.productInfo?.attrInfo?.suk || "" }}</text></view>
          <text>×{{ item.cart_num }}</text>
        </view>
      </view>
      <view class="card"><text class="heading">金额</text>
        <view class="row"><text>商品件数</text><text>{{ order.total_num }}</text></view>
        <view class="row"><text>运费</text><text>¥{{ order.pay_postage ?? "0.00" }}</text></view>
        <view class="row"><text>优惠券</text><text>−¥{{ order.coupon_price ?? "0.00" }}</text></view>
        <view class="row"><text>促销优惠</text><text>−¥{{ order.promotions_price ?? "0.00" }}</text></view>
        <view class="row total"><text>实付款</text><text>¥{{ order.pay_price }}</text></view>
      </view>
      <view v-if="order.delivery_type" class="card"><text class="heading">配送</text>
        <view class="row"><text>方式</text><text>{{ order.delivery_type }}</text></view>
        <view v-if="order.delivery_name" class="row"><text>承运方</text><text>{{ order.delivery_name }}</text></view>
        <view v-if="order.delivery_id" class="row"><text>配送单号</text><text>{{ order.delivery_id }}</text></view>
      </view>
    </template>
    <!-- #endif -->
    <!-- #ifndef H5 --><view class="notice">企业微信工作台仅支持 H5 侧边栏。</view><!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";
import { getWorkOrderInfo, type WorkOrder } from "@/api/work";
import { useWorkAccess } from "@/composables/useWorkAccess";

const access = useWorkAccess("client");
const order = ref<WorkOrder | null>(null);
const shopper = ref<{ nickname: string; real_name: string; phone: string; avatar: string } | null>(null);
const routeError = ref("");
const loading = ref(false);
watch(access.token, (value) => { if (!value) { order.value = null; shopper.value = null; } }, { flush: "sync" });
let orderId = 0;
let epoch = 0;
let hint: string | undefined;

onLoad((query) => {
  const candidate = Number(query?.id);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) { routeError.value = "订单 ID 无效"; return; }
  orderId = candidate;
  hint = typeof query?.userid === "string" ? query.userid : undefined;
  void load();
});
onUnload(() => { epoch++; order.value = null; shopper.value = null; access.dispose(); });

async function load() {
  if (!orderId) return;
  const current = ++epoch;
  order.value = null;
  shopper.value = null;
  loading.value = true;
  try {
    const target = hint ? `&userid=${encodeURIComponent(hint)}` : "";
    const token = await access.connect(`/pages/work/orderDetail/index?id=${orderId}${target}`, hint);
    if (!token || current !== epoch) return;
    const result = await getWorkOrderInfo(token, orderId);
    if (current === epoch && await access.verifiedToken(hint, token)) {
      order.value = result.orderInfo;
      shopper.value = result.userInfo;
    }
  } catch (cause) {
    if (current === epoch) access.readFailure(cause);
  } finally { if (current === epoch) loading.value = false; }
}
function back() {
  const target = hint ? `?userid=${encodeURIComponent(hint)}` : "";
  uni.redirectTo({ url: `/pages/work/orderList/index${target}` });
}
</script>

<style scoped>
.work-page { min-height: 100vh; background: #f3f6f9; padding: 20rpx 20rpx 80rpx; box-sizing: border-box; }
.back { display: inline-block; margin: 0 0 20rpx; background: transparent; color: #1666c4; font-size: 26rpx; }.back::after { border: 0; }
.card, .notice { background: #fff; border-radius: 16rpx; padding: 26rpx; margin-bottom: 18rpx; }.notice { overflow-wrap: anywhere; }.notice button { margin-top: 16rpx; }.error { color: #a72d2d; }
.card:first-of-type { display: flex; flex-direction: column; gap: 10rpx; }.state { font-size: 34rpx; color: #1768c8; font-weight: 700; }.muted { color: #6e7a8a; font-size: 24rpx; }
.heading { display: block; font-size: 29rpx; font-weight: 650; margin-bottom: 14rpx; }.row { display: flex; justify-content: space-between; gap: 24rpx; padding: 13rpx 0; border-bottom: 1rpx solid #edf0f4; font-size: 25rpx; }
.row text:last-child { max-width: 65%; overflow-wrap: anywhere; text-align: right; }.total { color: #bd3025; font-weight: 700; font-size: 29rpx; }
.product { display: flex; align-items: center; gap: 14rpx; padding: 16rpx 0; border-bottom: 1rpx solid #edf0f4; font-size: 25rpx; }.photo { width: 90rpx; height: 90rpx; border-radius: 9rpx; flex-shrink: 0; }.product-name { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
</style>
