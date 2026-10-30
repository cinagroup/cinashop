<template>
  <view v-if="active && view.enabled" class="diy-coupon-widget" :data-coupon-layout="view.style" :style="view.wrapperStyle">
    <view class="coupon-panel" :style="view.panelStyle">
      <view v-if="state.loading.value" class="coupon-status" role="status">正在读取优惠券…</view>
      <view v-else-if="state.error.value" class="coupon-error" role="alert">{{state.error.value}}</view>
      <template v-else-if="state.loaded.value">
        <view v-if="entries.length" class="coupon-body" :style="view.bodyStyle"><view class="coupon-content" :style="view.contentStyle">
          <scroll-view scroll-x :show-scrollbar="false" class="coupon-scroll"><view class="coupon-items" :style="view.listStyle"><DiyCouponCard v-for="entry in entries" :key="entry.coupon.id" :coupon="entry.coupon" :view="view" :label="entry.label" :disabled="entry.disabled" :tap="entry.tap" /></view></scroll-view>
          <view v-if="view.style===3" class="coupon-station" :style="view.stationStyle"><text :style="view.stationTitleStyle">先领券 再购物</text><text :style="view.stationInfoStyle">领券下单·享购物优惠</text><button class="coupon-centre" :style="view.stationActionStyle" @tap="actions.more">立即领取</button></view>
        </view></view>
        <view v-else class="coupon-status">暂无可展示的优惠券</view>
        <view v-if="view.limitNotice" class="coupon-status">{{view.limitNotice}}</view>
      </template>
      <view v-if="state.claimNotice.value" class="coupon-status" role="status">{{state.claimNotice.value}}</view>
      <button v-if="state.hasCouponJournal.value" class="coupon-reconcile" :disabled="!!state.claiming.value" @tap="actions.reconcile">只读核对领取结果</button>
      <button v-if="state.hasCouponJournal.value" class="coupon-wallet" @tap="actions.more">到优惠券中心核对</button>
      <button class="coupon-refresh" :disabled="state.loading.value" @tap="actions.refresh">{{state.error.value?'重试优惠券':'刷新优惠券'}}</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import type { DiyComponent } from '@/api/diy';
import { useDiyCoupon } from '@/composables/useDiyCoupon';
import DiyCouponCard from './DiyCouponCard.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const {view,state,entries,actions}=useDiyCoupon(()=>props.block,()=>props.active);
</script>
<style scoped>
.diy-coupon-widget,.coupon-panel,.coupon-body,.coupon-content,.coupon-scroll{min-width:0;box-sizing:border-box}.coupon-scroll{width:100%}.coupon-status,.coupon-error{font-size:24rpx;padding:20rpx;white-space:normal;overflow-wrap:anywhere}.coupon-error{color:#a33}.coupon-centre::after{border:0}.coupon-refresh,.coupon-reconcile,.coupon-wallet{font-size:23rpx;line-height:2.2;margin:12rpx 20rpx}
</style>
