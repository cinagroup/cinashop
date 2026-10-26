<template>
  <ThemePage>
    <view class="points-page">
      <view v-if="!s.loggedIn" class="state-card"><view class="state-title">登录后查看我的积分</view><text>积分详情、积分记录与任务入口</text><button @tap="s.login">去登录</button></view>
      <view v-else-if="!s.loaded" class="state-card"><view v-if="s.loading" role="status">正在读取积分详情…</view><view v-if="s.error" class="error" role="alert">{{ s.error }}</view><button v-if="!s.loading" @tap="s.load">重新加载积分详情</button></view>
      <template v-else-if="s.summary">
        <view class="points-header">
          <image class="header-art" src="/static/php-points/balance_species.png" mode="aspectFit" aria-hidden="true" />
          <view class="current-score"><image src="/static/php-points/integral.png" mode="aspectFit" /><text>我的积分</text></view>
          <view class="points-notice" role="status"><text v-if="s.summary.clear_integral > 0 && s.summary.clear_time > 0">您的积分将于 {{ s.summary.clear_end }} 清零</text><text v-else>积分可用于商品兑换、下单抵扣及活动</text></view>
          <view class="score-number numeric" data-points-balance>{{ s.summary.integral }}</view>
          <view class="points-overview">
            <image class="card-art" src="/static/php-points/integralBg.png" mode="scaleToFill" aria-hidden="true" />
            <view class="overview-title"><text>积分详情</text><button class="detail-link" @tap="s.go('ledger')">积分明细 ›</button></view>
            <view class="overview-stats"><view><text class="numeric" data-points-income>{{ s.summary.sum_integral }}</text><text>累计积分</text></view><view><text class="numeric" data-points-expense>{{ s.summary.deduction_integral }}</text><text>累计消费</text></view><view><text class="numeric" data-points-frozen>{{ s.summary.frozen_integral }}</text><text>冻结积分</text></view></view>
          </view>
        </view>
        <view class="points-panel interactions">
          <view class="panel-title">互动玩积分</view>
          <view class="interaction-list">
            <view class="interaction-card"><image class="card-art" src="/static/php-points/integralBg03.png" mode="scaleToFill" aria-hidden="true" /><view class="card-content"><view class="card-name">下单抵扣</view><text>积分抵扣商品金额</text><button aria-label="积分互动：去下单" @tap="s.go('shop')">去下单</button></view></view>
            <view class="interaction-card"><image class="card-art" src="/static/php-points/integralBg02.png" mode="scaleToFill" aria-hidden="true" /><view class="card-content"><view class="card-name">积分兑换</view><text>兑换心仪好物</text><button aria-label="积分互动：去兑换" @tap="s.go('mall')">去兑换</button></view></view>
            <view class="interaction-card"><image class="card-art" src="/static/php-points/integralBg01.png" mode="scaleToFill" aria-hidden="true" /><view class="card-content"><view class="card-name">抽奖赢积分</view><text>参与积分活动</text><button aria-label="积分互动：去抽奖" @tap="s.go('lottery')">去抽奖</button></view></view>
          </view>
        </view>
        <view class="points-panel tasks">
          <view class="panel-title">做任务领积分</view>
          <view class="task-row"><image src="/static/php-points/goumai.png" mode="aspectFit" /><view class="task-description"><view>购买商品</view><text>购买商品可获得</text></view><button aria-label="积分任务：购买商品" @tap="s.go('shop')">去完成</button></view>
          <view v-if="s.signEnabled" class="task-row" data-points-sign-task><image src="/static/php-points/qiandao.png" mode="aspectFit" /><view class="task-description"><view>每日签到</view><text>每日签到可获得</text></view><button aria-label="积分任务：每日签到" @tap="s.go('sign')">去完成</button></view>
          <view class="task-row"><image src="/static/php-points/choujiang.png" mode="aspectFit" /><view class="task-description"><view>九宫格抽奖</view><text>查看积分抽奖活动</text></view><button aria-label="积分任务：九宫格抽奖" @tap="s.go('lottery')">去完成</button></view>
        </view>
        <button class="refresh" :disabled="s.loading" @tap="s.load">刷新积分详情</button>
      </template>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { usePointsCentre } from '@/composables/usePointsCentre';
const s = reactive(usePointsCentre());
</script>
<style scoped>
.points-page{min-height:100vh;max-width:960px;margin:auto;background:#f5f5f5;padding-bottom:calc(30rpx + env(safe-area-inset-bottom));color:#333}.numeric{font-family:'CinaShop DIN',sans-serif;overflow-wrap:anywhere}.points-header{position:relative;height:380rpx;padding:36rpx 0 0;box-sizing:border-box;color:#fff;background:linear-gradient(90deg,var(--view-theme,#e93323),var(--view-gradient,#ff7931));border-radius:0 0 640rpx 640rpx/0 0 80rpx 80rpx}.header-art{position:absolute;top:22rpx;right:0;width:412rpx;height:378rpx;pointer-events:none}.current-score{position:relative;display:flex;align-items:center;gap:6rpx;margin-left:32rpx;font-size:24rpx}.current-score image{width:38rpx;height:37rpx}.points-notice{position:relative;margin:16rpx 32rpx 0;padding:10rpx 16rpx;background:rgba(0,0,0,.1);border-radius:50rpx;font-size:22rpx;line-height:1.6;width:fit-content;max-width:calc(100% - 64rpx);box-sizing:border-box}.score-number{position:relative;margin:8rpx 40rpx 0;font-size:72rpx;font-weight:600;line-height:1.2}.points-overview{position:relative;height:240rpx;margin:28rpx 20rpx 0;z-index:2;color:#333}.card-art{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.overview-title{position:relative;display:flex;align-items:center;gap:16rpx;padding:18rpx 32rpx 0;font-size:32rpx;font-weight:600}.detail-link{margin:0;padding:0;background:transparent;color:var(--view-theme,#e93323);font-size:22rpx;font-weight:400;line-height:2}.detail-link::after,.interaction-card button::after,.task-row button::after,.refresh::after{border:0}.overview-stats{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:36rpx;text-align:center;font-size:24rpx;color:#999}.overview-stats>view{display:flex;flex-direction:column;gap:12rpx;min-width:0;padding:0 10rpx}.overview-stats>view+view{border-left:1px solid #ddd}.overview-stats .numeric{color:#333;font-size:40rpx}.points-panel{margin:20rpx 20rpx 0;border-radius:24rpx;background:#fff;padding:0 24rpx 32rpx}.interactions{margin-top:150rpx}.panel-title{padding:32rpx 8rpx 36rpx;font-size:32rpx;font-weight:600}.interaction-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14rpx}.interaction-card{position:relative;min-height:294rpx;box-sizing:border-box;text-align:center;padding:110rpx 4rpx 20rpx;font-size:22rpx;color:#999}.card-content{position:relative}.card-name{font-size:28rpx;color:#333;margin-bottom:8rpx}.interaction-card button,.task-row button{width:136rpx;padding:0;background:linear-gradient(90deg,var(--view-theme,#e93323),var(--view-gradient,#ff7931));color:#fff;border-radius:50rpx;font-size:24rpx;line-height:56rpx;white-space:nowrap}.interaction-card button{margin:20rpx auto 0}.task-row{display:flex;align-items:center;gap:16rpx}.task-row+.task-row{margin-top:52rpx}.task-row>image{width:88rpx;height:88rpx;flex-shrink:0}.task-description{flex:1;min-width:0;font-size:28rpx}.task-description text{display:block;font-size:24rpx;color:#999;margin-top:8rpx}.task-row button{margin:0;flex-shrink:0}.refresh{margin:28rpx auto 0;width:300rpx;background:transparent;font-size:24rpx;color:#999;line-height:2.4}.state-card{padding:160rpx 40rpx;text-align:center;font-size:28rpx;line-height:1.8;color:#777}.state-title{font-size:34rpx;font-weight:600;color:#333;margin-bottom:20rpx}.state-card button{max-width:360rpx;margin:32rpx auto 0;color:var(--view-theme,#e93323);font-size:28rpx}.error{color:#b23f27;overflow-wrap:anywhere}
</style>
