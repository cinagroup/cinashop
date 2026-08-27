<template>
  <view class="reset-page">
    <view class="reset-card">
      <view class="title">找回密码</view>
      <view class="subtitle">验证注册手机号后设置新密码</view>

      <view class="form-item">
        <input v-model="account" class="input" type="number" maxlength="11" placeholder="请输入注册手机号" />
      </view>
      <view class="form-item code-row">
        <input v-model="captcha" class="input code-input" type="number" maxlength="6" placeholder="请输入 6 位验证码" />
        <view :class="['code-button', { disabled: countdown > 0 || codeSending }]" @tap="sendCode">
          {{ countdown > 0 ? `${countdown}s` : (codeSending ? "提交中" : "获取验证码") }}
        </view>
      </view>
      <view class="form-item">
        <input v-model="password" class="input" :password="true" maxlength="16" placeholder="请输入 6–16 位新密码" />
      </view>
      <view class="form-item">
        <input v-model="confirm" class="input" :password="true" maxlength="16" placeholder="请再次输入新密码" />
      </view>

      <view :class="['submit', { disabled: submitting }]" @tap="submitReset">
        {{ submitting ? "提交中" : "确认重置" }}
      </view>
      <view class="back-login" @tap="backToLogin">返回登录</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiRequestCode, apiResetPassword } from "@/api/auth";
import { requestSmsChallenge, resumePendingSmsChallenge } from "@/utils/smsChallenge";

const account = ref("");
const captcha = ref("");
const password = ref("");
const confirm = ref("");
const codeSending = ref(false);
const submitting = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | undefined;

function validatePhone(): boolean {
  if (/^1\d{10}$/.test(account.value)) return true;
  uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  return false;
}

function startCountdown(): void {
  countdown.value = 60;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
  }, 1000);
}

async function sendCode(): Promise<void> {
  if (countdown.value > 0 || codeSending.value || !validatePhone()) return;
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(account.value, "reset");
    await apiRequestCode(account.value, "reset", key);
    uni.showToast({ title: "验证码任务已提交", icon: "success" });
    startCountdown();
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "验证码发送失败", icon: "none" });
  } finally {
    codeSending.value = false;
  }
}

async function submitReset(): Promise<void> {
  if (submitting.value || !validatePhone()) return;
  if (!/^\d{6}$/.test(captcha.value)) return uni.showToast({ title: "请输入 6 位验证码", icon: "none" });
  if (password.value.length < 6 || password.value.length > 16) return uni.showToast({ title: "密码必须为 6–16 位", icon: "none" });
  if (password.value === "123456") return uni.showToast({ title: "密码太过简单，请重新设置", icon: "none" });
  if (password.value !== confirm.value) return uni.showToast({ title: "两次密码不一致", icon: "none" });
  submitting.value = true;
  try {
    await apiResetPassword(account.value, captcha.value, password.value);
    uni.showToast({ title: "密码已重置", icon: "success" });
    setTimeout(() => uni.redirectTo({ url: "/pages/auth/login" }), 700);
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "密码重置失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

function backToLogin(): void {
  uni.redirectTo({ url: "/pages/auth/login" });
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

onShow(() => {
  void resumePendingSmsChallenge();
});
</script>

<style scoped>
.reset-page {
  min-height: 100vh;
  padding: 100rpx 48rpx;
  box-sizing: border-box;
  background: linear-gradient(145deg, #fff5f4, #fff);
}

.reset-card {
  padding: 52rpx 38rpx;
  border-radius: 24rpx;
  background: #fff;
  box-shadow: 0 10rpx 42rpx rgba(0, 0, 0, 0.07);
}

.title {
  color: #222;
  font-size: 40rpx;
  font-weight: 700;
  text-align: center;
}

.subtitle {
  margin: 14rpx 0 44rpx;
  color: #999;
  font-size: 25rpx;
  text-align: center;
}

.form-item {
  margin-bottom: 24rpx;
  padding: 24rpx 28rpx;
  border-radius: 14rpx;
  background: #f7f7f7;
}

.input {
  font-size: 28rpx;
}

.code-row {
  display: flex;
  align-items: center;
}

.code-input {
  flex: 1;
}

.code-button {
  flex-shrink: 0;
  padding-left: 22rpx;
  color: #e93323;
  font-size: 25rpx;
}

.code-button.disabled,
.submit.disabled {
  opacity: 0.55;
}

.submit {
  margin-top: 36rpx;
  padding: 24rpx;
  border-radius: 42rpx;
  background: #e93323;
  color: #fff;
  font-size: 30rpx;
  text-align: center;
}

.back-login {
  margin-top: 28rpx;
  color: #e93323;
  font-size: 26rpx;
  text-align: center;
}
</style>
