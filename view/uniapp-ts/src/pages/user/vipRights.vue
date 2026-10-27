<template>
  <ThemePage>
    <view class="rights-container" :data-right-owner="s.loggedIn ? auth.uid : 0">
      <view v-if="!s.loggedIn" class="rights-state"><view>登录后查看会员权益</view><button @tap="s.login">去登录</button></view>
      <template v-else>
        <view v-if="s.loading && !s.rights.length" class="rights-state" role="status">正在读取会员权益…</view>
        <view v-if="s.error" class="rights-notice error" role="alert">{{ s.error }}</view>
        <view v-if="!s.loading && !s.error && !s.rights.length" class="rights-state">暂无可展示的会员权益</view>
        <scroll-view v-if="s.rights.length" class="rights-icons" scroll-x :show-scrollbar="false" :scroll-into-view="'member-right-'+s.selectedId" scroll-with-animation>
          <view class="header" :class="{compact:s.rights.length<=5}">
            <button v-for="right in s.items" :id="'member-right-'+right.id" :key="right.id" class="right-tab" :data-member-right-tab="right.id" :class="{on:s.selectedId===right.id}" :aria-label="'查看'+right.title" :aria-pressed="s.selectedId===right.id" @tap="s.select(right.id)">
              <view class="image-wrap"><image v-if="right.preview.src" :key="right.preview.src" :src="right.preview.src" class="right-image" mode="aspectFit" @error="right.preview.error" /><text v-else class="image-placeholder">{{right.title.slice(0,1)}}</text></view>
              <view class="right-title">{{right.title}}</view>
            </button>
          </view>
        </scroll-view>
        <swiper v-if="s.rights.length" class="rights-swiper" :current="s.selectedIndex" :duration="300" previous-margin="58rpx" next-margin="58rpx" @change="s.swipe">
          <swiper-item v-for="(right,index) in s.items" :key="right.id">
            <view class="right-card" :class="{on:s.selectedId===right.id}" :data-member-right-id="right.id">
              <view class="card-title">{{right.explain || right.title}}</view>
              <scroll-view class="content-scroll" scroll-y>
                <rich-text v-if="Math.abs(index-s.selectedIndex)<=1 && s.nodes(right).length" class="rights-content" :nodes="s.nodes(right)" />
                <view v-else-if="Math.abs(index-s.selectedIndex)<=1" class="content-empty">暂无权益介绍</view>
              </scroll-view>
            </view>
          </swiper-item>
        </swiper>
        <view v-if="s.mediaExpired" class="rights-notice">图片预览已过期，重新读取后查看</view>
        <view class="rights-actions"><button :disabled="s.loading" @tap="s.load">{{s.loading?'读取中…':'重新读取权益'}}</button></view>
      </template>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import {reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import {useAuthStore} from '@/stores/auth';
import {useMemberRights} from '@/composables/useMemberRights';
const auth=useAuthStore(),s=reactive(useMemberRights());
</script>
<style scoped>
.rights-container{min-height:100vh;max-width:960px;margin:auto;padding-bottom:calc(24rpx + env(safe-area-inset-bottom));box-sizing:border-box;background:linear-gradient(180deg,#312b23 0%,#19140e 100%);overflow:hidden}
.rights-icons{width:100%}.header{display:flex;min-width:100%;width:max-content}.header.compact{width:100%}
.right-tab{flex:0 0 150rpx;width:150rpx;padding:48rpx 8rpx 56rpx;margin:0;border:0;border-radius:0;background:transparent;color:rgba(255,255,255,.4);font-size:24rpx;line-height:34rpx;box-sizing:border-box}.right-tab::after{border:0}.compact .right-tab{flex:1;width:auto;min-width:0}.right-tab.on{color:rgba(255,255,255,.8)}
.image-wrap{display:flex;align-items:center;justify-content:center;width:88rpx;height:88rpx;border-radius:50%;margin:0 auto 28rpx;background:linear-gradient(180deg,rgba(255,255,255,.1) 2%,rgba(255,255,255,0) 100%)}.right-image{width:100%;height:100%;opacity:.3}.on .right-image{opacity:1}.image-placeholder{font-size:36rpx;color:#edd9b8}.right-title{overflow-wrap:anywhere}
.rights-swiper{height:1090rpx}.right-card{display:flex;flex-direction:column;height:100%;max-width:700px;margin:auto;transform:scale(.9);transition:transform .3s}.right-card.on{transform:scale(1)}
.card-title{flex-shrink:0;padding:42rpx 18rpx 40rpx;border-radius:24rpx 24rpx 0 0;background:#ffebc7;text-align:center;font-size:30rpx;font-weight:500;line-height:42rpx;color:#333;overflow-wrap:anywhere}
.content-scroll{flex:1;min-height:0;padding:48rpx;border-radius:0 0 24rpx 24rpx;background:#fff;box-sizing:border-box}.rights-content{font-size:28rpx;line-height:1.7;color:#333;overflow-wrap:anywhere}.content-empty{padding:70rpx 0;text-align:center;color:#999;font-size:26rpx}
.rights-state{padding:90rpx 32rpx;text-align:center;color:#f0dfc3;font-size:28rpx;line-height:44rpx}.rights-state button{max-width:320rpx;margin:28rpx auto;background:#ffebc7;color:#5a4229;font-size:28rpx}.rights-notice{margin:20rpx 28rpx;padding:18rpx;border-radius:12rpx;background:rgba(255,255,255,.06);color:#f0dfc3;font-size:24rpx;overflow-wrap:anywhere}.error{color:#ffc0b2}.rights-actions{text-align:center;padding:24rpx}.rights-actions button{display:inline-block;margin:0;padding:0 30rpx;background:rgba(255,255,255,.08);color:#f0dfc3;font-size:24rpx;line-height:64rpx}.rights-actions button::after{border:0}
@media(min-width:768px){.right-tab{padding:30px 8px;font-size:16px;line-height:24px}.image-wrap{width:56px;height:56px;margin-bottom:16px}.rights-swiper{height:620px}.card-title{padding:24px;font-size:20px;line-height:28px}.content-scroll{padding:30px}.rights-content{font-size:16px}}
</style>
