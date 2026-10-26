<template>
  <ThemePage>
    <view class="points-ledger-page">
      <view v-if="!s.loggedIn" class="ledger-state"><view>登录后查看积分明细</view><button @tap="s.login">去登录</button></view>
      <template v-else>
        <view v-for="group in s.groups" :key="group.month" class="month-group" :data-points-month="group.month">
          <view class="month-title">{{ group.month || '日期未记录' }}</view>
          <view class="month-rows"><view v-for="row in group.list" :key="row.id" class="ledger-row" :data-points-record-id="row.id">
            <view class="ledger-description"><view class="ledger-mark">{{ row.mark || row.title || '积分变动' }}</view><view class="ledger-time">{{ row.add_time || '时间未记录' }}</view><text v-if="row.number < 0" class="ledger-source">{{ row.pm === 1 ? '收入' : '支出' }}记录原值 {{ row.number }} 积分</text></view>
            <view class="ledger-amount numeric">{{ pointsLedgerAmount(row) }}</view>
          </view></view>
        </view>
        <view v-if="s.loading" class="ledger-state" role="status">正在读取积分明细…</view>
        <view v-if="s.error" class="ledger-state error" role="alert">{{ s.error }}</view>
        <view v-if="s.loaded && !s.rows.length && !s.error && !s.loading" class="ledger-state"><image class="empty-art" src="/static/php-points/noOrder.gif" mode="aspectFit" /><view>暂无积分记录~</view></view>
        <button v-if="s.error" class="ledger-button" :disabled="s.loading" @tap="s.load(s.loaded)">重试当前页</button>
        <button v-if="s.hasMore && !s.error" class="ledger-button" :disabled="s.loading" @tap="s.load(true)">{{ s.loading ? '加载中…' : '加载更多' }}</button>
        <view v-if="s.loaded && s.rows.length && !s.hasMore && !s.loading && !s.error" class="ledger-end">没有更多内容啦~</view>
        <button v-if="s.loaded || s.error || !s.loading" class="ledger-refresh" :disabled="s.loading" @tap="s.load()">刷新积分明细</button>
      </template>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { pointsLedgerAmount } from '@/api/pointsCentre';
import { usePointsLedger } from '@/composables/usePointsLedger';
const s = reactive(usePointsLedger());
</script>
<style scoped>
.points-ledger-page{min-height:100vh;max-width:960px;margin:auto;padding:0 20rpx calc(30rpx + env(safe-area-inset-bottom));box-sizing:border-box;background:#f5f5f5}.month-title{padding:32rpx 0 24rpx;font-size:24rpx;line-height:34rpx;color:#999}.month-rows{padding:0 24rpx;border-radius:24rpx;background:#fff}.ledger-row{display:flex;align-items:flex-start;gap:20rpx;padding:32rpx 0}.ledger-row+.ledger-row{border-top:1rpx solid #eee}.ledger-description{flex:1;min-width:0;font-size:28rpx;line-height:40rpx;color:#333;overflow-wrap:anywhere}.ledger-time{margin-top:12rpx;font-size:24rpx;line-height:34rpx;color:#999}.ledger-source{display:block;margin-top:8rpx;color:#999;font-size:22rpx}.ledger-amount{font:36rpx/40rpx 'CinaShop DIN',sans-serif;color:#333;max-width:42%;overflow-wrap:anywhere;text-align:right}.ledger-state{text-align:center;font-size:28rpx;line-height:1.7;color:#999;padding:90rpx 30rpx}.error{color:#b23f27}.ledger-button,.ledger-refresh{margin:20rpx auto;background:transparent;font-size:26rpx;line-height:2.6;color:#999;max-width:360rpx}.ledger-button::after,.ledger-refresh::after{border:0}.ledger-state button{max-width:360rpx;margin:30rpx auto;font-size:28rpx;color:var(--view-theme,#e93323)}.empty-art{display:block;width:440rpx;height:360rpx;margin:0 auto 24rpx}.ledger-end{text-align:center;padding:32rpx 0;font-size:26rpx;line-height:36rpx;color:#ccc}
</style>
