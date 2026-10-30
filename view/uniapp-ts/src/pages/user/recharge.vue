<template>
  <ThemePage>
  <view class="recharge-page">
    <!-- 当前余额 -->
    <view class="balance-card">
      <view class="balance-label">当前余额 (元)</view>
      <view class="balance-num">{{ balance }}</view>
      <view class="logs-link" @tap="goLogs">📊 明细 ›</view>
    </view>

    <!-- 金额选择 -->
    <view class="amount-card">
      <view class="amount-title">选择充值金额</view>
      <view class="amount-grid">
        <view
          v-for="amt in amounts"
          :key="amt"
          class="amount-item"
          :class="{ active: selected === amt }"
          @tap="selected = amt"
        >
          ¥{{ amt }}
          <text v-if="quotaGifts[String(amt)]" class="amount-gift">
            赠 ¥{{ quotaGifts[String(amt)] }}
          </text>
        </view>
      </view>
    </view>

    <view class="payment-card">
      <view>
        <text class="payment-title">微信支付</text>
        <text class="payment-sub">到账以支付平台回调为准</text>
      </view>
      <text :class="{ unavailable: !wechatReady }">
        {{ wechatReady ? "可用" : (paymentReason || "不可用") }}
      </text>
    </view>

    <view
      class="recharge-btn"
      :class="{ disabled: submitting || !wechatReady }"
      @tap="submit"
    >
      {{ submitting ? "正在发起支付..." : `立即充值 ¥${selected}` }}
    </view>

    <view v-if="commissionEnabled" class="commission-card">
      <view class="commission-heading">
        <view>
          <text class="payment-title">佣金转余额</text>
          <text class="payment-sub">佣金余额 ¥{{ brokerageBalance }}</text>
        </view>
        <text>服务端会扣除冻结佣金</text>
      </view>
      <input
        v-model="transferAmount"
        class="commission-input"
        type="digit"
        placeholder="请输入转入金额"
      />
      <view
        class="commission-btn"
        :class="{ disabled: transferSubmitting }"
        @tap="submitCommissionTransfer"
      >
        {{ transferSubmitting ? "正在转入..." : "转入余额" }}
      </view>
      <text class="commission-warning">转入后只能用于商城消费，不能再转回佣金或提现。</text>
    </view>
  </view>
  <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
// #ifdef APP-PLUS
import { onUnmounted } from 'vue';
import { onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { reserveNativeWechatPayment } from '@/utils/nativeWechatPaymentEntry';
// #endif
import { ref, onMounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiOrderCashier, apiPaymentReadiness, apiRechargePay } from "@/api/order";
import { http, getFormType } from "@/utils/request";

const balance = ref("0.00");
const brokerageBalance = ref("0.00");
const commissionEnabled = ref(false);
const transferAmount = ref("");
const transferSubmitting = ref(false);
const amounts = ref<number[]>([50, 100, 200, 500, 1000]);
const selected = ref(100);
const submitting = ref(false);
const wechatReady = ref(false);
const paymentReason = ref("");
const quotaIds = ref<Record<string, number>>({});
const quotaGifts = ref<Record<string, string>>({});
const PENDING_RECHARGE_KEY = "cinashop_pending_recharge";
// #ifdef APP-PLUS
const nativeAuth = useAuthStore();
let nativeLifetime = 0, nativeDisposed = false;
onHide(() => { nativeLifetime++; });
const retireNativePaymentView = () => { nativeDisposed = true; nativeLifetime++; };
onUnload(retireNativePaymentView);
onUnmounted(retireNativePaymentView);
function captureNativePaymentView(): () => boolean {
  const owner = { uid: nativeAuth.uid, token: nativeAuth.token, version: nativeAuth.sessionVersion, lifetime: nativeLifetime };
  return () => !nativeDisposed && owner.lifetime === nativeLifetime && owner.uid > 0 && !!owner.token
    && nativeAuth.uid === owner.uid && nativeAuth.token === owner.token && nativeAuth.sessionVersion === owner.version;
}
function assertNativeRechargeCashier(value: unknown, orderId: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('充值核对响应无效');
  const row = value as Record<string, unknown>;
  if (row.order_id !== orderId || row.type !== 'recharge' || typeof row.paid !== 'boolean'
    || typeof row.now_money !== 'string' || !/^\d+\.\d{2}$/u.test(row.now_money)
    || !Number.isSafeInteger(Number(row.now_money.replace('.', '')))) throw Error('充值核对响应与本次订单不一致');
}
// #endif

async function loadBalance(current: () => boolean = () => true) {
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    if (!current()) return;
    balance.value = String(info.now_money ?? "0.00");
    brokerageBalance.value = String(info.brokerage_price ?? "0.00");
  } catch {
    if (!current()) return;
    // 静默
  }
}

async function loadPackages() {
  try {
    const idx = await http.get<{
      recharge_quota: { id: number; price: string; give_money: string }[];
      recharge_attention: string[];
      user_extract_balance_status: number;
    }>("/recharge/index");
    commissionEnabled.value = idx.user_extract_balance_status === 1;
    if (Array.isArray(idx.recharge_quota) && idx.recharge_quota.length) {
      const valid = idx.recharge_quota.filter((item) => Number(item.price) > 0);
      const list = valid.map((item) => Number(item.price));
      if (list.length) {
        amounts.value = list;
        selected.value = list[0];
        quotaIds.value = Object.fromEntries(
          valid.map((item) => [String(Number(item.price)), item.id]),
        );
        quotaGifts.value = Object.fromEntries(
          valid
            .filter((item) => Number(item.give_money) > 0)
            .map((item) => [String(Number(item.price)), Number(item.give_money).toFixed(2)]),
        );
      }
    }
  } catch {
    // 使用默认金额
  }
}

async function submit() {
  let current = () => true;
  // #ifdef APP-PLUS
  current = captureNativePaymentView();
  if (!current()) return;
  // #endif
  if (submitting.value || !wechatReady.value) {
    if (!wechatReady.value) {
      uni.showToast({ title: paymentReason.value || "微信支付不可用", icon: "none" });
    }
    return;
  }
  submitting.value = true;
  // #ifdef APP-PLUS
  let nativeAttempt: ReturnType<typeof reserveNativeWechatPayment> | undefined;
  // #endif
  try {
    // #ifdef APP-PLUS
    nativeAttempt = reserveNativeWechatPayment(current);
    // #endif
    const channel = paymentChannel();
    const res = await http.post<{ orderId: string; price: string }>("/recharge/recharge", {
      price: selected.value,
      channel,
      rechar_id: quotaIds.value[String(selected.value)] ?? 0,
      type: 0,
    });
    if (!current()) return;
    // #ifdef APP-PLUS
    if (typeof res.orderId !== 'string' || !res.orderId || res.orderId.length > 128) throw Error('充值订单标识无效，请刷新核对');
    // #endif
    uni.setStorageSync(PENDING_RECHARGE_KEY, res.orderId);
    const payment = await apiRechargePay(res.orderId, channel);
    if (!current()) return;
    // #ifdef APP-PLUS
    if (payment.order_id !== res.orderId || payment.pay_type !== 'weixin' || typeof payment.paid !== 'boolean' || !payment.paid && payment.pay_mode !== 'app')
      throw Error('支付结果与本次充值订单或原生渠道不一致，请刷新核对');
    // #endif
    // #ifdef APP-PLUS
    if (!payment.paid) await nativeAttempt.request(payment.jsConfig ?? {});
    // #endif
    // #ifndef APP-PLUS
    if (await continueWechatPayment(payment.jsConfig ?? {}, current)) return;
    // #endif
    if (!current()) return;
    if (await waitForRecharge(res.orderId, current)) {
      if (!current()) return;
      // #ifdef APP-PLUS
      if (uni.getStorageSync(PENDING_RECHARGE_KEY) === res.orderId) uni.removeStorageSync(PENDING_RECHARGE_KEY);
      // #endif
      // #ifndef APP-PLUS
      uni.removeStorageSync(PENDING_RECHARGE_KEY);
      // #endif
      uni.showToast({ title: "充值到账", icon: "success" });
      await loadBalance(current);
    } else if (current()) {
      uni.showToast({ title: "充值结果确认中，请稍后刷新", icon: "none" });
    }
  } catch (e) {
    if (current()) uni.showToast({ title: (e as Error).message || "充值失败", icon: "none" });
  } finally {
    // #ifdef APP-PLUS
    nativeAttempt?.release();
    // #endif
    submitting.value = false;
  }
}

async function submitCommissionTransfer() {
  if (transferSubmitting.value) return;
  const amount = Number(transferAmount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    uni.showToast({ title: "请输入有效转入金额", icon: "none" });
    return;
  }
  const confirmed = await new Promise<boolean>((resolve) => {
    uni.showModal({
      title: "确认佣金转余额",
      content: `确认转入 ¥${amount.toFixed(2)}？转入后不可转回或提现。`,
      confirmText: "确认转入",
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;
  transferSubmitting.value = true;
  try {
    const result = await http.post<{
      nowMoney: string;
      brokeragePrice: string;
    }>("/recharge/recharge", { price: amount, type: 1, from: "balance" });
    balance.value = result.nowMoney;
    brokerageBalance.value = result.brokeragePrice;
    transferAmount.value = "";
    uni.showToast({ title: "佣金已转入余额", icon: "success" });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "转入失败", icon: "none" });
  } finally {
    transferSubmitting.value = false;
  }
}

function paymentChannel(): string {
  const platform = getFormType();
  // #ifdef H5
  if (/MicroMessenger/i.test(window.navigator.userAgent)) return "weixin";
  // #endif
  return platform;
}

async function continueWechatPayment(config: Record<string, unknown>, current: () => boolean = () => true): Promise<boolean> {
  const h5Url = typeof config.h5_url === "string" ? config.h5_url : "";
  if (h5Url) {
    // #ifdef H5
    window.location.assign(h5Url);
    // #endif
    return true;
  }
  // #ifdef H5
  const bridge = (window as unknown as {
    WeixinJSBridge?: {
      invoke(
        name: string,
        config: Record<string, unknown>,
        callback: (response: { err_msg?: string }) => void,
      ): void;
    };
  }).WeixinJSBridge;
  if (!bridge) throw new Error("请在微信内打开并完成支付");
  await new Promise<void>((resolve, reject) => {
    bridge.invoke("getBrandWCPayRequest", config, (response) => {
      response.err_msg === "get_brand_wcpay_request:ok"
        ? resolve()
        : reject(new Error("微信支付未完成"));
    });
  });
  // #endif
  // #ifndef H5
  await new Promise<void>((resolve, reject) => {
    uni.requestPayment({
      provider: "wxpay",
      timeStamp: String(config.timeStamp ?? ""),
      nonceStr: String(config.nonceStr ?? ""),
      package: String(config.package ?? ""),
      signType: String(config.signType ?? "RSA") as "MD5" | "HMAC-SHA256" | "RSA",
      paySign: String(config.paySign ?? ""),
      success: () => resolve(),
      fail: (error) => reject(new Error(error.errMsg)),
    });
  });
  // #endif
  return false;
}

async function waitForRecharge(orderId: string, current: () => boolean = () => true): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!current()) return false;
    const cashier = await apiOrderCashier(orderId, "recharge");
    if (!current()) return false;
    // #ifdef APP-PLUS
    assertNativeRechargeCashier(cashier, orderId);
    // #endif
    if (cashier.paid) return true;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

async function loadPaymentReadiness() {
  try {
    const readiness = await apiPaymentReadiness();
    wechatReady.value = readiness.weixin.enabled;
    paymentReason.value = readiness.weixin.reason;
  } catch (error) {
    paymentReason.value = error instanceof Error ? error.message : "支付状态加载失败";
  }
}

async function checkPendingRecharge() {
  let current = () => true;
  // #ifdef APP-PLUS
  current = captureNativePaymentView();
  if (!current()) return;
  // #endif
  const orderId = String(uni.getStorageSync(PENDING_RECHARGE_KEY) ?? "");
  if (!orderId) return;
  try {
    const cashier = await apiOrderCashier(orderId, "recharge");
    if (!current()) return;
    // #ifdef APP-PLUS
    assertNativeRechargeCashier(cashier, orderId);
    if (uni.getStorageSync(PENDING_RECHARGE_KEY) !== orderId) return;
    // #endif
    if (cashier.paid) {
      uni.removeStorageSync(PENDING_RECHARGE_KEY);
      balance.value = cashier.now_money;
      uni.showToast({ title: "充值到账", icon: "success" });
    }
  } catch {
    if (!current()) return;
    // 保留待确认单号，供下次回到页面继续确认。
  }
}

function goLogs() {
  uni.navigateTo({ url: "/pages/user/balanceLogs" });
}

onMounted(() => {
  loadPackages();
  // #ifdef APP-PLUS
  void loadBalance(captureNativePaymentView());
  // #endif
  // #ifndef APP-PLUS
  loadBalance();
  // #endif
  loadPaymentReadiness();
});

onShow(() => {
  void checkPendingRecharge();
});
</script>

<style scoped>
.recharge-page {
  padding: 20rpx;
}

.balance-card {
  background: linear-gradient(135deg, var(--view-theme, #e93323), var(--view-gradient, #FF7931));
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.balance-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.balance-num {
  font-size: 56rpx;
  font-weight: 700;
  margin-top: 10rpx;
}

.amount-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.amount-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.amount-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.amount-item {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  width: calc(33.33% - 11rpx);
  text-align: center;
  padding: 24rpx 0;
  border: 2rpx solid #eee;
  border-radius: 12rpx;
  font-size: 30rpx;
  font-weight: 600;
  color: #333;
  box-sizing: border-box;
}

.amount-item.active {
  border-color: var(--view-priceColor, #e93323);
  color: var(--view-priceColor, #e93323);
  background: #fff5f5;
}

.amount-gift {
  color: #e6a23c;
  font-size: 22rpx;
  font-weight: 500;
}

.payment-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 20rpx;
  padding: 24rpx;
  border-radius: 16rpx;
  background: #fff;
}

.payment-card > view {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.payment-title {
  font-size: 28rpx;
  font-weight: 600;
}

.payment-sub {
  color: #999;
  font-size: 22rpx;
}

.payment-card > text {
  color: #20a162;
}

.payment-card > text.unavailable {
  max-width: 55%;
  color: #999;
  text-align: right;
}

.recharge-btn {
  background: var(--view-theme, #e93323);
  color: #fff;
  text-align: center;
  border-radius: 44rpx;
  padding: 24rpx 0;
  font-size: 30rpx;
  font-weight: 600;
  margin-top: 30rpx;
}

.recharge-btn.disabled {
  opacity: .5;
}

.commission-card {
  margin-top: 24rpx;
  padding: 24rpx;
  border-radius: 16rpx;
  background: #fff;
}

.commission-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16rpx;
}

.commission-heading > view {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.commission-heading > text {
  max-width: 45%;
  color: #999;
  font-size: 22rpx;
  text-align: right;
}

.commission-input {
  box-sizing: border-box;
  width: 100%;
  height: 80rpx;
  margin-top: 22rpx;
  padding: 0 22rpx;
  border: 2rpx solid #eee;
  border-radius: 12rpx;
}

.commission-btn {
  margin-top: 18rpx;
  padding: 22rpx 0;
  border-radius: 40rpx;
  background: #e6a23c;
  color: #fff;
  text-align: center;
  font-weight: 600;
}

.commission-btn.disabled {
  opacity: .5;
}

.commission-warning {
  display: block;
  margin-top: 14rpx;
  color: #999;
  font-size: 22rpx;
  line-height: 1.5;
}
</style>
