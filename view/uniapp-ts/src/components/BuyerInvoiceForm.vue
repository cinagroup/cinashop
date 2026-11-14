<template>
  <view class="invoice-form" aria-label="编辑发票抬头">
    <view class="form-title">{{ draft.id ? '编辑抬头' : '新增抬头' }}</view>
    <view class="field-label">发票种类</view><view class="choices">
      <button size="mini" :class="{ primary: draft.type === 1 }" :disabled="disabled" @tap="draft.type = 1">普通发票</button>
      <button v-if="special || draft.type === 2" size="mini" :class="{ primary: draft.type === 2 }" :disabled="disabled" @tap="draft.type = 2; draft.headerType = 2">增值税专用发票</button>
    </view>
    <view class="field-label">抬头类型</view><view class="choices">
      <button size="mini" :class="{ primary: draft.headerType === 1 }" :disabled="disabled" @tap="draft.headerType = 1; draft.type = 1">个人</button>
      <button size="mini" :class="{ primary: draft.headerType === 2 }" :disabled="disabled" @tap="draft.headerType = 2">企业</button>
    </view>
    <label v-for="field in fields" :key="field.key" class="form-field"><text>{{ field.label }}{{ field.required ? ' *' : '（选填）' }}</text><input v-model="draft[field.key]" :aria-label="field.label" :disabled="disabled" :maxlength="field.max" /></label>
    <view class="default-field"><switch :checked="draft.isDefault" :disabled="disabled" @change="changeDefault" /><text>设为同类默认抬头</text></view>
    <view class="muted">默认项按个人/企业和发票种类分别设置。保存抬头后，还需在订单中提交开票申请。</view>
    <view class="actions"><button class="primary" :disabled="disabled" @tap="$emit('save')">保存抬头</button><button :disabled="disabled" @tap="$emit('cancel')">取消编辑</button></view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { BuyerInvoiceDraft } from '../../../common/buyerInvoices';
import { buyerInvoiceFormFields } from '../../../common/buyerInvoiceForm';
const props = defineProps<{ draft: BuyerInvoiceDraft; disabled: boolean; special: boolean }>();
defineEmits<{ save: []; cancel: [] }>();
function changeDefault(event: unknown) { const value = (event as { detail?: { value?: unknown } })?.detail?.value; if (typeof value === 'boolean') props.draft.isDefault = value; }
const fields = computed(() => buyerInvoiceFormFields(props.draft));
</script>
<style scoped>
.invoice-form{padding:32rpx;background:#fff;border:1px solid #dce3eb;border-radius:16rpx;margin:24rpx 0}.form-title{font-size:34rpx;font-weight:600;margin-bottom:24rpx}.field-label{margin:20rpx 0 12rpx}.choices,.actions{display:flex;flex-wrap:wrap;gap:16rpx}.choices button,.actions button{margin:0}.choices button{font-size:24rpx}.form-field{display:block;margin:24rpx 0}.form-field text{display:block;font-size:28rpx;margin-bottom:12rpx}.form-field input{background:#f6f7f9;border:1px solid #e2e7ee;border-radius:8rpx;min-height:84rpx;box-sizing:border-box;padding:16rpx;font-size:28rpx}.default-field{display:flex;align-items:center;gap:8rpx;margin:24rpx 0}.muted{font-size:24rpx;color:#65717d;line-height:1.8;margin:20rpx 0}.actions button{font-size:28rpx}button.primary{background:var(--view-theme,#e93323)}
</style>
