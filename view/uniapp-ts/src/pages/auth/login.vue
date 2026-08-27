<template>
  <view class="login-page">
    <view class="login-box">
      <view class="logo">CinaShop</view>
      <view class="title">欢迎登录</view>

      <view class="mode-tabs">
        <view :class="['mode-tab', { active: mode === 'password' }]" @tap="mode = 'password'">密码登录</view>
        <view :class="['mode-tab', { active: mode === 'mobile' }]" @tap="mode = 'mobile'">验证码登录</view>
      </view>

      <view class="form-item">
        <input
          class="input"
          v-model="account"
          placeholder="请输入手机号"
          type="number"
          maxlength="11"
        />
      </view>
      <view v-if="mode === 'password'" class="form-item">
        <input
          class="input"
          v-model="password"
          placeholder="请输入密码"
          :password="!showPwd"
        />
      </view>

      <view v-else class="form-item code-row">
        <input
          class="input code-input"
          v-model="captcha"
          placeholder="请输入 6 位验证码"
          type="number"
          maxlength="6"
        />
        <view class="code-button" @tap="sendCode">
          {{ countdown > 0 ? `${countdown}s` : (codeSending ? "提交中" : "获取验证码") }}
        </view>
      </view>

      <view class="login-btn" @tap="handleLogin">{{ mode === "mobile" ? "登录/注册" : "登录" }}</view>
      <view class="auth-links">
        <view @tap="goRegister">没有账号? 立即注册</view>
        <view @tap="goReset">忘记密码</view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiLogin, apiMobileLogin, apiRequestCode } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";
import { requestSmsChallenge, resumePendingSmsChallenge } from "@/utils/smsChallenge";

const account = ref("");
const password = ref("");
const showPwd = ref(false);
const mode = ref<"password" | "mobile">("password");
const captcha = ref("");
const countdown = ref(0);
const codeSending = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const authStore = useAuthStore();

async function handleLogin() {
  if (!/^1\d{10}$/.test(account.value)) {
    return uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  }
  if (mode.value === "password" && !password.value) {
    return uni.showToast({ title: "请输入密码", icon: "none" });
  }
  if (mode.value === "mobile" && !/^\d{6}$/.test(captcha.value)) {
    return uni.showToast({ title: "请输入 6 位验证码", icon: "none" });
  }
  try {
    const result = mode.value === "mobile"
      ? await apiMobileLogin(account.value, captcha.value)
      : await apiLogin(account.value, password.value);
    // 从 token payload 解析 uid
    let uid = 0;
    try {
      const payload = JSON.parse(atob(result.token.split(".")[1]));
      uid = payload.jti?.id ?? 0;
    } catch {
      // ignore
    }
    authStore.setLogin(result.token, uid);
    uni.showToast({ title: "登录成功", icon: "success" });
    setTimeout(() => uni.navigateBack(), 800);
  } catch (e) {
    uni.showToast({
      title: e instanceof Error ? e.message : "登录失败",
      icon: "none",
    });
  }
}

async function sendCode() {
  if (countdown.value > 0 || codeSending.value) return;
  if (!/^1\d{10}$/.test(account.value)) {
    return uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  }
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(account.value, "mobile");
    await apiRequestCode(account.value, "mobile", key);
    uni.showToast({ title: "验证码任务已提交", icon: "success" });
    countdown.value = 60;
    countdownTimer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0 && countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = undefined;
      }
    }, 1000);
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "验证码发送失败", icon: "none" });
  } finally {
    codeSending.value = false;
  }
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer);
});

onShow(() => {
  void resumePendingSmsChallenge();
});

function goRegister() {
  uni.navigateTo({ url: "/pages/auth/register" });
}

function goReset() {
  uni.navigateTo({ url: "/pages/auth/reset" });
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #fff5f5, #fff);
}

.login-box {
  width: 80%;
  background: #fff;
  border-radius: 24rpx;
  padding: 60rpx 40rpx;
  box-shadow: 0 8rpx 40rpx rgba(0, 0, 0, 0.08);
}

.logo {
  text-align: center;
  font-size: 48rpx;
  font-weight: 700;
  color: #e93323;
}

.title {
  text-align: center;
  font-size: 28rpx;
  color: #999;
  margin: 16rpx 0 40rpx;
}

.form-item {
  background: #f8f8f8;
  border-radius: 12rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.mode-tabs {
  display: flex;
  margin-bottom: 28rpx;
  border-bottom: 2rpx solid #f2f2f2;
}

.mode-tab {
  flex: 1;
  padding: 18rpx 0;
  text-align: center;
  color: #999;
  font-size: 27rpx;
}

.mode-tab.active {
  color: #e93323;
  border-bottom: 4rpx solid #e93323;
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
  padding-left: 24rpx;
  color: #e93323;
  font-size: 25rpx;
}

.input {
  font-size: 28rpx;
}

.login-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 24rpx;
  border-radius: 40rpx;
  font-size: 30rpx;
  margin-top: 20rpx;
}

.auth-links {
  display: flex;
  justify-content: space-between;
  color: #e93323;
  font-size: 26rpx;
  margin-top: 30rpx;
}
</style>
