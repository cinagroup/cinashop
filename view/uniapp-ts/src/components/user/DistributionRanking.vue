<template>
 <view class="ranking-page" :class="{commission:state.kind==='commission'}" :data-ranking-kind="state.kind">
  <view class="rank-header">
   <template v-if="state.kind==='promoter'"><view class="rank-intro"><image class="ranking-title" src="/static/php-rankings/ranking.png" mode="aspectFit"/><view class="rank-tip">{{ tip }}<text v-if="state.mine && state.mine.position" class="rank-number">{{ state.mine.position }}</text><text v-if="state.mine && state.mine.position">名</text></view></view><image class="trophy" src="/static/php-rankings/trophy.png" mode="aspectFit"/></template>
   <view v-else class="rank-tip">{{ tip }}<text v-if="state.mine && state.mine.position" class="rank-number">{{ state.mine.position }}</text><text v-if="state.mine && state.mine.position">名</text></view>
  </view>
  <view class="rank-wrapper">
   <view class="rank-tabs"><button v-for="period in periods" :key="period.value" class="rank-tab" :class="{selected:state.type===period.value}" :aria-selected="state.type===period.value" @tap="state.switchPeriod(period.value)">{{ period.label }}</button></view>
   <view v-if="!state.loggedIn" class="rank-state"><view>登录后查看排行榜</view><button class="rank-control" @tap="state.login">去登录</button></view>
   <template v-else>
    <view class="rank-list"><view v-for="row in state.items" :key="row.uid" class="rank-row" :data-rank-uid="row.uid" :data-rank-position="row.position">
     <view class="rank-place"><image v-if="row.position<=3" :src="'/static/php-rankings/no'+row.position+'.png'" mode="aspectFit"/><text v-else>{{ row.position }}</text></view>
     <view class="rank-avatar"><image v-if="row.image.src" :key="row.image.key" :src="row.image.src" mode="aspectFill" @error="row.image.error"/><text v-else class="avatar-fallback">{{ (row.nickname || '神秘人').slice(0,1) }}</text></view>
     <text class="rank-nickname">{{ row.nickname || '神秘人' }}</text><text class="rank-value">{{ state.kind==='promoter'?row.value+'人':'￥'+row.value }}</text>
    </view></view>
    <view v-if="state.loading" class="rank-state" role="status">排行榜读取中…</view>
    <view v-if="state.error" class="rank-state rank-error" role="alert">{{ state.error }}</view>
    <view v-if="state.loaded && !state.loading && !state.error && !state.items.length" class="rank-empty"><image src="/static/php-points/noOrder.gif" mode="aspectFit"/><view>暂无排行榜数据哦～</view></view>
    <button v-if="state.error" class="rank-control" :disabled="state.loading" @tap="state.retry">重试当前页</button>
    <button v-if="state.hasMore && !state.error" class="rank-control" :disabled="state.loading" @tap="state.load(true)">{{ state.loading?'读取中…':'加载更多' }}</button>
    <view v-if="state.loaded && state.items.length && !state.hasMore && !state.loading && !state.error" class="rank-end">{{ state.page===500?'已显示前10000名':'没有更多了～' }}</view>
    <view v-if="state.mediaExpired" class="rank-state">头像已过期，请刷新排行榜</view>
    <button class="rank-control rank-refresh" :disabled="state.loading" @tap="state.refresh">刷新排行榜</button>
   </template>
  </view>
  <view v-if="state.kind==='commission' && state.mine && state.mine.position>0" class="self-spacer"/>
  <view v-if="state.kind==='commission' && state.mine && state.mine.position>0" class="rank-self" :data-self-position="state.mine.position">
   <text class="self-label">我</text><view class="rank-avatar"><image v-if="state.mine.image.src" :key="state.mine.image.key" :src="state.mine.image.src" mode="aspectFill" @error="state.mine.image.error"/><text v-else class="avatar-fallback">{{ (state.mine.nickname || '我').slice(0,1) }}</text></view><text class="self-name">{{ state.mine.nickname || '神秘人' }}</text><text class="self-position">第{{ state.mine.position }}名</text><text class="self-value">￥{{ state.mine.value }}</text>
  </view>
 </view>
</template>
<script setup lang="ts">
import {computed,type UnwrapNestedRefs} from 'vue';
import type {useDistributionRankings} from '@/composables/useDistributionRankings';
import type {RankingPeriod} from '@/api/distributionRankings';
const props=defineProps<{state:UnwrapNestedRefs<ReturnType<typeof useDistributionRankings>>}>();
const periods:{value:RankingPeriod;label:string}[]=[{value:'week',label:'周排行'},{value:'month',label:'月排行'}];
const tip=computed(()=>!props.state.loggedIn?'登录后查看我的排名':props.state.loading&&!props.state.mine?'排名读取中…':props.state.error&&!props.state.mine?'排名暂不可用':props.state.mine?.position?'您目前的排名':'您目前暂无排名');
</script>
<style scoped>
.ranking-page{min-height:100vh;max-width:750rpx;margin:auto;background:#f5f5f5;padding-bottom:30rpx;color:#333;box-sizing:border-box}.rank-header{display:flex;align-items:flex-start;justify-content:flex-end;height:560rpx;padding-top:26rpx;box-sizing:border-box;background:linear-gradient(180deg,#fccea4 50%,#f5f5f5 100%)}.rank-intro{padding-top:30rpx;flex-shrink:0}.ranking-title{display:block;width:352rpx;height:76rpx}.rank-tip{font-size:28rpx;line-height:56rpx;color:#d25f00;margin-top:30rpx}.rank-number{font:40rpx/56rpx 'CinaShop DIN',sans-serif;margin:0 8rpx}.trophy{width:324rpx;height:260rpx;margin-left:38rpx;flex-shrink:0}.rank-wrapper{position:relative;width:710rpx;max-width:calc(100% - 40rpx);margin:-278rpx auto 0;background:white;border-radius:20rpx;overflow:hidden}.rank-tabs{display:flex;justify-content:space-around}.rank-tab{margin:0;padding:32rpx 0 12rpx;position:relative;line-height:44rpx;font-size:28rpx;color:#999;background:transparent;border-radius:0;min-width:160rpx}.rank-tab::after,.rank-control::after{border:0}.rank-tab.selected{color:#333;font-size:32rpx;font-weight:600}.rank-tab.selected::after{content:'';position:absolute;width:56rpx;height:4rpx;background:#e93323;border-radius:2rpx;left:50%;top:auto;bottom:0;margin-left:-28rpx}.rank-list{padding:0 44rpx 32rpx 28rpx}.rank-row{display:flex;align-items:center;margin-top:48rpx;font-size:28rpx;min-height:80rpx}.rank-place{flex-shrink:0;width:64rpx;height:64rpx;line-height:64rpx;text-align:center;color:#999}.rank-place image{display:block;width:100%;height:100%}.rank-avatar{flex-shrink:0;display:flex;align-items:center;justify-content:center;width:80rpx;height:80rpx;border-radius:50%;background:#f8eee5;overflow:hidden;margin-left:28rpx}.rank-avatar image{width:100%;height:100%}.avatar-fallback{font-size:28rpx;color:#b67e4d}.rank-nickname{flex:1;min-width:0;max-width:180rpx;margin-left:24rpx;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rank-value{margin-left:auto;padding-left:12rpx;max-width:240rpx;text-align:right;overflow-wrap:anywhere;line-height:40rpx}.rank-state,.rank-end{text-align:center;font-size:26rpx;line-height:42rpx;color:#999;padding:28rpx 24rpx}.rank-error{color:#b34428}.rank-control{background:transparent;color:#999;font-size:26rpx;line-height:64rpx;max-width:360rpx;margin:12rpx auto}.rank-refresh{margin-top:0;margin-bottom:24rpx}.rank-empty{text-align:center;padding:48rpx 24rpx;font-size:28rpx;color:#999}.rank-empty image{width:360rpx;height:300rpx;display:block;margin:0 auto 24rpx}.commission .rank-header{height:434rpx;display:block;width:100%;background:#f5f5f5 url('/static/php-rankings/brokerage_rank_bg2.png') center/100% 100% no-repeat}.commission .rank-tip{color:#ffcb99;margin:164rpx 0 0 46rpx}.commission .rank-wrapper{margin-top:-154rpx}.self-spacer{height:calc(130rpx + env(safe-area-inset-bottom))}.rank-self{position:fixed;z-index:20;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:750rpx;box-sizing:border-box;min-height:calc(128rpx + env(safe-area-inset-bottom));padding:20rpx 40rpx calc(20rpx + env(safe-area-inset-bottom));display:flex;align-items:center;background:#fff;border-top:1px solid #eee;font-size:28rpx}.self-label,.self-position{color:#ff7d00}.rank-self .rank-avatar{margin-left:24rpx}.self-name{max-width:164rpx;margin-left:24rpx;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.self-position{flex-shrink:0;margin-left:16rpx}.self-value{margin-left:auto;padding-left:12rpx;max-width:230rpx;overflow-wrap:anywhere;line-height:40rpx}
</style>
