<template>
  <view class="profile-page">
    <!-- 头像 -->
    <view class="avatar-card">
      <view class="avatar">{{ (userInfo.nickname || "用")[0] }}</view>
      <view class="avatar-name">{{ userInfo.nickname || "未设置昵称" }}</view>
    </view>

    <!-- 基本信息 -->
    <view class="info-card">
      <view class="info-row interactive" @tap="openPhoneSettings">
        <text class="label">手机号</text>
        <view class="value phone-value">
          <text>{{ userInfo.phone || "未绑定" }}</text>
          <text class="arrow">›</text>
        </view>
      </view>
      <view class="info-row">
        <text class="label">UID</text>
        <text class="value">{{ userInfo.uid || "—" }}</text>
      </view>
      <view class="info-row">
        <text class="label">余额</text>
        <text class="value">¥{{ userInfo.now_money || "0.00" }}</text>
      </view>
      <view class="info-row">
        <text class="label">积分</text>
        <text class="value">{{ userInfo.integral || 0 }}</text>
      </view>
      <view class="info-row">
        <text class="label">注册时间</text>
        <text class="value">{{ formatTime(userInfo.add_time ?? 0) }}</text>
      </view>
    </view>

    <!-- 编辑昵称 -->
    <view class="edit-card">
      <view class="edit-title">修改昵称</view>
      <view class="edit-row">
        <input
          v-model="nickname"
          class="edit-input"
          type="text"
          :placeholder="userInfo.nickname || '请输入昵称'"
          :maxlength="16"
        />
        <view class="save-btn" @tap="save">保存</view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

interface UserProfile {
  uid: number;
  nickname: string;
  avatar: string;
  phone: string;
  now_money: string;
  integral: number;
  add_time?: number;
}

const userInfo = ref<UserProfile>({
  uid: 0,
  nickname: "",
  avatar: "",
  phone: "",
  now_money: "0.00",
  integral: 0,
});
const nickname = ref("");

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openPhoneSettings() {
  uni.navigateTo({ url: "/pages/user/phone" });
}

async function load() {
  try {
    const info = await http.get<UserProfile>("/user/info");
    userInfo.value = { ...userInfo.value, ...info };
    nickname.value = info.nickname || "";
  } catch {
    // 静默
  }
}

async function save() {
  const name = nickname.value.trim();
  if (!name) return uni.showToast({ title: "请输入昵称", icon: "none" });
  try {
    await http.post<null>("/user/edit", { nickname: name });
    uni.showToast({ title: "保存成功", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "保存失败", icon: "none" });
  }
}

onMounted(load);
</script>

<style scoped>
.profile-page {
  padding: 20rpx;
}

.avatar-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 20rpx;
}

.avatar {
  width: 120rpx;
  height: 120rpx;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  color: #fff;
  font-size: 52rpx;
  text-align: center;
  line-height: 120rpx;
}

.avatar-name {
  color: #fff;
  font-size: 30rpx;
  font-weight: 600;
  margin-top: 16rpx;
}

.info-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 10rpx 24rpx;
  margin-bottom: 20rpx;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 22rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.info-row:last-child {
  border-bottom: none;
}

.label {
  font-size: 26rpx;
  color: #999;
}

.value {
  font-size: 26rpx;
  color: #333;
}

.interactive {
  cursor: pointer;
}

.phone-value {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.arrow {
  color: #bbb;
  font-size: 32rpx;
}

.edit-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.edit-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.edit-row {
  display: flex;
  gap: 16rpx;
}

.edit-input {
  flex: 1;
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 18rpx 24rpx;
  font-size: 26rpx;
}

.save-btn {
  background: #e93323;
  color: #fff;
  font-size: 26rpx;
  border-radius: 12rpx;
  padding: 18rpx 40rpx;
}
</style>
