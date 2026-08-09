<template>
  <view class="login-page">
    <view class="login-box">
      <view class="logo">CinaShop</view>
      <view class="title">欢迎登录</view>

      <view class="form-item">
        <input
          class="input"
          v-model="account"
          placeholder="请输入手机号"
          type="number"
          maxlength="11"
        />
      </view>
      <view class="form-item">
        <input
          class="input"
          v-model="password"
          placeholder="请输入密码"
          :password="!showPwd"
        />
      </view>

      <view class="login-btn" @tap="handleLogin">登录</view>
      <view class="to-register" @tap="goRegister">没有账号? 立即注册</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { apiLogin } from "@/api/auth";
import { useAuthStore } from "@/stores/auth";

const account = ref("");
const password = ref("");
const showPwd = ref(false);
const authStore = useAuthStore();

async function handleLogin() {
  if (!account.value) return uni.showToast({ title: "请输入手机号", icon: "none" });
  if (!password.value) return uni.showToast({ title: "请输入密码", icon: "none" });
  try {
    const result = await apiLogin(account.value, password.value);
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

function goRegister() {
  uni.navigateTo({ url: "/pages/auth/register" });
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

.to-register {
  text-align: center;
  color: #e93323;
  font-size: 26rpx;
  margin-top: 30rpx;
}
</style>
