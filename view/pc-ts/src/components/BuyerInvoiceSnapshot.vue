<template>
  <section class="invoice-snapshot" aria-label="订单开票记录">
    <h3>{{ invoiceStateText(invoice) }}</h3><p>{{ invoiceTypeText(invoice) }}</p>
    <el-alert v-if="invoice.refunded" title="该开票记录关联的订单已有退款标记，后续票据处理请联系商家核对。" :closable="false" />
    <dl><dt>订单号</dt><dd>{{ invoice.orderNo }}</dd><dt>开票金额</dt><dd>{{ invoice.amount === null ? '历史记录未保存金额，请联系商家核对' : '¥' + invoice.amount }}</dd>
      <dt>申请时间</dt><dd>{{ invoice.addTime || '未记录' }}</dd><template v-if="invoice.state === 1"><dt>发票号码</dt><dd>{{ invoice.invoiceNumber || '未记录' }}</dd><dt>开票时间</dt><dd>{{ invoice.invoiceTime || '未记录' }}</dd></template>
      <template v-if="invoice.state === -1"><dt>拒绝原因</dt><dd>{{ invoice.remark || '请联系商家核对' }}</dd></template>
    </dl>
    <h4>申请时的抬头资料</h4><dl><template v-for="field in snapshot" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></template></dl>
    <p class="muted">修改或删除抬头资料不会改变本次申请的快照。</p>
  </section>
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
.invoice-snapshot{background:#fff;border:1px solid #e2e7ee;border-radius:10px;padding:24px;overflow-wrap:anywhere}.invoice-snapshot h3{font-size:20px;margin:0 0 10px}.invoice-snapshot h4{margin-top:24px}.invoice-snapshot dl{display:grid;grid-template-columns:130px minmax(0,1fr);gap:14px}.invoice-snapshot dt,.muted{color:#66717f}.invoice-snapshot dd{margin:0;line-height:1.6}.muted{font-size:13px;line-height:1.7}@media(max-width:640px){.invoice-snapshot{padding:18px}.invoice-snapshot dl{grid-template-columns:1fr;gap:6px}.invoice-snapshot dd{margin-bottom:10px}}
</style>
