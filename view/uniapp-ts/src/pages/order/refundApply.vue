<template>
  <view class="refund-page">
    <view class="page-status">
      <view v-if="state.loadError || routeError" class="policy-warning" role="alert">{{ routeError || state.loadError }}</view>
      <view v-if="state.submitError" class="policy-warning" role="alert">{{ state.submitError }}</view>
      <view v-if="navigationError" class="policy-warning" role="alert">{{ navigationError }}</view>
      <view v-if="state.refundId" class="receipt" role="status">退款申请 #{{ state.refundId }} 已提交，等待商家处理；不代表退款已到账。</view>
      <button v-if="orderId && !auth.isLoggedIn" :disabled="navigating" @tap="login">登录后申请</button>
      <button v-if="orderId && auth.isLoggedIn" :disabled="state.loading || state.submitting || navigating" @tap="load">{{ state.loading ? '正在加载订单…' : '重新加载订单' }}</button>
      <button v-if="state.refundId || state.uncertain" :disabled="state.loading || state.submitting || navigating" @tap="goRefund">{{ state.refundId ? '查看退款申请' : '核对退款记录' }}</button>
    </view>
    <view v-if="order" class="body">
      <view class="order-summary">订单号：{{ order.order_id }} · 订单金额 ¥{{ order.pay_price }}</view>
      <view v-if="refundBlockedReason" class="policy-warning">{{ refundBlockedReason }}</view>
      <!-- 订单商品 (可勾选) -->
      <view class="goods-card">
        <view class="card-title">选择退款商品</view>
        <view
          v-for="item in orderItems"
          :key="item.id"
          class="goods-line"
          :class="{ disabled: !item.refundable || !editable }"
          role="checkbox"
          :aria-checked="selectedIds.includes(item.id)"
          :aria-disabled="!item.refundable || !editable"
          @tap="toggleItem(item)"
        >
          <view class="check" :class="{ checked: selectedIds.includes(item.id) }">
            <text v-if="selectedIds.includes(item.id)">✓</text>
          </view>
          <view class="goods-info">
            <view class="goods-name">{{ item.name }}</view>
            <view class="goods-sku">{{ item.sku }} · 订单数量 {{ item.quantity }}{{ item.refundable ? '' : ' · 暂不可退' }}</view>
          </view>
        </view>
        <view class="refund-note">申请所选商品的剩余可退数量，资格和退款金额由服务端最终核算。</view>
      </view>

      <!-- 退款原因 -->
      <view class="form-card">
        <view class="card-title">退款类型</view>
        <view class="reason-list">
          <button class="reason-item" :class="{ active: state.form.applyType === 1 }" :disabled="!editable" @tap="setType(1)">仅退款</button>
          <button v-if="!isVirtualOrder" class="reason-item" :class="{ active: state.form.applyType === 2 }" :disabled="!editable" @tap="setType(2)">退货退款</button>
        </view>
        <view class="card-title">退款原因</view>
        <view class="reason-list">
          <button
            v-for="r in reasons"
            :key="r"
            class="reason-item"
            :class="{ active: reason === r }"
            :disabled="!editable"
            @tap="setReason(r)"
          >
            {{ r }}
          </button>
        </view>
        <textarea
          v-model="explain"
          class="explain-input"
          placeholder="补充说明 (选填)"
          :maxlength="255"
          :disabled="!editable"
        />
      </view>

      <button class="submit-btn" :disabled="!canSubmit || !selectedIds.length || !reason.trim()" :loading="state.submitting" @tap="submit">提交退款申请</button>
    </view>
    <view v-else-if="state.loading" class="empty">正在核对退款订单…</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiOrderDetail, apiRefundApply } from "@/api/order";
import type { OrderInfo } from "@/types/order";
import { useAuthStore } from "@/stores/auth";
import { RequestError } from "@/utils/request";
import { createRefundApplication, initialRefundApplication, refundBlockReason, refundHashId, type RefundItem } from "../../../../common/refundApplication";
import { orderDetailId } from "../../../../common/orderDetailIdentity";

defineOptions({ inheritAttrs: false });
const auth = useAuthStore();
const state = reactive(initialRefundApplication<OrderInfo>());
const order = computed(() => state.order), orderItems = computed(() => state.items);
const selectedIds = computed({ get: () => state.selectedIds, set: value => { state.selectedIds = value; } });
const reason = computed({ get: () => state.form.refundReason, set: value => { state.form.refundReason = value; } });
const explain = computed({ get: () => state.form.refundExplain, set: value => { state.form.refundExplain = value; } });
const orderId = ref(''), routeError = ref(''), navigating = ref(false), navigationError = ref('');
let visible = false, disposed = false, lastHash = '', navigationVersion = 0;
const reasons = ["不想要了", "商品质量问题", "发错货", "与描述不符", "其他"];
const refundBlockedReason = computed(() => order.value ? refundBlockReason(order.value) : '');
const isVirtualOrder = computed(() => [1, 3, 4].includes(order.value?.product_type ?? 0));
function currentHash() {
  // #ifdef H5
  if (typeof window !== 'undefined') return window.location.hash;
  // #endif
  return '';
}
function capture() {
  const id = orderId.value, uid = auth.uid, token = auth.token, session = auth.sessionVersion, revision = state.revision, hash = currentHash();
  return { id, uid, current: () => visible && !disposed && !!token && id === orderId.value && uid === auth.uid
    && token === auth.token && session === auth.sessionVersion && revision === state.revision && hash === currentHash() };
}
const controller = createRefundApplication(state, { capture, read: apiOrderDetail, write: apiRefundApply,
  isRejected: error => error instanceof RequestError && error.status === 400 });
const canSubmit = computed(() => controller.canSubmit() && !navigating.value), editable = computed(() => canSubmit.value);
function clear(preserveOutcome = false) {
  controller.clear(preserveOutcome); navigationVersion++; navigating.value = false; navigationError.value = '';
}
async function load() {
  if (!visible || disposed || routeError.value || navigating.value) return;
  await controller.load();
}
async function submit() { if (!navigating.value) await controller.submit(); }
function toggleItem(item: RefundItem) { if (editable.value) controller.toggle(item); }
function setReason(value: string) { if (editable.value) reason.value = value; }
function setType(value: number) { if (editable.value && (value === 1 || (value === 2 && !isVirtualOrder.value))) state.form.applyType = value; }
function setRoute(value: unknown) {
  clear(); orderId.value = ''; routeError.value = '';
  try { orderId.value = orderDetailId(value); } catch (error) { routeError.value = (error as Error).message; }
}
function readHashRoute() {
  const hash = currentHash();
  if (!hash || hash === lastHash) return false;
  lastHash = hash;
  try { setRoute(refundHashId(hash)); } catch (error) { setRoute(undefined); routeError.value = (error as Error).message; }
  void load(); return true;
}
function hashChanged() { if (visible && !disposed) readHashRoute(); }
function navigate(url: string) {
  if (!visible || disposed || navigating.value || state.loading || state.submitting) return;
  const version = ++navigationVersion; navigating.value = true; navigationError.value = '';
  // Anonymous login navigation is allowed, but its callbacks are still identity/route scoped.
  const uid = auth.uid, session = auth.sessionVersion, id = orderId.value;
  const fail = () => { if (visible && !disposed && uid === auth.uid && session === auth.sessionVersion && id === orderId.value && version === navigationVersion) {
    navigating.value = false; navigationError.value = '页面未打开，请重试查看；不会重复提交申请';
  } };
  try { uni.navigateTo({ url, success() {}, fail }); } catch { fail(); }
}
function goRefund() {
  if (!capture().current()) return;
  if (state.refundId) navigate(`/pages/order/refundDetail?id=${state.refundId}`);
  else if (state.uncertain) navigate('/pages/order/refundList');
}
function login() { if (!auth.isLoggedIn && orderId.value) navigate('/pages/auth/login'); }
const stopAuth = watch(() => auth.sessionVersion, () => { clear(); state.loadError = '登录状态已变化，请重新加载退款订单'; }, { flush: 'sync' });
onLoad(query => setRoute(query?.orderId));
onShow(() => { if (disposed) return; visible = true; if (!readHashRoute()) void load(); });
onHide(() => {
  visible = false;
  if (state.submitting) { state.uncertain = true; state.submitError = '申请结果尚未确认，请先核对退款记录，勿重复提交。'; }
  clear(true);
});
// #ifdef H5
if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
// #endif
onUnload(() => {
  visible = false; disposed = true; stopAuth(); clear();
  // #ifdef H5
  if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
  // #endif
});
</script>

<style scoped>
.body {
  padding: 20rpx;
}
.page-status { padding: 20rpx; display: flex; flex-direction: column; gap: 16rpx; }
.page-status button { width: 100%; font-size: 28rpx; }
.order-summary, .refund-note { font-size: 24rpx; color: #666; line-height: 1.6; overflow-wrap: anywhere; margin-bottom: 20rpx; }
.refund-note { margin-top: 20rpx; margin-bottom: 0; }
.receipt { background: #eefaf2; color: #226b40; padding: 24rpx; line-height: 1.6; border-radius: 12rpx; font-size: 28rpx; }

.goods-card,
.form-card {
  width: auto;
  box-sizing: border-box;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.card-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.goods-line {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.goods-line.disabled {
  opacity: 0.48;
}

.check {
  width: 36rpx;
  height: 36rpx;
  border: 2rpx solid #ddd;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 22rpx;
  flex-shrink: 0;
}

.check.checked {
  background: #e93323;
  border-color: #e93323;
}

.goods-info {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.goods-name {
  font-size: 26rpx;
  color: #333;
}

.goods-sku {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}

.goods-price {
  font-size: 26rpx;
  color: #e93323;
  font-weight: 600;
}

.reason-list {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.reason-item {
  margin: 0;
  line-height: 1.6;
  background: #f7f7f7;
  color: #555;
  font-size: 24rpx;
  padding: 12rpx 24rpx;
  border-radius: 28rpx;
}

.reason-item.active {
  background: #e93323;
  color: #fff;
}

.explain-input {
  width: 100%;
  height: 160rpx;
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx;
  box-sizing: border-box;
  font-size: 26rpx;
  margin-top: 20rpx;
}

.submit-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 40rpx;
  padding: 22rpx 0;
  font-size: 30rpx;
}

.submit-btn[disabled] {
  background: #c8c9cc;
}

.policy-warning {
  margin-bottom: 20rpx;
  padding: 20rpx 24rpx;
  border-radius: 12rpx;
  background: #fff1f0;
  color: #cf1322;
  font-size: 24rpx;
  line-height: 1.55;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
