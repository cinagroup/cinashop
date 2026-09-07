<template>
  <ul class="coupon-grid" aria-label="优惠券列表">
    <li v-for="coupon in coupons" :key="coupon.id" class="coupon-card" :class="{ selected: selectedId === coupon.id }">
      <div class="coupon-benefit"><strong>{{ coupon.benefit }}</strong><span>{{ coupon.minimum === '0.00' ? '无门槛' : `适用商品满 ¥${coupon.minimum}` }}</span></div>
      <div class="coupon-detail">
        <strong>{{ coupon.title }}</strong><span>{{ coupon.scope }}</span><small>{{ coupon.validity }}</small><small>{{ coupon.message }}</small>
        <small v-if="coupon.estimatedDiscount !== undefined">当前适用商品 ¥{{ coupon.eligibleSubtotal }} · 预计抵扣 ¥{{ coupon.estimatedDiscount }}</small>
        <button v-if="selectable" type="button" :aria-pressed="selectedId === coupon.id" :disabled="disabled || coupon.availability !== 'available'" @click="$emit('select', coupon.id)">
          {{ selectedId === coupon.id ? '已选择' : '选择' }}：{{ coupon.title }}
        </button>
      </div>
    </li>
  </ul>
</template>
<script setup lang="ts">
import type { OwnedCoupon } from "@/api/couponWallet";
defineProps<{ coupons: OwnedCoupon[]; selectable?: boolean; selectedId?: number; disabled?: boolean }>();
defineEmits<{ select: [id: number] }>();
</script>
<style scoped>
.coupon-grid { list-style: none; padding: 0; margin: 12px 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.coupon-card { display: flex; min-width: 0; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: white; }
.coupon-card.selected { border-color: #d93025; box-shadow: 0 0 0 1px #d93025; }
.coupon-benefit { flex: 0 0 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: #fff2ef; color: #b52b21; padding: 12px 6px; text-align: center; }
.coupon-benefit strong { font-size: 26px; }.coupon-benefit span { font-size: 12px; }
.coupon-detail { display: flex; flex-direction: column; min-width: 0; padding: 14px; gap: 8px; overflow-wrap: anywhere; }
.coupon-detail small { color: #666; }.coupon-detail button { color: #a3261e; background: white; border: 1px solid #dbafa9; border-radius: 5px; padding: 8px; text-align: left; cursor: pointer; }
.coupon-detail button:disabled { color: #777; background: #f3f4f6; cursor: not-allowed; }
@media (max-width: 800px) { .coupon-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 400px) { .coupon-benefit { flex-basis: 92px; }.coupon-detail { padding: 10px; } }
</style>
