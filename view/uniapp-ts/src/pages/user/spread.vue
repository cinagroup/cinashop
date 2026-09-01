<template>
  <view class="spread-page">
    <!-- 推广卡片 -->
    <view class="spread-card">
      <view class="card-head">
        <text class="card-title">分销推广</text>
      </view>
      <view class="card-body">
        <view class="stat-row">
          <view class="stat-item">
            <text class="stat-num">{{ stats.totalCommission || "0.00" }}</text>
            <text class="stat-label">累计佣金</text>
          </view>
          <view class="stat-item">
            <text class="stat-num">{{ stats.withdrawable || "0.00" }}</text>
            <text class="stat-label">可提现</text>
          </view>
          <view class="stat-item">
            <text class="stat-num">{{ stats.spreadCount || 0 }}</text>
            <text class="stat-label">推广人数</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 推广链接/二维码 -->
    <view class="qrcode-section">
      <view class="section-title">我的推广链接</view>
      <view class="link-box">
        <text class="link-text" selectable>{{ spreadUrl }}</text>
        <view class="copy-btn" @tap="copyLink">复制</view>
      </view>
      <view class="qrcode-wrap" v-if="qrcodeUrl">
        <image class="qrcode-img" :src="qrcodeUrl" mode="aspectFit" />
        <text class="qrcode-tip">长按保存二维码, 分享给好友</text>
      </view>
      <view class="qrcode-placeholder" v-else>
        <text class="placeholder-text">二维码生成中...</text>
      </view>
    </view>

    <!-- 推广人列表 -->
    <view class="spread-list" v-if="spreadPeople.length">
      <view class="section-title">我推广的用户 ({{ spreadPeople.length }})</view>
      <view class="people-item" v-for="p in spreadPeople" :key="p.uid">
        <text class="people-avatar">{{ (p.nickname || "用")[0] }}</text>
        <view class="people-info">
          <text class="people-name">{{ p.nickname || `用户${p.uid}` }}</text>
          <text class="people-time">加入时间: {{ formatTime(p.spreadTime || p.addTime) }}</text>
        </view>
      </view>
    </view>

    <!-- 提现入口 -->
    <view class="extract-btn" @tap="goExtract">申请提现 ›</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

const stats = ref<Record<string, unknown>>({});
const spreadPeople = ref<any[]>([]);
const spreadUrl = ref("");
const qrcodeUrl = ref("");

function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadData() {
  try {
    stats.value = await http.get("/commission");
  } catch {
    stats.value = {};
  }
  try {
    spreadPeople.value = await http.get("/spread/people");
  } catch {
    spreadPeople.value = [];
  }
  // 推广链接 = H5 域名 + spread_uid 参数
  const uid = uni.getStorageSync("uni_uid") || 0;
  spreadUrl.value = `https://cinashop-h5.pages.dev/#/pages/auth/register?spread_uid=${uid}`;
  // 二维码 (使用在线 API 生成)
  qrcodeUrl.value = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(spreadUrl.value)}`;
}

function copyLink() {
  uni.setClipboardData({
    data: spreadUrl.value,
    success: () => uni.showToast({ title: "链接已复制", icon: "success" }),
  });
}

function goExtract() {
  uni.navigateTo({ url: "/pages/user/finance" });
}

onShow(loadData);
onMounted(loadData);
</script>

<style scoped>
.spread-page {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.spread-card {
  background: linear-gradient(135deg, #e93323, #ff6b35);
  border-radius: 20rpx;
  padding: 40rpx 30rpx;
  margin-bottom: 20rpx;
}

.card-title {
  color: #fff;
  font-size: 34rpx;
  font-weight: 700;
}

.stat-row {
  display: flex;
  justify-content: space-around;
  margin-top: 30rpx;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8rpx;
}

.stat-num {
  color: #fff;
  font-size: 40rpx;
  font-weight: 700;
}

.stat-label {
  color: rgba(255, 255, 255, 0.8);
  font-size: 24rpx;
}

.qrcode-section {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
}

.section-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}

.link-box {
  display: flex;
  align-items: center;
  gap: 16rpx;
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx;
}

.link-text {
  flex: 1;
  font-size: 22rpx;
  color: #666;
  word-break: break-all;
}

.copy-btn {
  background: #e93323;
  color: #fff;
  font-size: 24rpx;
  padding: 10rpx 24rpx;
  border-radius: 8rpx;
  flex-shrink: 0;
}

.qrcode-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 30rpx;
}

.qrcode-img {
  width: 300rpx;
  height: 300rpx;
}

.qrcode-tip {
  font-size: 22rpx;
  color: #999;
  margin-top: 16rpx;
}

.qrcode-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 300rpx;
}

.placeholder-text {
  color: #999;
  font-size: 26rpx;
}

.spread-list {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
}

.people-item {
  display: flex;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f5f5f5;
}

.people-avatar {
  width: 60rpx;
  height: 60rpx;
  background: #e93323;
  color: #fff;
  border-radius: 50%;
  font-size: 28rpx;
  text-align: center;
  line-height: 60rpx;
  margin-right: 16rpx;
}

.people-info {
  flex: 1;
}

.people-name {
  font-size: 26rpx;
  color: #333;
}

.people-time {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}

.extract-btn {
  position: fixed;
  bottom: 30rpx;
  left: 30rpx;
  right: 30rpx;
  background: #fff;
  color: #e93323;
  border: 2rpx solid #e93323;
  text-align: center;
  padding: 24rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
}
</style>
