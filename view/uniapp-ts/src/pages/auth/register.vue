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
import { ref } from "vue";
import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";

const account = ref("");
const password = ref("");
const confirm = ref("");
const authStore = useAuthStore();

async function doRegister() {
  if (!/^1\d{10}$/.test(account.value)) return uni.showToast({ title: "请输入正确的手机号", icon: "none" });
  if (password.value.length < 6) return uni.showToast({ title: "密码至少 6 位", icon: "none" });
  if (password.value !== confirm.value) return uni.showToast({ title: "两次密码不一致", icon: "none" });
  try {
    const res = await http.post<{ token: string }>("/register", {
      account: account.value,
      password: password.value,
      confirm_password: confirm.value,
    });
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
