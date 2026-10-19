<script setup lang="ts">
import type { SupplierOrderInvoiceReview } from '@/utils/orderInvoiceReview';
import { reviewMoney } from '@/utils/orderReview';
defineProps<{ invoice?: SupplierOrderInvoiceReview; paymentSummary: boolean }>();
</script>

<template>
  <section class="invoice-review" aria-label="发票申请记录">
    <h3>发票申请记录</h3>
    <p v-if="!invoice" role="status">发票申请信息未返回，请重新读取详情。</p>
    <p v-else-if="invoice.state === 'none'" role="status">本订单未记录发票申请。</p>
    <p v-else-if="invoice.state === 'unavailable'" role="status">发票申请暂无法核对：{{ invoice.reason }}</p>
    <template v-else-if="invoice.record">
      <p v-if="invoice.record.archived" class="invoice-note" role="note">这是已归档的发票申请记录。</p>
      <p v-if="paymentSummary" class="invoice-note" role="note">这是付款汇总的历史申请，请按实际子订单核对发票归属，金额勿与子订单重复相加。</p>
      <dl class="invoice-facts">
        <div><dt>发票类型</dt><dd>{{ invoice.record.type === 1 ? '电子普通发票' : '纸质专用发票' }}</dd></div>
        <div><dt>抬头类型</dt><dd>{{ invoice.record.header_type === 1 ? '个人' : '企业' }}</dd></div>
        <div><dt>发票抬头</dt><dd>{{ invoice.record.name || '未记录' }}</dd></div>
        <div><dt>税号</dt><dd>{{ invoice.record.duty_number || '未记录' }}</dd></div>
        <div><dt>邮箱</dt><dd>{{ invoice.record.email || '未记录' }}</dd></div>
        <div><dt>开户银行</dt><dd>{{ invoice.record.bank || '未记录' }}</dd></div>
        <div><dt>企业地址</dt><dd>{{ invoice.record.address || '未记录' }}</dd></div>
        <div><dt>企业电话</dt><dd>{{ invoice.record.drawer_phone || '未记录' }}</dd></div>
        <div><dt>申请记录金额</dt><dd>{{ reviewMoney(invoice.record.recorded_amount) }}</dd></div>
        <div><dt>记录中的开票状态</dt><dd>{{ invoice.record.issuance_state === 1 ? '已开票' : invoice.record.issuance_state === -1 ? '已拒绝' : '待开票' }}</dd></div>
      </dl>
      <p class="invoice-note">此处显示本订单的发票申请记录，金额与状态不代表税务平台核验结果。</p>
    </template>
  </section>
</template>

<style scoped>
.invoice-review { min-width: 0; margin: 22px 0; }
.invoice-review h3 { font-size: 15px; margin: 0 0 12px; }
.invoice-review p { overflow-wrap: anywhere; line-height: 1.7; }
.invoice-note { color: var(--el-text-color-secondary); font-size: 13px; }
.invoice-facts { margin: 0; display: grid; gap: 12px; }
.invoice-facts > div { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 12px; }
.invoice-facts dt { color: var(--el-text-color-secondary); }
.invoice-facts dd { min-width: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) { .invoice-facts > div { grid-template-columns: minmax(0, 1fr); gap: 5px; } }
</style>
