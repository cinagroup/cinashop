<template>
  <view class="work-page">
    <!-- #ifdef H5 -->
    <scroll-view scroll-x class="status-bar"><view class="status-row">
      <button v-for="entry in statuses" :key="entry.value" class="status" :class="{ selected: selectedStatus === entry.value }" @tap="changeStatus(entry.value)">{{ entry.label }}</button>
    </view></scroll-view>
    <view class="search"><input v-model="searchInput" maxlength="100" placeholder="订单号或收货人" @confirm="search" /><button @tap="search">搜索</button></view>
    <view v-if="access.error.value || error" class="notice error" role="alert">{{ access.error.value || error }}<button @tap="refresh">重试</button></view>
    <view v-if="!rows.length && loading" class="notice">正在读取客户订单…</view>
    <view v-else-if="!rows.length && !access.error.value && !error" class="notice">暂无符合条件的订单</view>
    <view v-for="order in rows" :key="order.id" class="card" @tap="open(order.id)">
      <view class="card-header"><text>订单号 {{ order.order_id }}</text><text class="state">{{ order._status?._title || statusLabel }}</text></view>
      <text class="muted">{{ order._add_time }}</text>
      <view v-for="(product, index) in order.cartInfo" :key="index" class="product">
        <image v-if="product.productInfo?.image" :src="product.productInfo.image" class="photo" mode="aspectFill" />
        <view class="product-name"><text>{{ product.productInfo?.store_name || "商品" }}</text><text class="muted">{{ product.productInfo?.attrInfo?.suk || "" }}</text></view>
        <text>×{{ product.cart_num }}</text>
      </view>
      <view class="total">共 {{ order.total_num }} 件　实付 ¥{{ order.pay_price }}</view>
    </view>
    <button v-if="hasMore && !loading" class="more" @tap="loadMore">加载更多</button>
    <view v-else-if="loading && rows.length" class="end">正在加载…</view>
    <view v-else-if="rows.length" class="end">已显示全部订单</view>
    <WorkNav active="orders" :ready="!!access.token.value" :target-hint="access.token.value ? hint : undefined" />
    <!-- #endif -->
    <!-- #ifndef H5 --><view class="notice">企业微信工作台仅支持 H5 侧边栏。</view><!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onLoad, onReachBottom, onUnload } from "@dcloudio/uni-app";
import { getWorkOrderList, type WorkOrder } from "@/api/work";
import { useWorkAccess } from "@/composables/useWorkAccess";
import WorkNav from "@/components/work/WorkNav.vue";

const access = useWorkAccess("client");
const statuses = [
  { value: 0, label: "待付款" }, { value: 1, label: "待发货" },
  { value: 2, label: "待收货" }, { value: 3, label: "待评价" },
  { value: 4, label: "已完成" }, { value: -3, label: "退款" },
] as const;
const selectedStatus = ref<number>(0);
const statusLabel = computed(() => statuses.find((item) => item.value === selectedStatus.value)?.label ?? "订单");
const searchInput = ref("");
const searchTerm = ref("");
const rows = ref<WorkOrder[]>([]);
const error = ref("");
const loading = ref(false);
const hasMore = ref(false);
watch(access.token, (value) => { if (!value) { rows.value = []; hasMore.value = false; } }, { flush: "sync" });
let page = 1;
let epoch = 0;
let hint: string | undefined;

onLoad((query) => {
  hint = typeof query?.userid === "string" ? query.userid : undefined;
  const parsed = Number(query?.type);
  if (statuses.some((item) => item.value === parsed)) selectedStatus.value = parsed;
  void refresh();
});
onReachBottom(() => { void loadMore(); });
onUnload(() => { epoch++; rows.value = []; access.dispose(); });

async function refresh() {
  const current = ++epoch;
  rows.value = [];
  hasMore.value = false;
  page = 1;
  error.value = "";
  loading.value = true;
  try {
    const route = `/pages/work/orderList/index${hint ? `?userid=${encodeURIComponent(hint)}` : ""}`;
    const token = await access.connect(route, hint);
    if (!token || current !== epoch) return;
    const list = await getWorkOrderList(token, { page, limit: 10, type: selectedStatus.value, search: searchTerm.value });
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    rows.value = list;
    hasMore.value = list.length === 10;
    page++;
  } catch (cause) {
    if (current === epoch) { rows.value = []; access.readFailure(cause); }
  } finally { if (current === epoch) loading.value = false; }
}

async function loadMore() {
  if (loading.value || !hasMore.value) return;
  const current = epoch;
  loading.value = true;
  error.value = "";
  try {
    const token = await access.verifiedToken(hint);
    if (!token) { rows.value = []; hasMore.value = false; return; }
    if (current !== epoch) return;
    const list = await getWorkOrderList(token, { page, limit: 10, type: selectedStatus.value, search: searchTerm.value });
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    rows.value = [...rows.value, ...list];
    hasMore.value = list.length === 10;
    page++;
  } catch (cause) {
    if (current === epoch) { access.readFailure(cause); error.value = access.error.value; }
  } finally { if (current === epoch) loading.value = false; }
}

function changeStatus(status: number) { if (selectedStatus.value === status) return; selectedStatus.value = status; void refresh(); }
function search() { searchTerm.value = searchInput.value.trim().slice(0, 100); void refresh(); }
function open(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0 || !access.readyToken()) return;
  const target = hint ? `&userid=${encodeURIComponent(hint)}` : "";
  uni.navigateTo({ url: `/pages/work/orderDetail/index?id=${id}${target}` });
}
</script>

<style scoped>
.work-page { min-height: 100vh; background: #f3f6f9; padding: 16rpx 20rpx 130rpx; box-sizing: border-box; }
.status-bar { white-space: nowrap; background: #fff; border-radius: 12rpx; }.status-row { display: flex; width: max-content; min-width: 100%; }
.status { margin: 0; min-width: 122rpx; padding: 0 14rpx; background: #fff; color: #526071; font-size: 25rpx; border-radius: 0; }.status::after { border: 0; }.status.selected { color: #1768c8; font-weight: 700; border-bottom: 4rpx solid #1768c8; }
.search { display: flex; gap: 12rpx; margin: 18rpx 0; }.search input { flex: 1; min-width: 0; background: #fff; border-radius: 10rpx; padding: 10rpx 18rpx; }.search button { margin: 0; font-size: 25rpx; }
.notice, .card { background: #fff; border-radius: 16rpx; padding: 24rpx; margin-bottom: 18rpx; }.notice { overflow-wrap: anywhere; }.notice button { margin-top: 14rpx; }.error { color: #a72d2d; }
.card-header { display: flex; justify-content: space-between; gap: 15rpx; font-size: 26rpx; font-weight: 600; overflow-wrap: anywhere; }.state { color: #1768c8; flex-shrink: 0; }
.muted { color: #738093; font-size: 23rpx; }.product { display: flex; align-items: center; gap: 14rpx; padding: 20rpx 0; border-bottom: 1rpx solid #eef1f4; font-size: 25rpx; }
.photo { width: 92rpx; height: 92rpx; border-radius: 10rpx; flex-shrink: 0; }.product-name { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
.total { padding-top: 16rpx; text-align: right; font-size: 25rpx; }.more, .end { text-align: center; margin: 20rpx auto; color: #526071; font-size: 25rpx; }
</style>
