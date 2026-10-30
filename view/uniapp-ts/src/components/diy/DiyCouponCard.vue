<template>
  <view class="coupon-card" :data-coupon-id="coupon.id" :data-coupon-style="view.style" :style="view.itemStyle">
    <template v-if="view.style===2">
      <view class="coupon-card-inner" :style="view.innerStyle"><view class="coupon-card-copy" :style="view.textStyle">
        <view class="coupon-money" :style="view.moneyStyle">{{money.prefix}}<text class="coupon-number" :style="view.numberStyle">{{money.number}}</text>{{money.suffix}}</view>
        <view class="coupon-condition" :style="view.conditionStyle">{{condition}}</view>
        <view class="coupon-notch-top" :style="view.notchTop" /><view class="coupon-notch-bottom" :style="view.notchBottom" />
      </view><button class="coupon-claim" :style="view.actionStyle" :disabled="disabled" @tap="tap"><view class="coupon-divider" :style="view.dividerStyle" />{{label}}</button></view>
    </template>
    <template v-else>
      <view v-if="view.style===1 || view.style===3" class="coupon-scope" :style="view.nameStyle"><view v-if="view.style===3" :style="view.nameInnerStyle">{{scope}}</view><template v-else>{{scope}}</template></view>
      <view class="coupon-card-copy" :style="view.textStyle">
        <view class="coupon-money" :style="view.moneyStyle">{{money.prefix}}<text class="coupon-number" :style="view.numberStyle">{{money.number}}</text>{{money.suffix}}</view>
        <view class="coupon-condition" :style="view.conditionStyle">{{condition}}</view>
      </view>
      <button v-if="view.style!==3" class="coupon-claim" :style="view.actionStyle" :disabled="disabled" @tap="tap"><view v-if="view.style===0" class="coupon-curve" :style="view.curveStyle" />{{label}}</button>
    </template>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { couponCondition, couponMoneyParts, couponScope, type DiyCouponRow, type DiyCouponPresentation } from '../../../../common/diyCoupon';
const props=defineProps<{coupon:DiyCouponRow;view:DiyCouponPresentation;label:string;disabled:boolean;tap:()=>void}>();
const money=computed(()=>couponMoneyParts(props.coupon)),condition=computed(()=>couponCondition(props.coupon)),scope=computed(()=>couponScope(props.coupon));
</script>
<style scoped>
.coupon-card{white-space:normal}.coupon-claim::after{border:0}.coupon-claim[disabled]{opacity:.7}.coupon-claim{cursor:pointer}.coupon-claim[disabled]{cursor:default}
</style>
