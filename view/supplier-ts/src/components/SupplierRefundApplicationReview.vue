<script setup lang="ts">
import type { SupplierRefundApplicationReview } from '@/utils/refundApplicationReview';
import { reviewMoney } from '@/utils/orderReview';
import { formatTime, payType } from '@/utils/format';
defineProps<{ review?: SupplierRefundApplicationReview }>();
</script>

<template>
  <section class="refund-application-review" aria-label="退款申请商品核对">
    <h3>申请商品核对</h3>
    <el-alert v-if="!review" title="接口尚未返回申请商品核对信息，请刷新详情或更新服务" type="warning" :closable="false" />
    <template v-else>
      <p v-if="review.state === 'archived'" class="source-note">此退款已完成，商品信息请查看下方的“退款商品快照”。</p>
      <el-alert v-else-if="review.state === 'unavailable'" :title="review.error" type="warning" :closable="false" />
      <template v-else>
        <p class="source-note">{{ review.basis === 'php_legacy_snapshot' ? '商品与申请数量来自旧 PHP 保存的申请快照。' : '申请数量来自退款申请；名称、规格及结算价来自仍可核对的订单商品记录。' }}</p>
        <ul class="application-items">
          <li v-for="item in review.items" :key="item.cart_id">
            <strong>{{ item.is_gift === 1 ? '[赠品] ' : '' }}{{ item.product_name }}</strong>
            <dl>
              <div><dt>规格</dt><dd>{{ item.sku || '无规格' }}</dd></div>
              <div><dt>商品编码</dt><dd>{{ item.code || '未记录' }}</dd></div>
              <div><dt>申请数量</dt><dd>{{ item.quantity }}</dd></div>
              <div><dt>结算单价参考</dt><dd>{{ reviewMoney(item.settlement_unit) }}</dd></div>
              <div><dt>申请商品结算小计</dt><dd>{{ reviewMoney(item.settlement_subtotal) }}</dd></div>
            </dl>
          </li>
        </ul>
        <p class="source-note">结算记录供核对商品使用；退款金额以本售后单的申请金额为准，到账状态以退款结果为准。</p>
      </template>
      <template v-if="review.order_context">
        <h4>关联订单记录</h4>
        <p class="source-note">以下收货与支付信息来自关联订单的存储记录。</p>
        <dl class="review-context">
          <div><dt>订单号</dt><dd>{{ review.order_context.order_id }}</dd></div>
          <div><dt>收货人</dt><dd>{{ review.order_context.recipient.name || '未记录' }}</dd></div>
          <div><dt>联系电话</dt><dd>{{ review.order_context.recipient.phone || '未记录' }}</dd></div>
          <div><dt>收货地址</dt><dd>{{ review.order_context.recipient.address || '未记录' }}</dd></div>
          <div><dt>买家留言</dt><dd>{{ review.order_context.mark || '未记录' }}</dd></div>
          <div><dt>{{ review.order_context.paid ? '关联订单已付金额' : '关联订单应付金额' }}</dt><dd>{{ reviewMoney(review.order_context.pay_price) }}</dd></div>
          <div><dt>订单支付方式</dt><dd>{{ payType(review.order_context.pay_type) }}</dd></div>
          <div><dt>订单支付时间</dt><dd>{{ !review.order_context.paid ? '尚未支付' : review.order_context.pay_time ? formatTime(review.order_context.pay_time) : '未记录' }}</dd></div>
        </dl>
      </template>
      <p v-else class="source-note">关联订单的收货与支付记录暂无法核对。</p>
    </template>
  </section>
</template>

<style scoped>
.refund-application-review { margin:20px 0; border-top:1px solid var(--border-soft); min-width:0; }
h3 { margin-bottom:12px; } h4 { margin:16px 0 8px; font-size:14px; }
.source-note { color:var(--text-secondary); font-size:13px; line-height:1.7; }
.application-items { list-style:none; padding:0; display:grid; gap:12px; }
.application-items li { padding:12px; border:1px solid var(--border-soft); border-radius:8px; min-width:0; }
dl { margin:10px 0; display:grid; gap:10px; } dl > div { min-width:0; }
dt { font-size:12px; color:var(--text-secondary); } dd { margin:4px 0 0; }
dd, strong, p { overflow-wrap:anywhere; white-space:pre-wrap; }
@media(min-width:600px) { .review-context, .application-items dl { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
