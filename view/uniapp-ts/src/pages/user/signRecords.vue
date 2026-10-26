<template>
  <ThemePage><view class="sign-history">
    <view v-if="!s.loggedIn" class="empty">登录后查看签到记录<button @tap="s.login">去登录</button></view>
    <template v-else>
      <view v-for="group in s.groups" :key="group.month" class="month-group" :data-sign-month="group.month"><view class="month-title">{{ group.month }}</view><view class="record-card"><SignRecordList :rows="group.list" /></view></view>
      <view v-if="s.loading" class="empty">正在读取签到记录…</view>
      <view v-if="s.error" class="empty error" role="alert">{{ s.error }}<button :disabled="s.loading" @tap="s.load(s.groups.length > 0)">重试</button><button v-if="s.groups.length" :disabled="s.loading" @tap="s.load()">刷新全部记录</button></view>
      <view v-else-if="s.loaded && !s.groups.length" class="empty">暂无签到记录</view>
      <button v-if="s.hasMore && !s.error" class="load-more" :disabled="s.loading" @tap="s.load(true)">{{ s.loading ? '加载中…' : '加载更多月份' }}</button>
      <view v-else-if="s.loaded && s.groups.length && !s.error" class="empty">没有更多记录了</view>
      <button v-if="!s.loaded && !s.loading && !s.error" @tap="s.load()">加载签到记录</button>
    </template>
  </view><DiySuspendedNavigation /></ThemePage>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import SignRecordList from '@/components/SignRecordList.vue';
import { useSignRecords } from '@/composables/useSignRecords';
const s = reactive(useSignRecords());
</script>
<style scoped>
.sign-history{max-width:960px;margin:auto;padding:0 24rpx 40rpx;background:#f5f5f5;min-height:100vh}.month-title{padding:28rpx 0;font-size:28rpx;font-weight:500}.record-card{padding:0 24rpx;border-radius:24rpx;background:#fff}.empty{text-align:center;padding:48rpx 20rpx;color:#999;font-size:26rpx;line-height:1.6}.empty button,.load-more{font-size:26rpx;margin:20rpx auto;max-width:480rpx;background:#fff;line-height:2.5}.error{color:#b23f27}
</style>
