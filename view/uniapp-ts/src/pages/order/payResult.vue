<template>
  <view class="pay-result">
    <view class="result-icon">{{ success ? "✅" : "📋" }}</view>
    <view class="result-title" role="status">{{ resultTitle }}</view>
    <view class="result-sub">{{ resultDescription }}</view>

    <view v-if="verified" class="order-info">
      <view class="info-line">
        <text class="label">订单号</text>
        <text class="value">{{ orderId }}</text>
      </view>
      <view v-if="amount" class="info-line">
        <text class="label">订单金额</text>
        <text class="value price">¥{{ amount }}</text>
      </view>
    </view>

    <view class="btn-area">
      <view v-if="loadError || routeError || navigationError" class="result-error" role="alert">{{ routeError || loadError || navigationError }}</view>
      <button v-if="orderId && !auth.isLoggedIn" class="btn primary" :disabled="navigating" @tap="login">登录后核对</button>
      <button v-if="orderId && auth.isLoggedIn" class="btn" :disabled="loading || navigating" @tap="load">{{ loading ? '正在核对...' : '重新核对支付结果' }}</button>
      <button v-if="orderId && auth.isLoggedIn" class="btn primary" :disabled="loading || navigating" @tap="goOrder">查看订单</button>
      <button class="btn" :disabled="navigating" @tap="goHome">继续购物</button>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiOrderDetail } from "@/api/order";
import { useAuthStore } from "@/stores/auth";
import { assertOrderDetailIdentity, orderDetailId } from "../../../../common/orderDetailIdentity";

defineOptions({ inheritAttrs: false });
const auth = useAuthStore();
const orderId = ref("");
const verified = ref<{ paid: number; status: number; refundStatus: number; payType: string; amount: string } | null>(null);
const loading = ref(false), loadError = ref(''), routeError = ref('');
const navigating = ref(false), navigationError = ref('');
let visible = false, disposed = false, revision = 0, navigationVersion = 0, lastHash = '';
const amount = computed(() => verified.value?.amount ?? '');
const resultState = computed(() => {
  if (routeError.value || !orderId.value) return 'invalid';
  if (!auth.isLoggedIn) return 'login';
  if (loading.value) return 'checking';
  if (loadError.value) return 'unknown';
  const row = verified.value;
  if (!row) return 'checking';
  if (row.refundStatus === 2) return 'refunded';
  if ([1,4].includes(row.refundStatus)) return 'refunding';
  if (row.status === -2) return 'cancelled';
  if (row.paid === 1) return 'paid';
  return row.payType === 'offline' ? 'offline' : 'unpaid';
});
const success = computed(() => resultState.value === 'paid');
const resultTitle = computed(() => ({ invalid:'无法核对支付结果', login:'请登录后核对', checking:'正在核对支付结果',
  unknown:'支付结果暂未确认', paid:'支付成功', unpaid:'尚未确认付款', offline:'待线下付款确认',
  cancelled:'订单已取消', refunded:'订单已退款', refunding:'订单退款处理中' })[resultState.value]);
const resultDescription = computed(() => {
  if (success.value) return '服务器已确认订单付款，履约和售后进度请查看订单。';
  if (resultState.value === 'unpaid' || resultState.value === 'unknown') return '未付款状态不代表支付渠道已失败。如已付款，请稍后重新核对，勿重复支付。';
  if (resultState.value === 'offline') return '线下付款尚未被确认，请查看订单并等待核实。';
  if (['refunded','refunding','cancelled'].includes(resultState.value)) return '当前状态来自服务器，退款明细及处理进度请查看订单。';
  return '仅以当前账号的服务器订单记录为准，不使用回跳链接中的状态或金额。';
});

function currentHash() {
  // #ifdef H5
  if (typeof window !== 'undefined') return window.location.hash;
  // #endif
  return '';
}
function clearView() {
  revision++; navigationVersion++; verified.value = null; loading.value = false;
  loadError.value = ''; navigationError.value = ''; navigating.value = false;
}
function capture() {
  const id = orderId.value, uid = auth.uid, token = auth.token, session = auth.sessionVersion, version = revision, hash = currentHash();
  return { id, uid, current: () => visible && !disposed && version === revision && id === orderId.value
    && uid === auth.uid && token === auth.token && session === auth.sessionVersion && hash === currentHash() };
}
async function load() {
  if (!visible || disposed || loading.value || navigating.value) return;
  clearView();
  if (routeError.value || !orderId.value) return;
  if (!auth.isLoggedIn || !auth.token || auth.uid <= 0) { loadError.value = '请登录后核对支付结果'; return; }
  const owner = capture(); loading.value = true;
  try {
    const row = await apiOrderDetail(owner.id);
    if (!owner.current()) return;
    assertOrderDetailIdentity(row, owner.id, owner.uid);
    if (!Number.isSafeInteger(row.status) || ![0,1,2,3,4].includes(row.refund_status)
      || typeof row.pay_type !== 'string') throw Error('订单支付状态响应无效，请重新核对');
    // Keep only the displayed result, not contact details or virtual delivery secrets.
    verified.value = { paid:row.paid, status:row.status, refundStatus:row.refund_status, payType:row.pay_type, amount:row.pay_price };
  } catch (error) { if (owner.current()) loadError.value = error instanceof Error ? error.message : '支付结果读取失败，请重新核对'; }
  finally { if (owner.current()) loading.value = false; }
}
function setRoute(options: { orderId?: unknown }) {
  clearView(); orderId.value = ''; routeError.value = '';
  try { orderId.value = orderDetailId(options.orderId); }
  catch (error) { routeError.value = error instanceof Error ? error.message : '订单链接无效'; }
}
function readHashRoute() {
  const hash = currentHash();
  if (!hash || hash === lastHash) return false;
  lastHash = hash;
  const route = hash.replace(/^#/, ''), index = route.indexOf('?');
  if ((index < 0 ? route : route.slice(0,index)) !== '/pages/order/payResult') { setRoute({}); return true; }
  const ids = new URLSearchParams(index < 0 ? '' : route.slice(index+1)).getAll('orderId');
  setRoute({ orderId: hash.length <= 8192 && ids.length === 1 ? ids[0] : undefined });
  void load(); return true;
}
function hashChanged() { if (visible && !disposed) readHashRoute(); }
function navigate(kind: 'redirectTo' | 'navigateTo' | 'switchTab', url: string) {
  if (!visible || disposed || navigating.value) return;
  const owner = capture(), version = ++navigationVersion; navigating.value = true; navigationError.value = '';
  const fail = () => { if (owner.current() && version === navigationVersion) { navigating.value = false; navigationError.value = '页面未打开，请重试；不会重新发起支付'; } };
  try {
    const options = { url, success() {}, fail };
    if (kind === 'redirectTo') uni.redirectTo(options);
    else if (kind === 'navigateTo') uni.navigateTo(options);
    else uni.switchTab(options);
  } catch { fail(); }
}
function goOrder() {
  if (orderId.value && auth.isLoggedIn && !loading.value) navigate('redirectTo', `/pages/order/detail?orderId=${orderId.value}`);
}
function goHome() { navigate('switchTab', '/pages/index/index'); }
function login() { if (!auth.isLoggedIn && orderId.value) navigate('navigateTo', '/pages/auth/login'); }

watch(() => auth.sessionVersion, () => { clearView(); loadError.value = '登录状态已变化，请重新核对支付结果'; }, { flush:'sync' });
onLoad(options => setRoute(options ?? {}));
onShow(() => { if (disposed) return; visible = true; if (!readHashRoute()) void load(); });
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
.pay-result {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 40rpx 0;
}

.result-icon {
  font-size: 120rpx;
  margin-bottom: 30rpx;
}

.result-title {
  font-size: 40rpx;
  font-weight: 700;
  color: #333;
}

.result-sub {
  font-size: 26rpx;
  color: #999;
  margin-top: 12rpx;
  text-align: center;
  line-height: 1.6;
}

.result-error { color: #9f4318; background: #fff7eb; padding: 24rpx; border-radius: 12rpx; overflow-wrap: anywhere; font-size: 26rpx; }

.order-info {
  width: 100%;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-top: 60rpx;
}

.info-line {
  display: flex;
  justify-content: space-between;
  padding: 14rpx 0;
  font-size: 26rpx;
  gap: 20rpx;
}

.label {
  color: #999;
}

.value {
  color: #333;
  min-width: 0;
  overflow-wrap: anywhere;
  text-align: right;
}

.value.price {
  color: #e93323;
  font-weight: 700;
}

.btn-area {
  width: 100%;
  margin-top: 80rpx;
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.btn {
  width: 100%;
  margin: 0;
  line-height: 1.5;
  text-align: center;
  padding: 24rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
  border: 2rpx solid #ddd;
  color: #666;
}

.btn.primary {
  background: #e93323;
  color: #fff;
  border-color: #e93323;
}
</style>
