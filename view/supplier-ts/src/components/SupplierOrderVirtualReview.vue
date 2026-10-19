<script setup lang="ts">
import type { SupplierOrderVirtualReview } from '@/utils/orderVirtualReview';
defineProps<{ delivery?: SupplierOrderVirtualReview; productType: number }>();
</script>

<template>
  <section v-if="productType === 1" class="virtual-delivery-review" aria-label="卡密与固定内容交付记录">
    <h3>卡密与固定内容交付记录</h3>
    <p v-if="!delivery" role="status">卡密交付信息未返回，请重新读取详情。</p>
    <p v-else-if="delivery.state === 'not_delivered'" role="status">本订单尚未记录卡密交付：{{ delivery.reason }}</p>
    <p v-else-if="delivery.state === 'unavailable'" role="status">卡密交付记录暂无法核对：{{ delivery.reason }}</p>
    <template v-else-if="delivery.state === 'recorded'">
      <p v-if="delivery.basis === 'php_legacy'" class="virtual-delivery-note" role="note">历史交付记录</p>
      <ol class="virtual-delivery-entries">
        <li v-for="(entry, index) in delivery.entries" :key="index" class="virtual-delivery-entry">
          <strong>{{ entry.product_name }}</strong><span class="virtual-delivery-sku">{{ entry.sku || '默认规格' }} · {{ entry.quantity }} 件</span>
          <dl v-if="entry.kind === 'card'">
            <div><dt>卡号</dt><dd>{{ entry.card_no || '未记录卡号' }}</dd></div>
            <div><dt>密码</dt><dd>{{ entry.card_pwd }}</dd></div>
          </dl>
          <dl v-else><div><dt>交付内容</dt><dd>{{ entry.content }}</dd></div></dl>
        </li>
      </ol>
      <p class="virtual-delivery-note">交付记录供售后核对，请结合本订单的退款记录查看。</p>
    </template>
  </section>
</template>

<style scoped>
.virtual-delivery-review { min-width: 0; margin: 22px 0; }
.virtual-delivery-review h3 { font-size: 15px; margin: 0 0 12px; }
.virtual-delivery-review p { overflow-wrap: anywhere; line-height: 1.7; }
.virtual-delivery-note, .virtual-delivery-sku { color: var(--el-text-color-secondary); font-size: 13px; }
.virtual-delivery-sku { display: block; margin-top: 6px; }
.virtual-delivery-entries { margin: 0; padding-left: 22px; }
.virtual-delivery-entry { padding: 12px 0; overflow-wrap: anywhere; }
.virtual-delivery-entry dl { margin: 12px 0 0; display: grid; gap: 10px; }
.virtual-delivery-entry dl > div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; }
.virtual-delivery-entry dt { color: var(--el-text-color-secondary); }
.virtual-delivery-entry dd { min-width: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 480px) { .virtual-delivery-entry dl > div { grid-template-columns: minmax(0, 1fr); gap: 5px; } }
</style>
