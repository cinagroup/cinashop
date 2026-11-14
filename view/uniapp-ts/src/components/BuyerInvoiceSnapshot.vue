<template>
  <view class="snapshot" aria-label="订单开票记录"><view class="snapshot-title">{{ invoiceStateText(invoice) }}</view><view class="muted">{{ invoiceTypeText(invoice) }}</view>
    <view v-if="invoice.refunded" class="notice">该开票记录关联的订单已有退款标记，后续票据处理请联系商家核对。</view>
    <view class="row"><text>订单号</text><text>{{ invoice.orderNo }}</text></view><view class="row"><text>开票金额</text><text>{{ invoice.amount === null ? '历史记录未保存金额，请联系商家核对' : '¥' + invoice.amount }}</text></view>
    <view class="row"><text>申请时间</text><text>{{ invoice.addTime || '未记录' }}</text></view>
    <template v-if="invoice.state === 1"><view class="row"><text>发票号码</text><text>{{ invoice.invoiceNumber || '未记录' }}</text></view><view class="row"><text>开票时间</text><text>{{ invoice.invoiceTime || '未记录' }}</text></view></template>
    <view v-if="invoice.state === -1" class="row"><text>拒绝原因</text><text>{{ invoice.remark || '请联系商家核对' }}</text></view>
    <view class="subtitle">申请时的抬头资料</view><view v-for="field in snapshot" :key="field.label" class="row"><text>{{ field.label }}</text><text>{{ field.value }}</text></view>
    <view class="muted">修改或删除抬头资料不会改变本次申请的快照。</view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { BuyerInvoiceRecord } from '../../../common/buyerInvoices';
import { invoiceStateText, invoiceTypeText } from '../../../common/buyerInvoiceFlow';
import { buyerInvoiceSnapshotFields } from '../../../common/buyerInvoiceForm';
const props = defineProps<{ invoice: BuyerInvoiceRecord }>();
const snapshot = computed(() => buyerInvoiceSnapshotFields(props.invoice));
</script>
<style scoped>
.snapshot{background:#fff;border-radius:16rpx;padding:32rpx;overflow-wrap:anywhere}.snapshot-title{font-size:38rpx;font-weight:600;margin-bottom:16rpx}.subtitle{font-size:30rpx;font-weight:600;margin:36rpx 0 20rpx}.row{display:flex;flex-direction:column;gap:10rpx;margin:24rpx 0;line-height:1.6;font-size:28rpx}.row>text:first-child,.muted{color:#65717d}.muted{font-size:24rpx;line-height:1.8}.notice{padding:20rpx;background:#fff7e8;line-height:1.8;font-size:26rpx;margin-top:24rpx}
</style>
