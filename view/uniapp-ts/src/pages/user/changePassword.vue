<template>
  <view class="pwd-page">
    <view class="login-box">
      <view class="title">修改密码</view>

      <view class="form-item">
        <input
          class="input"
          v-model="oldPassword"
          placeholder="请输入原密码"
          :password="true"
        />
      </view>
      <view class="form-item">
        <input
          class="input"
          v-model="newPassword"
          placeholder="请输入新密码 (至少6位)"
          :password="true"
        />
      </view>
      <view class="form-item">
        <input
          class="input"
          v-model="confirm"
          placeholder="确认新密码"
          :password="true"
        />
      </view>

      <view class="login-btn" @tap="doChange">确认修改</view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";

const oldPassword = ref("");
const newPassword = ref("");
const confirm = ref("");
const authStore = useAuthStore();

async function doChange() {
  if (!oldPassword.value) return uni.showToast({ title: "请输入原密码", icon: "none" });
  if (newPassword.value.length < 6) return uni.showToast({ title: "新密码至少 6 位", icon: "none" });
  if (newPassword.value !== confirm.value) return uni.showToast({ title: "两次密码不一致", icon: "none" });
  try {
    await http.post<null>("/user/change_password", {
      old_password: oldPassword.value,
      new_password: newPassword.value,
    });
    uni.showToast({ title: "修改成功, 请重新登录", icon: "success" });
    authStore.clear();
    setTimeout(() => uni.reLaunch({ url: "/pages/auth/login" }), 1000);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "修改失败", icon: "none" });
  }
}
</script>

<style scoped>
.pwd-page {
  padding: 80rpx 60rpx;
}

.title {
  text-align: center;
  font-size: 36rpx;
  font-weight: 700;
  margin-bottom: 60rpx;
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
</style>
