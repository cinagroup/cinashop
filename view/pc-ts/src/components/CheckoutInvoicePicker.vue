<template>
  <section class="checkout-invoice" aria-label="订单发票">
    <h3>订单发票</h3>
    <div class="actions">
      <button type="button" :disabled="disabled || state.loading" :class="{ selected: !state.required }" :aria-pressed="!state.required" @click="$emit('select', null)">不开发票</button>
      <button type="button" :disabled="disabled || state.loading" @click="$emit('refresh')">刷新发票抬头</button>
      <button type="button" :disabled="disabled" @click="$emit('manage')">管理发票抬头</button>
    </div>
    <p v-if="state.loading" role="status">正在读取发票抬头…</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.page && !state.page.capabilities.enabled">暂未开启开票，可选择不开发票继续下单。</p>
    <div class="titles">
      <button v-for="title in titles" :key="title.id" type="button" :disabled="disabled || state.loading || !state.page?.capabilities.enabled || title.type === 2 && !state.page.capabilities.special" :class="{ selected: state.selected === title }" :aria-pressed="state.selected === title" @click="$emit('select', title)">{{ title.name }} · {{ invoiceTypeText(title) }}{{ title.isDefault ? ' · 默认' : '' }}</button>
    </div>
    <p v-if="state.page && !state.loading && !titles.length">暂无发票抬头，可先管理抬头后返回选择。</p>
    <div class="actions">
      <button v-if="state.canBack" type="button" :disabled="disabled || state.loading" @click="$emit('back')">上一页抬头</button>
      <button v-if="state.page?.nextCursor" type="button" :disabled="disabled || state.loading" @click="$emit('next')">下一页抬头</button>
    </div>
    <div v-if="state.selected" class="snapshot">
      <h4>本次申请的抬头资料</h4>
      <dl><div v-for="field in buyerInvoiceSnapshotFields(state.selected)" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl>
      <p>下单时保存这份抬头快照；支付后等待商家开票。</p>
    </div>
    <p v-else-if="state.required" role="alert">原抬头选择已清除，请重新选择，或选择不开发票后继续。</p>
    <p v-else>本次不申请发票。</p>
  </section>
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
h3,h4 { margin: 0 0 14px; } p { color: #667085; overflow-wrap: anywhere; }
.actions,.titles { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; padding: 9px 13px; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; color: #344054; cursor: pointer; }
button.selected { border-color: #e93323; color: #c9271c; background: #fff6f5; } button:disabled { opacity: .5; cursor: default; }
.snapshot { border-top: 1px solid #eaecf0; padding-top: 15px; } dl { margin: 0; } dl > div { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; } dt { color: #667085; width: 100px; } dd { margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 500px) { .checkout-invoice { padding: 16px; } dl > div { display: block; } dd { margin-top: 4px; } }
</style>
