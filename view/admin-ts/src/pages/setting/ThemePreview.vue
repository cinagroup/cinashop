<template>
  <section class="theme-preview" :style="themeStyle(status)" :aria-label="preset.name + '商城场景预览'">
    <div class="hero"><strong>商城首页</strong><span>精选好物 · 每日上新</span></div>
    <div class="tabs"><span>全部</span><span class="selected">精选商品</span><span>购物车</span></div>
    <div class="product"><div class="picture">好物</div><div><strong>品质生活商品</strong><p class="price">¥ 99.00</p><span class="chip">已选：标准款</span></div></div>
    <div class="actions"><span class="cart">加入购物车</span><span class="buy">立即购买</span></div>
    <div class="coupon"><strong>¥ 10 优惠券</strong><span>领取</span></div>
    <div class="checkout"><span>订单结算</span><b class="price">合计 ¥ 99.00</b><span class="submit">提交订单</span></div>
    <div class="account"><span>会员中心</span><span class="state">退款处理中</span></div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { themePreset, themeStyle, type ThemeStatus } from '../../../../common/theme';
const props = defineProps<{ status: ThemeStatus }>();
const preset = computed(() => themePreset(props.status));
</script>
<style scoped>
.theme-preview{background:#fafafa;border:1px solid #eee;border-radius:10px;overflow:hidden;font-size:12px;text-align:left;color:#333}.hero{display:flex;flex-direction:column;gap:8px;color:white;padding:16px;background:linear-gradient(110deg,var(--view-theme),var(--view-gradient))}.hero strong{font-size:16px}.tabs{display:flex;justify-content:space-around;padding:13px 8px;background:#fff}.selected{color:var(--view-theme);border-bottom:2px solid var(--view-theme);padding-bottom:4px}.product{display:flex;gap:12px;padding:15px;background:#fff}.picture{width:58px;height:64px;background:#eee;display:grid;place-items:center;color:#999}.price{color:var(--view-priceColor);font-size:15px;margin:9px 0}.chip{background:var(--view-minorColorT);border:1px solid var(--view-minorColor);color:var(--view-theme);padding:3px 7px;border-radius:4px}.actions{display:flex;gap:8px;padding:12px;background:#fff}.actions>span{padding:8px;text-align:center;border-radius:20px;flex:1;color:#fff}.cart{background:var(--view-bntColor)}.buy,.submit{background:var(--view-theme)}.coupon{display:flex;justify-content:space-between;margin:12px;padding:12px;border:1px solid var(--view-theme);color:var(--view-priceColor);background:#fff}.coupon span{color:var(--view-theme)}.checkout{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px;background:#fff}.submit{padding:7px 10px;color:white;border-radius:16px}.account{display:flex;justify-content:space-between;align-items:center;padding:12px;background:var(--view-minorColorT);color:var(--view-theme)}.state{font-size:11px;color:#b54708;background:#fff4e5;padding:4px;border-radius:4px}
</style>
