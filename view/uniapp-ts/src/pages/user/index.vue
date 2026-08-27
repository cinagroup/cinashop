<template>
  <view class="user-page">
    <!-- 用户信息卡 -->
    <view class="user-card" @tap="goLogin">
      <view class="avatar">👤</view>
      <view class="user-info">
        <template v-if="authStore.isLoggedIn">
          <view class="nickname">用户</view>
          <view class="uid">UID: {{ authStore.uid }}</view>
        </template>
        <template v-else>
          <view class="nickname">点击登录</view>
          <view class="uid">登录后体验完整功能</view>
        </template>
      </view>
    </view>

    <!-- 订单入口 -->
    <view class="menu-section">
      <view class="menu-title">我的订单</view>
      <view class="order-entry">
        <view class="entry-item" @tap="goOrders()">
          <text class="entry-icon">📦</text>
          <text class="entry-text">全部</text>
        </view>
        <view class="entry-item" @tap="goOrders(0)">
          <text class="entry-icon">💰</text>
          <text class="entry-text">待付款</text>
        </view>
        <view class="entry-item" @tap="goOrders(1)">
          <text class="entry-icon">🚚</text>
          <text class="entry-text">待收货</text>
        </view>
      </view>
    </view>

    <!-- 功能菜单 -->
    <view class="menu-section">
      <view class="menu-item" @tap="go('/pages/user/profile')">
        <text>👤 个人资料</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/changePassword')">
        <text>🔒 修改密码</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/phone')">
        <text>📱 手机号管理</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/address')">
        <text>📍 收货地址</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/collect')">
        <text>⭐ 我的收藏</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/coupon')">
        <text>🎫 我的优惠券</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/couponCenter')">
        <text>🎁 领券中心</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/finance')">
        <text>💸 分销中心</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/supplierApply')">
        <text>🏪 供应商入驻</text>
        <text class="arrow">›</text>
      </view>
      <view v-if="operatorProfile?.can_writeoff" class="menu-item operator-entry" @tap="goOperator">
        <text>✅ 履约核销</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/invoice')">
        <text>🧾 我的发票</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/level')">
        <text>🏅 会员等级</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/vipOpen')">
        <text>👑 付费会员</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/recharge')">
        <text>💳 余额充值</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/integral')">
        <text>🎁 积分商城</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/sign')">
        <text>✍️ 每日签到</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/message')">
        <text>📮 消息中心</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/user/kefu')">
        <text>💬 在线客服</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/goods/search')">
        <text>🔍 商品搜索</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/activity/index')">
        <text>🎯 营销活动</text>
        <text class="arrow">›</text>
      </view>
      <view class="menu-item" @tap="go('/pages/activity/lottery')">
        <text>🎲 幸运抽奖</text>
        <text class="arrow">›</text>
      </view>
    </view>

    <!-- 退出登录 -->
    <view v-if="authStore.isLoggedIn" class="logout-btn" @tap="logout">退出登录</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { apiLogout } from "@/api/auth";
import { apiWriteoffOperatorProfile, type WriteoffOperatorProfile } from "@/api/order";

const authStore = useAuthStore();
const operatorProfile = ref<WriteoffOperatorProfile | null>(null);

function goLogin() {
  if (!authStore.isLoggedIn) {
    uni.navigateTo({ url: "/pages/auth/login" });
  }
}

function goOrders(type?: number) {
  uni.navigateTo({ url: `/pages/order/list${type !== undefined ? `?type=${type}` : ""}` });
}

function go(url: string) {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  uni.navigateTo({ url });
}

function goOperator() {
  const role = operatorProfile.value?.staff_stores.length ? "staff" : "delivery";
  go(`/pages/operator/writeoff?role=${role}`);
}

async function logout() {
  try {
    await apiLogout();
  } catch {
    // 本地凭据仍必须清理，避免退出接口异常把用户困在登录态。
  }
  authStore.clear();
  uni.showToast({ title: "已退出登录", icon: "success" });
}

onShow(async () => {
  if (!authStore.isLoggedIn) {
    operatorProfile.value = null;
    return;
  }
  try {
    operatorProfile.value = await apiWriteoffOperatorProfile();
  } catch {
    operatorProfile.value = null;
  }
});
</script>

<style scoped>
.user-page {
  padding: 20rpx;
}

.user-card {
  display: flex;
  align-items: center;
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.avatar {
  width: 100rpx;
  height: 100rpx;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 50rpx;
  margin-right: 24rpx;
}

.nickname {
  font-size: 34rpx;
  font-weight: 600;
}

.uid {
  font-size: 24rpx;
  opacity: 0.85;
  margin-top: 6rpx;
}

.menu-section {
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}

.menu-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.order-entry {
  display: flex;
  justify-content: space-around;
}

.entry-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.entry-icon {
  font-size: 44rpx;
}

.entry-text {
  font-size: 24rpx;
  margin-top: 8rpx;
  color: #555;
}

.menu-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24rpx 10rpx;
  border-bottom: 1rpx solid #f5f5f5;
  font-size: 28rpx;
}

.menu-item:last-child {
  border-bottom: none;
}

.operator-entry {
  color: #c6281c;
  font-weight: 600;
}

.arrow {
  color: #999;
  font-size: 32rpx;
}

.logout-btn {
  background: #fff;
  color: #e93323;
  text-align: center;
  padding: 24rpx;
  border-radius: 12rpx;
  font-size: 28rpx;
}
</style>
