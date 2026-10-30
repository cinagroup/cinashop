<template>
  <section class="coupon-preview" aria-label="优惠券只读预览">
    <p class="hint">客户端样式预览 · 只显示匿名公开优惠券，领取与优惠券中心按钮均只读。</p>
    <div :style="px(view.wrapperStyle)"><div class="coupon-panel" :style="px(view.panelStyle)">
      <p v-if="loading" role="status">正在读取优惠券…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开优惠券</p>
      <template v-else><div v-if="coupons.length" class="coupon-body" :style="px(view.bodyStyle)"><div class="coupon-content" :style="px(view.contentStyle)">
        <div class="coupon-scroll"><div class="coupon-items" :style="px(view.listStyle)"><DiyCouponPreviewCard v-for="coupon in coupons" :key="coupon.id" :coupon="coupon" :view="view" :label="couponDefaultLabel(coupon,view.style)" /></div></div>
        <div v-if="view.style===3" class="coupon-station" :style="px(view.stationStyle)"><span :style="px(view.stationTitleStyle)">先领券 再购物</span><span :style="px(view.stationInfoStyle)">领券下单·享购物优惠</span><button disabled :style="px(view.stationActionStyle)">立即领取</button></div>
      </div></div><p v-else class="hint">暂无可展示的优惠券</p><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
    </div></div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { couponDefaultLabel, couponPresentation } from '../../../../common/diyCoupon';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { listPixelStyle as px } from '@/utils/diyListEditor';
import type { CouponPreview } from '@/api/diyCouponAuthor';
import DiyCouponPreviewCard from './DiyCouponPreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;coupons:CouponPreview[];loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>couponPresentation(props.block,listPreviewTheme,listSafeColor));
</script>
<style scoped>
.coupon-preview{width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.coupon-scroll{width:100%;overflow-x:auto}.coupon-panel,.coupon-body,.coupon-content{box-sizing:border-box;min-width:0}
</style>
