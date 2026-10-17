<template>
 <view class="cw-card" data-supplier-refund-settlement="customer">
  <text class="cw-subtitle">供应商累计退款</text>
  <text class="cw-scope">按当前订单核对首笔商品退款和后续补退款。</text>
  <button class="cw-full" :disabled="disabled || !target || operations.busy.value" @tap="verify">{{ operations.busy.value?'正在核验累计退款…':'核验供应商累计退款' }}</button>
  <text v-if="operations.error.value" class="cw-error" role="alert">{{ operations.error.value }}</text>
  <template v-if="operations.summary.value">
   <text class="cw-scope">已核验本次快照 · 首笔商品退款单 {{ operations.summary.value.refund_no }}。后续变动请重新核验。</text>
   <view class="cw-row"><text>订单实付</text><text>¥{{ operations.summary.value.paid }}</text></view>
   <view class="cw-row"><text>首笔商品退款</text><text>¥{{ operations.summary.value.goods_refunded }}</text></view>
   <view class="cw-row"><text>后续补退款</text><text>¥{{ operations.summary.value.money_refunded }}</text></view>
   <view class="cw-row"><text>累计已退</text><text class="cw-money">¥{{ operations.summary.value.refunded }}</text></view>
   <view class="cw-row"><text>剩余可退金额</text><text>¥{{ operations.summary.value.available }}</text></view>
   <view class="cw-row"><text>补退次数</text><text>{{ operations.summary.value.money_payouts }} 次</text></view>
  </template>
  <text v-else-if="!operations.busy.value && !operations.error.value" class="cw-scope">尚未核验累计退款，原退款申请金额仍按申请记录展示。</text>
 </view>
</template>
<script setup lang="ts">
import {onUnmounted,watch} from 'vue';
import type {CustomerSupplierRefundSettlement,CustomerSupplierRefundSettlementTarget} from '@/composables/useCustomerSupplierRefundSettlement';
const props=defineProps<{operations:CustomerSupplierRefundSettlement;target:CustomerSupplierRefundSettlementTarget|null;disabled?:boolean}>();
watch(()=>props.target,()=>props.operations.clear(),{deep:true,flush:'sync'});
watch(()=>props.disabled,value=>{if(value)props.operations.clear();},{flush:'sync'});
onUnmounted(()=>props.operations.clear());
function verify(){if(!props.disabled&&props.target&&!props.operations.busy.value)void props.operations.load(props.target);}
</script>
