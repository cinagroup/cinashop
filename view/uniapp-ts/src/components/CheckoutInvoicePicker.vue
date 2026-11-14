<template>
  <view class="checkout-invoice" aria-label="订单发票">
    <view class="heading">订单发票</view>
    <view class="actions">
      <button size="mini" :disabled="disabled || state.loading" :class="{ selected: !state.required }" :aria-pressed="!state.required" @tap="$emit('select', null)">不开发票</button>
      <button size="mini" :disabled="disabled || state.loading" @tap="$emit('refresh')">刷新发票抬头</button>
      <button size="mini" :disabled="disabled" @tap="$emit('manage')">管理发票抬头</button>
    </view>
    <view v-if="state.loading" role="status">正在读取发票抬头…</view>
    <view v-if="state.error" role="alert">{{ state.error }}</view>
    <view v-if="state.page && !state.page.capabilities.enabled">暂未开启开票，可选择不开发票继续下单。</view>
    <view class="titles">
      <button v-for="title in titles" :key="title.id" size="mini" :disabled="disabled || state.loading || !state.page?.capabilities.enabled || title.type === 2 && !state.page.capabilities.special" :class="{ selected: state.selected === title }" :aria-pressed="state.selected === title" @tap="$emit('select', title)">{{ title.name }} · {{ invoiceTypeText(title) }}{{ title.isDefault ? ' · 默认' : '' }}</button>
    </view>
    <view v-if="state.page && !state.loading && !titles.length">暂无发票抬头，可先管理抬头后返回选择。</view>
    <view class="actions">
      <button v-if="state.canBack" size="mini" :disabled="disabled || state.loading" @tap="$emit('back')">上一页抬头</button>
      <button v-if="state.page?.nextCursor" size="mini" :disabled="disabled || state.loading" @tap="$emit('next')">下一页抬头</button>
    </view>
    <view v-if="state.selected" class="snapshot">
      <view class="heading">本次申请的抬头资料</view>
      <view class="fields"><view v-for="field in buyerInvoiceSnapshotFields(state.selected)" :key="field.label"><view class="label">{{ field.label }}</view><view class="value">{{ field.value }}</view></view></view>
      <view>下单时保存这份抬头快照；支付后等待商家开票。</view>
    </view>
    <view v-else-if="state.required" role="alert">原抬头选择已清除，请重新选择，或选择不开发票后继续。</view>
    <view v-else>本次不申请发票。</view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { CheckoutInvoiceState } from '../../../common/checkoutInvoice';
import type { BuyerInvoiceTitle } from '../../../common/buyerInvoices';
import { buyerInvoiceSnapshotFields } from '../../../common/buyerInvoiceForm';
import { invoiceTypeText } from '../../../common/buyerInvoiceFlow';
const props = defineProps<{ state: CheckoutInvoiceState; disabled?: boolean }>();
defineEmits<{ select: [title: BuyerInvoiceTitle | null]; refresh: []; next: []; back: []; manage: [] }>();
const titles = computed(() => props.state.page?.query.kind === 'titles' ? props.state.page.items as BuyerInvoiceTitle[] : []);
</script>
<style scoped>
.checkout-invoice { padding: 24px; margin: 20px 0; background: #fff; border-radius: 8px; min-width: 0; }
.heading { margin: 0 0 14px; font-size: 18px; font-weight: 600; color: #1d2939; } .checkout-invoice { color: #344054; overflow-wrap: anywhere; }
.actions,.titles { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; padding: 9px 13px; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; color: #344054; cursor: pointer; }
button.selected { border-color: #e93323; color: #c9271c; background: #fff6f5; } button:disabled { opacity: .5; cursor: default; }
.snapshot { border-top: 1px solid #eaecf0; padding-top: 15px; } .fields { margin: 0; } .fields > view { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; } .label { color: #667085; width: 100px; } .value { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 500px) { .checkout-invoice { padding: 16px; } .fields > view { display: block; } .value { margin-top: 4px; } }
</style>
