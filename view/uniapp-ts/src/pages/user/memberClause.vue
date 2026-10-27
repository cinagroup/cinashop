<template>
 <ThemePage>
  <view class="member-clause" :data-member-clause-owner="s.loggedIn?auth.uid:0" :data-member-clause-id="s.record?.id||0" :data-member-clause-loaded="s.loaded" :data-member-clause-expired="s.mediaExpired">
   <view v-if="!s.loggedIn" class="state"><view>登录后查看会员协议</view><button @tap="s.login">去登录</button></view>
   <template v-else>
    <view v-if="s.loading" class="state" role="status">正在读取会员协议…</view>
    <view v-else-if="s.error" class="state" role="alert"><view>{{s.error}}</view><button @tap="s.load">重新读取协议</button></view>
    <template v-else-if="s.record">
     <view class="clause-title">{{s.record.title}}</view>
     <view class="clause-body"><template v-if="document.nodes.length"><DiyPresentationRichNode v-for="(node,index) in document.nodes" :key="`${document.key}:${index}`" :node="node" :allowed="document.allowed" :positions="document.positions" @position="document.position($event)" @link="document.open($event)" /></template><view v-else class="empty-body">商家尚未配置协议正文</view></view>
     <view v-if="s.mediaExpired" class="state media-expired"><view>协议图片预览已过期，重新读取后查看</view><button @tap="s.load">重新读取协议</button></view>
    </template>
    <view v-else-if="s.loaded" class="state">商家尚未配置会员协议</view>
   </template>
  </view>
  <DiySuspendedNavigation />
 </ThemePage>
</template>
<script setup lang="ts">
import {computed,reactive} from 'vue';
import DiyPresentationRichNode from '@/components/diy/DiyPresentationRichNode.vue';
import ThemePage from '@/components/ThemePage.vue';
import {useAuthStore} from '@/stores/auth';
import {useMemberClause} from '@/composables/useMemberClause';
const auth=useAuthStore(),s=reactive(useMemberClause()),document=computed(()=>s.view());
</script>
<style scoped>
.member-clause{min-height:100vh;background:#fff;color:#333;font-size:28rpx;line-height:1.8;box-sizing:border-box;overflow-wrap:anywhere}.clause-title{padding-top:60rpx;font-size:30rpx;text-align:center;white-space:pre-wrap}.clause-body{padding:50rpx 30rpx}.state{padding:80rpx 30rpx;text-align:center;color:#888;font-size:26rpx;line-height:1.7}.state button{display:inline-block;margin:28rpx auto 0;padding:12rpx 38rpx;border:1rpx solid #ddd;background:#fff;color:#555;font-size:26rpx;line-height:1.7}.state button::after{border:0}.empty-body{color:#999;font-size:26rpx}.media-expired{padding:20rpx 30rpx 50rpx}
</style>
