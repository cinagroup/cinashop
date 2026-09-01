<template>
  <view class="vip-page">
    <view class="vip-banner">
      <text class="vip-kicker">CINASHOP MEMBERSHIP</text>
      <text class="vip-title">付费会员</text>
      <text class="vip-sub">会员专享价、权益与优惠券，以当前套餐为准</text>
      <view v-if="home" class="account-row">
        <text>余额 ¥{{ home.is_get_free.user_info.now_money }}</text>
        <text v-if="home.is_get_free.user_info.is_ever_level">永久会员</text>
        <text v-else-if="home.is_get_free.user_info.is_money_level">会员有效期至 {{ memberExpiry }}</text>
        <text v-else>当前未开通</text>
      </view>
    </view>

    <view v-if="loading" class="state">会员套餐加载中…</view>
    <view v-else-if="!home?.member_type.length" class="state">暂无可用会员套餐</view>
    <view v-else class="plan-list">
      <view
        v-for="plan in home.member_type"
        :key="plan.id"
        class="plan-card"
        :class="{ active: selectedPlan?.id === plan.id }"
        @tap="selectPlan(plan)"
      >
        <view class="plan-top"><text class="plan-title">{{ plan.title }}</text><text v-if="plan.is_label" class="tag">推荐</text></view>
        <text class="plan-duration">{{ plan.type === 'ever' ? '永久有效' : `${plan.vip_day} 天` }}</text>
        <view class="price-row"><text class="price">{{ plan.type === 'free' ? '免费' : `¥${plan.pre_price}` }}</text><text v-if="plan.type !== 'free'" class="list-price">¥{{ plan.price }}</text></view>
        <text class="expiry">开通后：{{ plan.overdue_time }}</text>
      </view>
    </view>

    <view v-if="home?.member_rights.length" class="rights-card">
      <text class="section-title">会员权益</text>
      <view v-for="right in home.member_rights" :key="right.id" class="right-row">
        <image v-if="right.pic" class="right-image" :src="right.pic" mode="aspectFill" />
        <view><text class="right-title">{{ right.title }}</text><text class="right-desc">{{ right.explain }}</text></view>
      </view>
    </view>

    <view v-if="selectedPlan?.type !== 'free'" class="pay-card">
      <text class="section-title">支付方式</text>
      <view class="pay-row" :class="{ active: payType === 'yue', disabled: !readiness?.yue.enabled }" @tap="selectPayType('yue')"><text>余额支付</text><text>{{ readiness?.yue.enabled ? `¥${home?.is_get_free.user_info.now_money ?? '0.00'}` : readiness?.yue.reason }}</text></view>
      <view class="pay-row" :class="{ active: payType === 'weixin', disabled: !readiness?.weixin.enabled }" @tap="selectPayType('weixin')"><text>微信支付</text><text>{{ readiness?.weixin.enabled ? '›' : readiness?.weixin.reason }}</text></view>
      <view v-if="channel === 'h5'" class="pay-row" :class="{ active: payType === 'alipay', disabled: !readiness?.alipay.enabled }" @tap="selectPayType('alipay')"><text>支付宝</text><text>{{ readiness?.alipay.enabled ? '›' : readiness?.alipay.reason }}</text></view>
    </view>

    <view class="activation-link" @tap="goActivation">已有会员卡？使用卡密激活</view>
    <view class="bottom-space" />
    <view class="submit-bar">
      <view class="submit-btn" :class="{ disabled: submitting || !selectedPlan || !canSubmit }" @tap="submit">
        {{ submitting ? '处理中…' : submitText }}
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import {
  apiCreateMembershipOrder,
  apiMembershipHome,
  apiPayMembershipOrder,
  type MembershipHome,
  type MembershipPlan,
} from "@/api/membership";
import { apiPaymentReadiness } from "@/api/order";
import type { PaymentReadiness } from "@/types/order";
import { getFormType } from "@/utils/request";

const channel = getFormType();
const loading = ref(false);
const submitting = ref(false);
const home = ref<MembershipHome | null>(null);
const selectedPlan = ref<MembershipPlan | null>(null);
const payType = ref<"yue" | "weixin" | "alipay">("yue");
const readiness = ref<PaymentReadiness | null>(null);

const submitText = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) return "请选择套餐";
  return plan.type === "free" ? "免费领取" : `立即开通 ¥${plan.pre_price}`;
});
const memberExpiry = computed(() => {
  const epoch = home.value?.is_get_free.user_info.overdue_time ?? 0;
  return epoch > 0 ? new Date(epoch * 1000).toLocaleDateString() : "—";
});
const canSubmit = computed(() => {
  if (!selectedPlan.value) return false;
  if (selectedPlan.value.type === "free") return true;
  return readiness.value?.[payType.value].enabled === true;
});

async function load() {
  loading.value = true;
  try {
    home.value = await apiMembershipHome();
    try {
      readiness.value = await apiPaymentReadiness();
    } catch {
      // Free membership must remain usable when payment-readiness lookup fails.
      readiness.value = null;
    }
    selectedPlan.value = home.value.member_type.find((plan) => plan.is_label === 1)
      ?? home.value.member_type[0]
      ?? null;
    const firstEnabled = (["yue", "weixin", "alipay"] as const)
      .find((method) => readiness.value?.[method].enabled);
    if (firstEnabled) payType.value = firstEnabled;
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "会员信息加载失败", icon: "none" });
  } finally {
    loading.value = false;
  }
}

function selectPayType(method: "yue" | "weixin" | "alipay") {
  if (readiness.value?.[method].enabled) payType.value = method;
}

function selectPlan(plan: MembershipPlan) {
  selectedPlan.value = plan;
  if (plan.type === "free") payType.value = "yue";
}

async function submit() {
  const plan = selectedPlan.value;
  if (!plan || submitting.value || !canSubmit.value) {
    if (plan?.type !== "free") {
      uni.showToast({ title: readiness.value?.[payType.value].reason || "支付方式不可用", icon: "none" });
    }
    return;
  }
  submitting.value = true;
  try {
    const order = await apiCreateMembershipOrder(plan.id);
    if (order.paid) {
      uni.showToast({ title: "会员领取成功", icon: "success" });
      await load();
      return;
    }
    const result = await apiPayMembershipOrder(order.order_id, payType.value);
    if (result.paid) {
      uni.showToast({ title: "会员开通成功", icon: "success" });
      await load();
      return;
    }
    if (result.pay_type === "alipay" && result.payUrl) {
      // #ifdef H5
      window.location.assign(result.payUrl);
      // #endif
      return;
    }
    if (result.pay_type === "weixin" && result.jsConfig) {
      const h5Url = typeof result.jsConfig.h5_url === "string" ? result.jsConfig.h5_url : "";
      if (h5Url) {
        // #ifdef H5
        window.location.assign(h5Url);
        // #endif
        return;
      }
      // #ifdef MP-WEIXIN
      await new Promise<void>((resolve, reject) => {
        uni.requestPayment({
          provider: "wxpay",
          timeStamp: String(result.jsConfig?.timeStamp ?? ""),
          nonceStr: String(result.jsConfig?.nonceStr ?? ""),
          package: String(result.jsConfig?.package ?? ""),
          signType: String(result.jsConfig?.signType ?? "RSA") as "MD5" | "HMAC-SHA256" | "RSA",
          paySign: String(result.jsConfig?.paySign ?? ""),
          success: () => resolve(),
          fail: (error) => reject(new Error(error.errMsg)),
        });
      });
      uni.showToast({ title: "支付已提交", icon: "success" });
      setTimeout(() => void load(), 800);
      // #endif
      return;
    }
    throw new Error("支付下单结果无效");
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "会员开通失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

function goActivation() {
  uni.navigateTo({ url: "/pages/annex/vip_active/index" });
}

onShow(load);
</script>

<style scoped>
.vip-page { min-height: 100vh; padding: 22rpx; color: #241d13; background: #f7f3eb; }
.vip-banner { padding: 42rpx 30rpx; border-radius: 28rpx; color: #fff8e7; background: radial-gradient(circle at 90% 0, rgba(255,255,255,.3), transparent 35%), linear-gradient(135deg, #251b0d, #735321 62%, #c79a45); box-shadow: 0 20rpx 50rpx rgba(71,50,15,.2); }
.vip-kicker,.vip-title,.vip-sub { display: block; }
.vip-kicker { font-size: 20rpx; letter-spacing: .16em; opacity: .72; }
.vip-title { margin-top: 10rpx; font-size: 48rpx; font-weight: 800; }
.vip-sub { margin-top: 8rpx; font-size: 24rpx; opacity: .84; }
.account-row { display: flex; justify-content: space-between; gap: 20rpx; margin-top: 30rpx; padding-top: 22rpx; border-top: 1rpx solid rgba(255,255,255,.2); font-size: 22rpx; }
.state { padding: 100rpx 20rpx; text-align: center; color: #8b806f; }
.plan-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; margin-top: 24rpx; }
.plan-card { padding: 26rpx; border: 3rpx solid transparent; border-radius: 22rpx; background: #fff; box-shadow: 0 10rpx 28rpx rgba(62,44,16,.07); }
.plan-card.active { border-color: #b88937; background: #fffaf0; }
.plan-top,.price-row { display: flex; align-items: center; gap: 12rpx; }
.plan-title { font-size: 29rpx; font-weight: 700; }
.tag { padding: 4rpx 10rpx; border-radius: 20rpx; color: #fff; background: #b88937; font-size: 18rpx; }
.plan-duration,.expiry { display: block; margin-top: 12rpx; color: #8b806f; font-size: 21rpx; }
.price-row { margin-top: 22rpx; }
.price { color: #a46f16; font-size: 38rpx; font-weight: 800; }
.list-price { color: #aaa093; text-decoration: line-through; font-size: 21rpx; }
.rights-card,.pay-card { margin-top: 24rpx; padding: 28rpx; border-radius: 22rpx; background: #fff; }
.section-title { display: block; margin-bottom: 14rpx; font-size: 30rpx; font-weight: 700; }
.right-row,.pay-row { display: flex; align-items: center; gap: 18rpx; padding: 20rpx 0; border-bottom: 1rpx solid #f0ece4; }
.right-image { width: 72rpx; height: 72rpx; border-radius: 18rpx; }
.right-title,.right-desc { display: block; }
.right-title { font-size: 27rpx; font-weight: 600; }
.right-desc { margin-top: 5rpx; color: #8b806f; font-size: 22rpx; }
.pay-row { justify-content: space-between; color: #5f5547; }
.pay-row.active { color: #9b6814; font-weight: 700; }
.pay-row.disabled { color: #aaa093; }
.activation-link { padding: 34rpx 0; text-align: center; color: #8a641f; font-size: 25rpx; }
.bottom-space { height: 130rpx; }
.submit-bar { position: fixed; right: 0; bottom: 0; left: 0; padding: 18rpx 28rpx calc(18rpx + env(safe-area-inset-bottom)); background: rgba(247,243,235,.96); }
.submit-btn { padding: 25rpx; border-radius: 50rpx; text-align: center; color: #fffaf0; background: linear-gradient(135deg, #2c210f, #a5772d); font-size: 30rpx; font-weight: 700; }
.submit-btn.disabled { opacity: .5; }
@media (max-width: 360px) { .plan-list { grid-template-columns: 1fr; } }
</style>
