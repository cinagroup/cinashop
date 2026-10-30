<template>
  <div class="coupon-card" :data-coupon-id="coupon.id" :data-coupon-style="view.style" :style="px(view.itemStyle)">
    <template v-if="view.style===2">
      <div class="coupon-card-inner" :style="px(view.innerStyle)"><div class="coupon-card-copy" :style="px(view.textStyle)">
        <div class="coupon-money" :style="px(view.moneyStyle)">{{money.prefix}}<span class="coupon-number" :style="px(view.numberStyle)">{{money.number}}</span>{{money.suffix}}</div>
        <div class="coupon-condition" :style="px(view.conditionStyle)">{{condition}}</div>
        <div class="coupon-notch-top" :style="px(view.notchTop)" /><div class="coupon-notch-bottom" :style="px(view.notchBottom)" />
      </div><button class="coupon-claim" :style="px(view.actionStyle)" disabled aria-label="优惠券只读领取按钮"><div class="coupon-divider" :style="px(view.dividerStyle)" />{{label}}</button></div>
    </template>
    <template v-else>
      <div v-if="view.style===1 || view.style===3" class="coupon-scope" :style="px(view.nameStyle)"><div v-if="view.style===3" :style="px(view.nameInnerStyle)">{{scope}}</div><template v-else>{{scope}}</template></div>
      <div class="coupon-card-copy" :style="px(view.textStyle)">
        <div class="coupon-money" :style="px(view.moneyStyle)">{{money.prefix}}<span class="coupon-number" :style="px(view.numberStyle)">{{money.number}}</span>{{money.suffix}}</div>
        <div class="coupon-condition" :style="px(view.conditionStyle)">{{condition}}</div>
      </div>
      <button v-if="view.style!==3" class="coupon-claim" :style="px(view.actionStyle)" disabled aria-label="优惠券只读领取按钮"><div v-if="view.style===0" class="coupon-curve" :style="px(view.curveStyle)" />{{label}}</button>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { couponCondition, couponMoneyParts, couponScope, type DiyCouponRow, type DiyCouponPresentation } from '../../../../common/diyCoupon';
import { listPixelStyle as px } from '@/utils/diyListEditor';
const props=defineProps<{coupon:DiyCouponRow;view:DiyCouponPresentation;label:string}>();
const money=computed(()=>couponMoneyParts(props.coupon)),condition=computed(()=>couponCondition(props.coupon)),scope=computed(()=>couponScope(props.coupon));
</script>
<style scoped>
.coupon-card{white-space:normal}.coupon-claim::after{border:0}.coupon-claim[disabled]{opacity:.7}.coupon-claim{cursor:pointer}.coupon-claim[disabled]{cursor:default}
</style>
