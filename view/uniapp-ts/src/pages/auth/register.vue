<template>
  <view class="register-page">
    <view class="login-box">
      <view class="logo">CinaShop</view>
      <view class="title">注册新账号</view>

      <view class="form-item">
        <input
          class="input"
          v-model="account"
          placeholder="请输入手机号"
          type="number"
          maxlength="11"
        />
      </view>
      <view class="form-item code-row">
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
      <view class="form-item">
        <input
          class="input"
          v-model="password"
          placeholder="请输入密码 (至少6位)"
          :password="true"
        />
      </view>
      <view class="form-item">
        <input
          class="input"
          v-model="confirm"
          placeholder="确认密码"
          :password="true"
        />
      </view>

      <view class="login-btn" @tap="doRegister">注册</view>
      <view class="to-login" @tap="goLogin">已有账号? 去登录</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { apiRegister, apiRequestCode } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";
import { requestSmsChallenge, resumePendingSmsChallenge } from "@/utils/smsChallenge";

const account = ref("");
const password = ref("");
const confirm = ref("");
const captcha = ref("");
const countdown = ref(0);
const codeSending = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const authStore = useAuthStore();

async function doRegister() {
  if (!/^1\d{10}$/.test(account.value)) return uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  if (!/^\d{6}$/.test(captcha.value)) return uni.showToast({ title: "请输入 6 位验证码", icon: "none" });
  if (password.value.length < 6) return uni.showToast({ title: "密码至少 6 位", icon: "none" });
  if (password.value !== confirm.value) return uni.showToast({ title: "两次密码不一致", icon: "none" });
  try {
    const res = await apiRegister(account.value, captcha.value, password.value, confirm.value);
    // 自动登录
    let uid = 0;
    try {
      const payload = JSON.parse(atob(res.token.split(".")[1]));
      uid = payload.jti?.id ?? 0;
    } catch {}
    authStore.setLogin(res.token, uid);
    uni.showToast({ title: "注册成功", icon: "success" });
    setTimeout(() => uni.switchTab({ url: "/pages/index/index" }), 800);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "注册失败", icon: "none" });
  }
}

async function sendCode() {
  if (countdown.value > 0 || codeSending.value) return;
  if (!/^1\d{10}$/.test(account.value)) {
    return uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  }
  codeSending.value = true;
  try {
    const key = await requestSmsChallenge(account.value, "register");
    await apiRequestCode(account.value, "register", key);
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

function goLogin() {
  uni.navigateTo({ url: "/pages/auth/login" });
}
</script>

<style scoped>
.register-page {
  padding: 80rpx 60rpx;
}

.logo {
  text-align: center;
  font-size: 48rpx;
  font-weight: 700;
  color: #e93323;
}

.title {
  text-align: center;
  font-size: 30rpx;
  color: #666;
  margin: 20rpx 0 60rpx;
}

.form-item {
  background: #fff;
  border-radius: 40rpx;
  padding: 24rpx 30rpx;
  margin-bottom: 24rpx;
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
  padding-left: 24rpx;
  color: #e93323;
  font-size: 25rpx;
}

.login-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 40rpx;
  padding: 24rpx 0;
  font-size: 30rpx;
  margin-top: 20rpx;
}

.to-login {
  text-align: center;
  color: #e93323;
  font-size: 26rpx;
  margin-top: 30rpx;
}
</style>
