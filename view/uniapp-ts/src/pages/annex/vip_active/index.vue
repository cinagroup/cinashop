<template>
  <view class="activation-page">
    <view class="card">
      <text class="kicker">MEMBERSHIP CARD</text>
      <text class="title">会员卡激活</text>
      <text class="description">卡密仅能使用一次。请核对卡号与密码后提交。</text>
      <view class="field"><text>会员卡号</text><input v-model="code" maxlength="20" placeholder="请输入会员卡号" /></view>
      <view class="field"><text>卡密</text><input v-model="password" maxlength="12" password placeholder="请输入 12 位卡密" /></view>
      <view class="submit" :class="{ disabled: submitting }" @tap="activate">{{ submitting ? '激活中…' : '立即激活' }}</view>
      <view class="purchase" @tap="goPurchase">没有卡密？选择会员套餐</view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { apiRedeemMembershipCard } from "@/api/membership";

const code = ref("");
const password = ref("");
const submitting = ref(false);

async function activate() {
  if (submitting.value) return;
  const cardCode = code.value.trim();
  const cardPassword = password.value.trim();
  if (!cardCode || !cardPassword) return uni.showToast({ title: "请填写卡号和卡密", icon: "none" });
  submitting.value = true;
  try {
    await apiRedeemMembershipCard(cardCode, cardPassword);
    password.value = "";
    uni.showToast({ title: "会员激活成功", icon: "success" });
    setTimeout(() => uni.redirectTo({ url: "/pages/user/vipOpen" }), 900);
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "激活失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

function goPurchase() {
  uni.redirectTo({ url: "/pages/user/vipOpen" });
}
</script>

<style scoped>
.activation-page { min-height: 100vh; padding: 70rpx 28rpx; box-sizing: border-box; background: radial-gradient(circle at 80% 0, #ead8ac, transparent 35%), #f6f1e7; }
.card { padding: 46rpx 34rpx; border-radius: 30rpx; background: #fff; box-shadow: 0 24rpx 70rpx rgba(69,49,19,.13); }
.kicker,.title,.description { display: block; }
.kicker { color: #a57a30; letter-spacing: .16em; font-size: 20rpx; }
.title { margin-top: 10rpx; color: #2f2517; font-size: 44rpx; font-weight: 800; }
.description { margin: 12rpx 0 40rpx; color: #827665; font-size: 24rpx; line-height: 1.7; }
.field { margin-top: 22rpx; }
.field text { display: block; margin-bottom: 12rpx; color: #554b3e; font-size: 25rpx; }
.field input { height: 88rpx; padding: 0 24rpx; border: 2rpx solid #e7dfd2; border-radius: 18rpx; background: #fcfaf6; font-family: monospace; }
.submit { margin-top: 42rpx; padding: 25rpx; border-radius: 44rpx; text-align: center; color: #fff; background: linear-gradient(135deg, #332714, #ac7e31); font-weight: 700; }
.submit.disabled { opacity: .55; }
.purchase { padding-top: 30rpx; text-align: center; color: #9a6f27; font-size: 24rpx; }
</style>
