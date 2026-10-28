<template>
 <ThemePage><view class="system-messages" data-system-messages :data-message-mode="s.mode">
  <view v-if="!s.routeValid" class="message-state message-error" role="alert">消息链接无效，请从消息中心重新进入</view>
  <view v-else-if="!s.loggedIn" class="message-state"><view>登录后查看站内信</view><button @tap="s.login">去登录</button></view>
  <template v-else>
   <template v-if="s.mode==='detail'"><view v-if="s.detail" class="system-item" :data-system-message-id="s.detail.id"><view class="message-time">{{ systemMessageTime(s.detail.add_time) }}</view><view class="message-card"><view class="message-title">{{ s.detail.title }}</view><view class="message-content">{{ s.detail.content }}</view></view></view></template>
   <template v-else><view v-for="row in s.messages" :key="row.id" class="system-item" :data-system-message-id="row.id"><view class="message-time">{{ systemMessageTime(row.add_time) }}</view><view class="message-card"><view class="message-title">{{ row.title }}</view><view class="message-content">{{ row.content }}</view></view></view></template>
   <view v-if="s.loading" class="message-state" role="status">正在读取站内信…</view><view v-if="s.error" class="message-state message-error" role="alert">{{ s.error }}</view>
   <view v-if="s.loaded && !s.loading && !s.error && !s.count" class="message-state">{{ s.mode==='detail'?'消息不存在或已不可见':'暂无站内信' }}</view>
   <button v-if="s.error" class="message-control" :disabled="s.loading" @tap="s.retry">重试当前页</button><button v-else-if="s.hasMore" class="message-control" :disabled="s.loading" @tap="s.load(true)">加载更多站内信</button>
   <view v-if="s.loaded && s.count && !s.hasMore && s.mode!=='detail' && !s.loading && !s.error" class="message-state">{{ s.page===1000?'已显示前20000条站内信':'没有更多站内信了' }}</view>
   <button class="message-control" :disabled="s.loading" @tap="s.refresh">重新读取站内信</button>
  </template>
 </view><DiySuspendedNavigation/></ThemePage>
</template>
<script setup lang="ts">
import {reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import {useUserMessages} from '@/composables/useUserMessages';
import {systemMessageTime} from '@/api/userMessages';
const s=reactive(useUserMessages('messages'));
</script>
<style scoped>
.system-messages{max-width:750rpx;min-height:100vh;margin:0 auto;padding:32rpx 20rpx 40rpx;box-sizing:border-box;background:#f5f5f5;color:#333}.system-item+.system-item{margin-top:40rpx}.message-time{text-align:center;color:#999;font-size:22rpx;line-height:30rpx}.message-card{margin-top:24rpx;padding:32rpx;background:#fff;border-radius:24rpx;overflow-wrap:anywhere}.message-title{font-size:32rpx;line-height:44rpx}.message-content{margin-top:24rpx;font-size:28rpx;line-height:44rpx;white-space:pre-wrap}.message-state{text-align:center;padding:32rpx 16rpx;color:#999;font-size:26rpx;line-height:42rpx;overflow-wrap:anywhere}.message-error{color:#b34428}.message-control,.message-state button{margin:16rpx auto;padding:8rpx 20rpx;max-width:360rpx;line-height:48rpx;font-size:26rpx;color:#777;background:transparent}.message-control::after,.message-state button::after{border:0}
</style>
