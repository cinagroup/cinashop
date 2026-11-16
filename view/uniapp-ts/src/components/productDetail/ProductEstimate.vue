<template>
  <view class="product-estimate" :data-product-estimate-owner="s.result?.ownerUid ?? ''" :data-product-estimate-product="s.result?.productId ?? ''" :data-product-estimate-sku="s.result?.skuUnique ?? ''" :data-product-estimate-state="s.loading?'loading':s.error?'error':s.result?'ready':'empty'">
    <view class="estimate-heading">单件预估到手 <text>所选规格 · 1 件</text></view>
    <view v-if="s.loading" class="estimate-note" role="status">正在读取当前规格的单件预估…</view>
    <view v-else-if="s.error" class="estimate-error" role="alert"><view>{{s.error}}</view><button size="mini" @tap="estimate.load">重新读取预估</button></view>
    <template v-else-if="s.result">
      <view class="estimate-total">¥{{s.result.computed.deduction.pay_price}}</view>
      <view v-if="quantity>1" class="estimate-note">当前已选 {{quantity}} 件；以下仅为 1 件预估，多件优惠请在结算页重新确认。</view>
      <view class="estimate-breakdown">
        <view><text>商品单价</text><text>¥{{s.result.computed.deduction.sum_price}}</text></view>
        <view><text>会员优惠</text><text>−¥{{s.result.computed.deduction.vip_price}}</text></view>
        <view><text>促销优惠</text><text>−¥{{s.result.computed.deduction.promotions_price}}</text></view>
        <view><text>首单优惠</text><text>−¥{{s.result.computed.deduction.first_order_price}}</text></view>
        <view><text>优惠券优惠</text><text>−¥{{s.result.computed.deduction.coupon_price}}</text></view>
      </view>
      <view v-if="s.result.firstOrderEligible" class="estimate-note">当前适用首单规则，优惠券与促销不叠加。</view>
      <view v-for="promotion in s.result.computed.promotions" :key="promotion.id" class="estimate-promotion">{{promotion.name}} · 省 ¥{{promotion.savings}}</view>
      <view v-if="s.result.computed.coupon" class="estimate-coupon"><view>{{s.result.computed.coupon.title}}</view><view>{{s.result.computed.coupon.isMember?'会员券 · ':''}}{{s.result.computed.coupon.requiresClaim?'需领取后使用':'已领取'}} · 预计省 ¥{{s.result.computed.coupon.savings}}</view></view>
      <view class="estimate-note">未含运费和积分抵扣；优惠与价格在结算时重新确认。</view>
    </template>
    <view v-else class="estimate-note">请选择有效规格后读取单件预估。</view>
  </view>
</template>
<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import type { useProductEstimate } from '@/composables/useProductEstimate';
const props = defineProps<{ estimate: UnwrapNestedRefs<ReturnType<typeof useProductEstimate>>; quantity: number }>();
const s = computed(() => props.estimate.state);
</script>
<style scoped>
.product-estimate{margin:0 24rpx 18rpx;padding:24rpx;background:#fff8f3;border:1rpx solid #efddd1;border-radius:14rpx;min-width:0;overflow-wrap:anywhere}.estimate-heading{font-size:28rpx;font-weight:600;display:flex;align-items:baseline;justify-content:space-between;gap:14rpx;flex-wrap:wrap}.estimate-heading>text{font-size:22rpx;font-weight:400;color:#765e50}.estimate-total{font-size:40rpx;font-weight:600;color:var(--view-priceColor,#ba3126);line-height:1.6;margin-top:10rpx}.estimate-breakdown{font-size:24rpx;line-height:1.8;margin-top:12rpx}.estimate-breakdown>view{display:flex;justify-content:space-between;gap:20rpx}.estimate-breakdown>view>text:last-child{flex-shrink:0}.estimate-note,.estimate-promotion{font-size:22rpx;color:#765e50;line-height:1.7;margin-top:12rpx}.estimate-coupon{margin-top:16rpx;padding-top:14rpx;border-top:1rpx solid #ead9cd;font-size:24rpx;line-height:1.7}.estimate-coupon>view:last-child{font-size:22rpx;color:#765e50}.estimate-error{font-size:24rpx;color:#a32922;line-height:1.7;margin-top:16rpx}.estimate-error button{margin:14rpx 0 0;padding:8rpx 18rpx;font:inherit;line-height:1.7;white-space:normal;background:#fff;border:1rpx solid #dfc4b2;color:#754d37}@media(min-width:768px){.product-estimate{margin:0 24px 20px;padding:22px}.estimate-heading{font-size:19px}.estimate-heading>text,.estimate-note,.estimate-promotion,.estimate-coupon>view:last-child{font-size:14px}.estimate-total{font-size:30px}.estimate-breakdown,.estimate-coupon,.estimate-error{font-size:16px}}
</style>
