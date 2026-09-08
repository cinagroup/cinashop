<template>
  <view class="pink-status">
    <view class="heading">拼团状态</view>
    <view class="hint">团记录 #{{ recordId || '无效' }} · 状态只读查询</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <view v-if="!loggedIn && recordId" class="card">
      <text>登录后查看拼团成员、进度和本人订单。</text>
      <button :disabled="navigating" @tap="login">登录查看拼团</button>
    </view>
    <view v-if="loading" class="hint">正在读取拼团状态…</view>
    <view class="toolbar">
      <button size="mini" :disabled="loading || navigating || !loggedIn || !recordId" @tap="load">刷新状态</button>
      <button size="mini" :disabled="navigating" @tap="list">活动列表</button>
      <button v-if="loggedIn" size="mini" :disabled="navigating" @tap="orders">我的订单</button>
    </view>
    <template v-if="detail">
      <view class="card">
        <view class="product">
          <image v-if="detail.activity.image" :src="detail.activity.image" mode="aspectFit" class="product-image" />
          <view><view class="product-title">{{ detail.activity.title }}</view><view class="price">活动参考价 ¥{{ detail.activity.price }}</view>
            <view class="hint">活动 #{{ detail.activity.id }} · {{ detail.leader.people }} 人成团</view></view>
        </view>
        <view class="state" :class="{ pending }">{{ title }}</view>
        <view v-if="pending" class="hint">成团或到期状态正在由服务端确认。刷新不会发起结算或退款，请稍后查询本人订单。</view>
        <view v-else-if="detail.leader.status === 1">还差 {{ detail.count }} 人 · 剩余 {{ remaining }}</view>
        <view v-else-if="detail.leader.status === 3" class="hint">拼团已失败；退款是否到账请以订单和退款记录为准。</view>
        <view v-else class="hint">拼团已成功；发货与履约进度请查看本人订单。</view>
        <view class="hint">团长记录 #{{ detail.leader.id }} · {{ detail.joined ? '您已参加该团' : '您不是该团成员' }}</view>
        <view class="members">
          <view v-for="person in [detail.leader, ...detail.members]" :key="person.id" class="member">
            <image v-if="person.avatar" :src="person.avatar" class="avatar" mode="aspectFill" />
            <view v-else class="avatar fallback">团员</view>
            <text>{{ person.nickname || '团员' }}{{ person.id === detail.leader.id ? '（团长）' : '' }}</text>
          </view>
        </view>
        <button v-if="canJoin" class="primary" :disabled="navigating" @tap="join">选择规格参加此团</button>
        <view v-if="canJoin" class="hint">此处人数不扣除待支付预占席位。下一页会重新校验该团资格，不自动改为开团。</view>
        <button v-if="detail.orderId" :disabled="navigating" @tap="order">查看本人订单</button>
        <view v-else-if="detail.joined" class="hint">当前没有可展示的本人订单，请从我的订单查询。</view>
        <view v-if="detail.joined" class="hint">取消或售后请从本人订单申请；此页面不会直接退款。</view>
        <button v-if="detail.leader.status === 1 && !pending" :disabled="navigating" @tap="copyInvite">复制邀请链接</button>
        <!-- #ifdef MP-WEIXIN -->
        <button v-if="detail.leader.status === 1 && !pending" open-type="share">分享给好友</button>
        <!-- #endif -->
        <button :disabled="navigating" @tap="openActivity()">重新选择活动并开新团</button>
      </view>
      <view v-if="detail.hosts.length" class="card">
        <view class="product-title">其他推荐拼团</view>
        <button v-for="item in detail.hosts" :key="item.id" :disabled="navigating" @tap="openActivity(item.id)">{{ item.title }} · ¥{{ item.price }}</button>
        <view v-if="detail.hostsTruncated" class="hint">仅展示最新 20 个推荐活动，更多请查看活动列表。</view>
      </view>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import { onShareAppMessage } from '@dcloudio/uni-app';
import { usePinkStatus } from '@/composables/usePinkStatus';
const { recordId, detail, loading, error, navigating, loggedIn, pending, canJoin, title, remaining,
  load, login, join, openActivity, order, orders, list, copyInvite, invitation } = usePinkStatus();
onShareAppMessage(() => invitation() ?? { title: '查看拼团活动', path: '/pages/activity/index' });
</script>

<style scoped>
.pink-status { padding: 28rpx 24rpx calc(40rpx + env(safe-area-inset-bottom)); max-width: 960px; margin: auto; }
.heading { font-size: 38rpx; font-weight: 600; }
.hint { color: #666; font-size: 25rpx; line-height: 1.65; margin: 16rpx 0; overflow-wrap: anywhere; }
.error { color: #a72823; background: #fff0ed; padding: 20rpx; overflow-wrap: anywhere; }
.toolbar { display: flex; gap: 16rpx; margin: 20rpx 0; }.toolbar button { margin: 0; }
.card { background: white; border-radius: 18rpx; padding: 26rpx; margin: 24rpx 0; }
.product { display: flex; align-items: center; gap: 24rpx; }.product > view { min-width: 0; }
.product-image { width: 160rpx; height: 160rpx; flex-shrink: 0; }.product-title { font-size: 30rpx; font-weight: 600; overflow-wrap: anywhere; }
.price { color: #b72a1d; margin-top: 12rpx; }.state { font-size: 40rpx; font-weight: 600; margin: 24rpx 0; }.pending { color: #8a5700; }
.members { display: flex; flex-wrap: wrap; gap: 20rpx; margin: 24rpx 0; }.member { width: 132rpx; text-align: center; font-size: 23rpx; overflow-wrap: anywhere; }
.avatar { width: 86rpx; height: 86rpx; border-radius: 50%; margin: 0 auto 10rpx; }.fallback { background: #eee; color: #666; line-height: 86rpx; }
button { font-size: 27rpx; margin-top: 18rpx; overflow-wrap: anywhere; }.primary { background: #e93323; color: white; }
</style>
