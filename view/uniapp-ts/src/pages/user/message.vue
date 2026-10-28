<template>
 <ThemePage><view class="message-center" data-message-center>
  <view v-if="!s.loggedIn" class="message-state"><view>登录后查看消息中心</view><button @tap="s.login">去登录</button></view>
  <template v-else>
   <view class="conversation-list">
    <button v-if="s.summary" class="conversation-card" :data-system-id="s.summary.id" data-system-summary @tap="s.openSystem">
     <view class="system-icon" aria-hidden="true"><view class="envelope-icon"/></view>
     <view class="conversation-text"><view class="conversation-top"><text class="conversation-name">{{ s.summary.title || '系统通知' }}</text><text class="conversation-time">{{ systemMessageTime(s.summary.add_time) }}</text></view><view class="conversation-bottom"><text class="conversation-preview">{{ s.summary.content }}</text><view v-if="s.unread>0" class="unread-dot" :aria-label="'有'+s.unread+'条未读系统消息'"/></view></view>
    </button>
    <button v-for="row in s.items" :key="row.id" class="conversation-card" :data-conversation-id="row.id" :data-service-uid="row.to_uid" @tap="s.openConversation(row)">
     <view class="conversation-avatar"><image v-if="row.image.src" :key="row.image.key" :src="row.image.src" mode="aspectFill" @error="row.image.error"/><text v-else>{{ (row.nickname || '客服').slice(0,1) }}</text></view>
     <view class="conversation-text"><view class="conversation-top"><text class="conversation-name">{{ row.nickname || '在线客服' }}</text><text class="conversation-time">{{ messageTime(row.update_time) }}</text></view><view class="conversation-bottom"><MessagePreview class="conversation-preview" :value="conversationPreview(row)"/><text v-if="row.mssage_num>0" class="unread-badge" :aria-label="row.mssage_num+'条未读客服消息'">{{ row.mssage_num>99?'99+':row.mssage_num }}</text></view></view>
    </button>
   </view>
   <view v-if="s.loading" class="message-state" role="status">正在读取消息…</view><view v-if="s.error" class="message-state message-error" role="alert">{{ s.error }}</view>
   <view v-if="s.loaded && !s.loading && !s.error && !s.summary && !s.items.length" class="message-state">暂无消息</view>
   <button v-if="s.error" class="message-control" :disabled="s.loading" @tap="s.retry">重试当前页</button><button v-else-if="s.hasMore" class="message-control" :disabled="s.loading" @tap="s.load(true)">加载更多会话</button>
   <view v-if="s.loaded && s.items.length && !s.hasMore && !s.loading && !s.error" class="message-state">{{ s.page===1000?'已显示前20000条会话':'没有更多会话了' }}</view>
   <view v-if="s.mediaExpired" class="message-state">头像已过期，请刷新消息</view><button class="message-control" :disabled="s.loading" @tap="s.refresh">刷新消息</button>
  </template>
 </view><DiySuspendedNavigation/></ThemePage>
</template>
<script setup lang="ts">
import {reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import {useUserMessages} from '@/composables/useUserMessages';
import {conversationPreview,messageTime,systemMessageTime} from '@/api/userMessages';
import MessagePreview from '@/components/user/MessagePreview.vue';
const s=reactive(useUserMessages('center'));
</script>
<style scoped>
.message-center{max-width:750rpx;min-height:100vh;margin:0 auto;padding:24rpx 20rpx 40rpx;background:#f5f5f5;color:#333;box-sizing:border-box}.conversation-list{display:flex;flex-direction:column;gap:24rpx}.conversation-card{display:flex;align-items:center;width:100%;box-sizing:border-box;margin:0;padding:32rpx;background:#fff;border-radius:24rpx;text-align:left;line-height:normal;font-weight:400}.conversation-card::after,.message-control::after,.message-state button::after{border:0}.system-icon,.conversation-avatar{width:88rpx;height:88rpx;flex:0 0 88rpx;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center}.system-icon{background:linear-gradient(180deg,#ffc657,#fe653b)}.envelope-icon{position:relative;width:44rpx;height:32rpx;border:3rpx solid #fff;border-radius:5rpx;box-sizing:border-box;overflow:hidden}.envelope-icon::after{content:'';position:absolute;left:4rpx;top:-19rpx;width:25rpx;height:25rpx;border:3rpx solid #fff;border-top:0;border-left:0;transform:rotate(45deg)}.conversation-avatar{background:#fceae9;color:#d95d4b;font-size:32rpx}.conversation-avatar image{width:100%;height:100%}.conversation-text{min-width:0;flex:1;padding-left:24rpx}.conversation-top,.conversation-bottom{display:flex;align-items:center;justify-content:space-between;gap:10rpx}.conversation-name{font-size:32rpx;line-height:44rpx;max-width:200rpx;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conversation-time{font-size:22rpx;line-height:30rpx;color:#999;flex-shrink:0}.conversation-bottom{margin-top:8rpx;min-height:34rpx}.conversation-preview{min-width:0;flex:1;font-size:24rpx;line-height:34rpx;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.unread-dot{width:20rpx;height:20rpx;flex:0 0 20rpx;border-radius:50%;background:#e93323}.unread-badge{box-sizing:border-box;min-width:32rpx;max-width:72rpx;height:32rpx;line-height:32rpx;flex-shrink:0;padding:0 8rpx;border-radius:20rpx;color:#fff;background:#e93323;font-size:22rpx;text-align:center}.message-state{text-align:center;padding:32rpx 16rpx;color:#999;font-size:26rpx;line-height:42rpx;overflow-wrap:anywhere}.message-error{color:#b34428}.message-control,.message-state button{margin:16rpx auto;padding:8rpx 20rpx;max-width:360rpx;line-height:48rpx;font-size:26rpx;color:#777;background:transparent}
</style>
