<template>
  <view class="sign-record-list">
    <view v-for="row in rows" :key="row.id" class="record-row" :data-sign-record-id="row.id">
      <image class="record-icon" src="/static/php-sign/sign-record.png" mode="aspectFit" />
      <view class="record-description"><view class="record-title">{{ row.title }}</view><view class="record-date">{{ row.add_time || '日期未记录' }}</view></view>
      <view class="rewards">
        <view v-if="row.exp_num !== 0" class="reward"><image src="/static/php-sign/sign-icon-02.png" mode="aspectFit" /><text>{{ row.exp_num > 0 ? '+' : '' }}{{ row.exp_num }}</text><text class="unit">经验</text></view>
        <view v-if="row.number !== 0" class="reward"><image src="/static/php-sign/sign-icon-01.png" mode="aspectFit" /><text>{{ row.number > 0 ? '+' : '' }}{{ row.number }}</text><text class="unit">积分</text></view>
        <text v-if="row.exp_num === 0 && row.number === 0" class="record-date">已签到</text>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import type { SignRecord } from '@/api/signCentre';
defineProps<{ rows: SignRecord[] }>();
</script>
<style scoped>
.record-row{display:flex;align-items:center;gap:16rpx;padding:28rpx 0;border-bottom:1px solid #f4f4f4;min-width:0}.record-row:last-child{border-bottom:0}.record-icon{width:80rpx;height:80rpx;flex-shrink:0}.record-description{flex:1;min-width:0}.record-title{font-size:28rpx;line-height:1.5;overflow-wrap:anywhere}.record-date{font-size:24rpx;color:#999;margin-top:8rpx}.rewards{display:flex;gap:12rpx;flex-shrink:0}.reward{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:72rpx;padding:8rpx 4rpx;background:rgba(250,173,20,.06);border-radius:10rpx;color:#b34d00;font:32rpx 'CinaShop DIN',sans-serif}.reward image{width:34rpx;height:34rpx}.unit{font:18rpx sans-serif;margin-top:2rpx}
</style>
