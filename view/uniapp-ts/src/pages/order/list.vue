<template>
  <view class="order-list">
    <!-- 状态 tab -->
    <view class="tabs">
      <view
        v-for="t in tabs"
        :key="String(t.status)"
        class="tab"
        :class="{ active: activeStatus === t.status }"
        @tap="switchTab(t.status)"
      >
        {{ t.name }}
      </view>
    </view>
    <view class="list-tools">
      <text v-if="list.ready">已加载 {{ orders.length }} 笔订单</text>
      <button size="mini" :disabled="busy" @tap="load(true)">刷新列表</button>
    </view>
    <view v-if="list.loading && !orders.length" class="empty">正在加载订单...</view>

    <view v-if="orders.length" class="order-cards">
      <view class="order-card" v-for="order in orders" :key="order.order_id">
        <view class="order-header">
          <text class="order-id">订单号: {{ order.order_id }}</text>
          <text class="order-status">{{ statusText(order) }}</text>
        </view>
        <view class="order-body" role="button" :aria-disabled="busy" :aria-label="`查看订单 ${order.order_id}`" @tap="goDetail(order.order_id)">
          <view class="cart-line" v-for="ci in order.cart_info" :key="ci.id">
            <image
              v-if="ci.cart_info?.product"
              class="cart-image"
              :src="ci.cart_info.product.image"
              mode="aspectFill"
            />
            <text class="cart-name">{{ ci.cart_info?.product?.storeName }}</text>
            <text class="cart-num">x{{ ci.cart_num }}</text>
          </view>
          <text v-if="!order.cart_info?.length">查看订单详情</text>
        </view>
        <view class="order-footer">
          <text class="order-price">¥{{ order.pay_price }}</text>
          <view v-if="order.paid === 0 && order.status === 0" class="pay-btn" :aria-disabled="busy" @tap="pay(order)">去支付</view>
          <view v-else class="pay-btn" :aria-disabled="busy" @tap="goDetail(order.order_id)">查看订单</view>
          <button v-if="canDeleteOrder(order)" class="delete-btn" size="mini" :disabled="busy || !!list.error || !!navigationError" @tap="remove(order)">删除订单</button>
        </view>
      </view>
      <button v-if="hasMore && !list.error" class="load-more" :disabled="busy" @tap="loadMore">{{ list.loading ? '正在加载...' : '加载更多订单' }}</button>
      <view v-else-if="!hasMore" class="no-more">没有更多了</view>
    </view>
    <view v-if="list.error || navigationError" class="list-error" role="alert">
      <text>{{ list.error || navigationError }}</text>
      <button v-if="!auth.isLoggedIn" :disabled="navigating" @tap="login">前往登录</button>
      <button v-if="list.error && !list.refreshRequired" :disabled="busy" @tap="loadMore">重试当前页</button>
      <button v-else :disabled="busy" @tap="load(true)">刷新列表核对</button>
    </view>
    <view v-else-if="list.ready && !orders.length && !list.loading" class="empty">暂无订单</view>
  </view>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiOrderList, apiOrderDelete } from "@/api/order";
import type { OrderInfo } from "@/types/order";
import { useAuthStore } from "@/stores/auth";
import { createOrderList, initialOrderList, orderListFilter, orderListQuery, orderListHash, customerOrderStatus as statusText } from "../../../../common/orderListState";
import { canDeleteOrder, orderDeleteConfirmation } from '../../../../common/orderDeletion';

defineOptions({ inheritAttrs: false });
const auth = useAuthStore(), list = reactive(initialOrderList<OrderInfo>());
const orders = computed(() => list.rows), activeStatus = computed(() => list.status), hasMore = computed(() => list.hasMore);
const navigating = ref(false), deleting = ref(false), navigationError = ref('');
const busy = computed(() => list.loading || navigating.value || deleting.value);
let visible = false, disposed = false, navigationVersion = 0, lastHash = '', routeValid = true;
function capture() {
  const uid = auth.uid, version = auth.sessionVersion, token = auth.token, revision = list.revision;
  return { uid, current: () => visible && !disposed && revision === list.revision && uid > 0 && !!token
    && uid === auth.uid && version === auth.sessionVersion && token === auth.token };
}
const controller = createOrderList(list, { capture, read: apiOrderList }, 10);
function clearView() { controller.clear(); navigationVersion++; navigating.value = false; deleting.value = false; navigationError.value = ''; }

const tabs = [
  { status: undefined as number | undefined, name: "全部" },
  { status: 0, name: "待付款" },
  { status: 1, name: "待发货" },
  { status: 2, name: "待收货/核销" },
  { status: 3, name: "待评价" },
  { status: 4, name: "已完成" },
];

function switchTab(status: number | undefined) {
  if (!visible || disposed) return;
  try {
    const next = orderListFilter(status); clearView(); routeValid = true; list.status = next;
    // Keep H5 back/refresh navigation bound to the selected filter as well.
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = '#/pages/order/list' + (next === undefined ? '' : `?status=${next}`);
      if (window.location.hash !== hash) { window.location.hash = hash; return; }
    }
    // #endif
    void load(true);
  }
  catch (error) { clearView(); list.error = error instanceof Error ? error.message : '筛选无效'; list.refreshRequired = true; }
}

async function load(reset = false) {
  if (!visible || disposed || navigating.value || deleting.value) return;
  if (!routeValid) { list.error = '订单筛选链接无效，请重新选择状态'; list.refreshRequired = true; return; }
  if (reset) { clearView(); await controller.refresh(list.status); }
  else if (!navigationError.value) await controller.more();
}

async function loadMore() {
  await load();
}

function pay(order: OrderInfo) {
  if (controller.owns(order) && order.paid === 0 && order.status === 0) goDetail(order.order_id);
}

function goDetail(orderId: string) {
  const order = list.rows.find(row => row.order_id === orderId);
  if (!order || !controller.owns(order) || busy.value) return;
  const owner = capture(), version = ++navigationVersion; navigating.value = true; navigationError.value = '';
  const fail = () => { if (owner.current() && version === navigationVersion) { navigating.value = false; navigationError.value = '订单页面未打开，请重试查看'; } };
  try { uni.navigateTo({ url: `/pages/order/detail?orderId=${orderId}`, fail }); } catch { fail(); }
}
function login() {
  if (!visible || disposed || navigating.value || auth.isLoggedIn) return;
  const version = ++navigationVersion; navigating.value = true;
  const fail = () => { if (visible && !disposed && version === navigationVersion) { navigating.value = false; navigationError.value = '登录页面未打开，请重试'; } };
  try { uni.navigateTo({ url: '/pages/auth/login', fail }); } catch { fail(); }
}

async function remove(order: OrderInfo) {
  if (busy.value || list.error || navigationError.value || !controller.owns(order) || !canDeleteOrder(order)) return;
  const owner = capture(), id = order.order_id, confirmation = orderDeleteConfirmation(order);
  deleting.value = true;
  try {
    const confirmed = await new Promise<boolean>((resolve, reject) => {
      uni.showModal({ title: '删除订单', content: confirmation, confirmText: '确认删除', cancelText: '保留订单',
        success: result => resolve(result.confirm === true), fail: reject });
    });
    if (!owner.current() || !confirmed) return;
    if (!controller.owns(order) || !canDeleteOrder(order) || orderDeleteConfirmation(order) !== confirmation) {
      navigationError.value = '订单状态已变化，请刷新列表核对'; return;
    }
    await apiOrderDelete(id);
    if (!owner.current()) return;
    uni.showToast({ title: '订单已删除', icon: 'success' });
    deleting.value = false;
    // Re-read page one so deletion cannot shift the next offset and omit an order.
    await load(true);
  } catch (error) {
    if (owner.current()) navigationError.value = `删除结果尚未确认，请刷新列表核对，勿重复提交。${error instanceof Error ? error.message : ''}`;
  } finally { if (owner.current()) deleting.value = false; }
}

function setRoute(query: { status?: unknown; type?: unknown }) {
  clearView();
  try { list.status = orderListQuery(query); routeValid = true; }
  catch (error) { routeValid = false; list.error = error instanceof Error ? error.message : '筛选无效'; list.refreshRequired = true; }
}
function readHashRoute(): boolean {
  // #ifdef H5
  if (typeof window !== 'undefined' && window.location.hash && window.location.hash !== lastHash) {
    lastHash = window.location.hash;
    try {
      const route = orderListHash(lastHash);
      if (route === null) { clearView(); routeValid = false; return true; }
      setRoute({ status: route.status }); void load(true); return true;
    } catch (error) { clearView(); routeValid = false; list.error = error instanceof Error ? error.message : '筛选无效'; list.refreshRequired = true; return true; }
  }
  // #endif
  return false;
}
function hashChanged() { if (visible && !disposed) readHashRoute(); }
watch(() => auth.sessionVersion, () => { clearView(); list.error = '登录状态已变化，请重新加载订单'; }, { flush: 'sync' });
onLoad(options => setRoute(options ?? {}));
onShow(() => { if (disposed) return; visible = true; if (!readHashRoute()) void load(true); });
onHide(() => { visible = false; clearView(); });
// #ifdef H5
if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
// #endif
onUnload(() => {
  disposed = true; visible = false; clearView();
  // #ifdef H5
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
  // #endif
});
</script>

<style scoped>
.order-list {
  padding: 20rpx;
}
.list-tools { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; margin: 20rpx 0; font-size: 26rpx; }
.list-tools button { margin: 0; }
.list-error { padding: 24rpx; margin: 20rpx 0; background: #fff7eb; border-radius: 12rpx; font-size: 28rpx; }
.list-error button { margin-top: 16rpx; }
.order-header { gap: 16rpx; flex-wrap: wrap; }
.order-id, .cart-name { min-width: 0; overflow-wrap: anywhere; }
.order-footer { flex-wrap: wrap; }
.pay-btn[aria-disabled="true"], .order-body[aria-disabled="true"] { opacity: .55; }
.delete-btn { margin: 0; background: #fff; color: #666; border-radius: 32rpx; }

.tabs {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 6rpx;
  margin-bottom: 20rpx;
  overflow-x: auto;
}

.tab {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 14rpx 4rpx;
  font-size: 26rpx;
  color: #666;
  border-radius: 10rpx;
  white-space: normal;
}

.tab.active {
  background: #e93323;
  color: #fff;
  font-weight: 600;
}

.load-more,
.no-more {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 24rpx;
}

.order-card {
  background: #fff;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.order-header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 16rpx;
  border-bottom: 1rpx solid #f5f5f5;
}

.order-id {
  color: #999;
  font-size: 24rpx;
}

.order-status {
  color: #e93323;
  font-size: 26rpx;
}

.order-body {
  padding: 16rpx 0;
}

.cart-line {
  display: flex;
  align-items: center;
  padding: 8rpx 0;
}

.cart-image {
  width: 80rpx;
  height: 80rpx;
  border-radius: 6rpx;
  margin-right: 16rpx;
}

.cart-name {
  flex: 1;
  font-size: 26rpx;
}

.cart-num {
  color: #999;
}

.order-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: 16rpx;
  border-top: 1rpx solid #f5f5f5;
  gap: 24rpx;
}

.order-price {
  color: #e93323;
  font-size: 30rpx;
  font-weight: 600;
}

.pay-btn {
  background: #e93323;
  color: #fff;
  border-radius: 32rpx;
  padding: 10rpx 36rpx;
  font-size: 26rpx;
}
</style>
