<script setup lang="ts">
import type { SupplierOrderReview } from '@/utils/orderReview';
import { reviewMoney } from '@/utils/orderReview';
defineProps<{ review: SupplierOrderReview; paid: number }>();
</script>

<template>
  <section class="order-review" aria-label="订单核对">
    <p v-if="review.order_kind === 'payment_summary'" class="review-note" role="note">这是拆分前的付款汇总，请按各实际包裹履约，金额勿与子订单重复相加。</p>
    <p v-if="review.original_order_id" class="original-number">原订单号：{{ review.original_order_id }}</p>
    <h3>收货与买家要求</h3>
    <dl class="review-facts">
      <div><dt>收货人</dt><dd>{{ review.recipient.name || '未记录' }} {{ review.recipient.phone }}</dd></div>
      <div><dt>下单收货地址</dt><dd>{{ review.recipient.address || '未记录收货地址' }}</dd></div>
      <div><dt>买家留言</dt><dd>{{ review.recipient.mark || '无留言' }}</dd></div>
    </dl>
    <h3>当前买家资料</h3>
    <dl v-if="review.buyer.available" class="review-facts">
      <div><dt>用户 UID</dt><dd>{{ review.buyer.uid }}</dd></div>
      <div><dt>当前昵称</dt><dd>{{ review.buyer.nickname || '未设置' }}</dd></div>
      <div><dt>当前绑定电话</dt><dd>{{ review.buyer.phone || '未绑定' }}</dd></div>
    </dl>
    <p v-else class="review-note">{{ review.buyer.uid === 0 ? '游客订单，无当前注册买家资料' : `买家 UID ${review.buyer.uid} 的当前资料不可用` }}</p>
    <p class="review-note">当前资料可能已更改；收货与商品信息以本订单记录为准。</p>
    <h3>下单商品明细</h3>
    <div v-if="review.items.length" class="review-items-scroll" tabindex="0" role="region" aria-label="商品明细，可横向滚动">
      <table class="review-items" aria-label="下单商品结算明细">
        <thead><tr><th>商品 / 规格</th><th>编码 / 条码</th><th>数量 / 已退</th><th>结算单价参考</th><th>结算小计参考</th></tr></thead>
        <tbody><tr v-for="item in review.items" :key="item.id">
          <td><strong>{{ item.product_name }}</strong><span>{{ item.sku || '默认规格' }}</span></td>
          <td><span>{{ item.code || '未记录编码' }}</span><span>{{ item.bar_code || '未记录条码' }}</span></td>
          <td>{{ item.quantity }} / {{ item.refund_quantity }}</td>
          <td>{{ reviewMoney(item.settlement_unit) }}</td><td>{{ reviewMoney(item.settlement_subtotal) }}</td>
        </tr></tbody>
      </table>
    </div>
    <p v-else class="review-note">未记录商品明细</p>
    <h3>结算记录参考</h3>
    <dl class="review-facts review-amounts">
      <div><dt>商品结算参考合计</dt><dd>{{ reviewMoney(review.settlement.items_total) }}</dd></div>
      <div><dt>纳入参考的运费</dt><dd>{{ reviewMoney(review.settlement.postage) }}</dd></div>
      <div><dt>结算记录参考合计</dt><dd>{{ reviewMoney(review.settlement.total) }}</dd></div>
    </dl>
    <p class="review-note">结算记录参考不代表已到账，退款及实际结算以资金账本为准。{{ review.settlement.availability === 'incomplete' ? '部分历史记录缺少可确认的结算价，合计暂不提供。' : '' }}</p>
    <h3>客户付款与优惠</h3>
    <dl class="review-facts review-amounts">
      <div><dt>订单商品件数</dt><dd>{{ review.amounts.quantity }}</dd></div>
      <div><dt>商品总额</dt><dd>{{ reviewMoney(review.amounts.total_price) }}</dd></div>
      <div><dt>原运费</dt><dd>{{ reviewMoney(review.amounts.total_postage) }}</dd></div>
      <div><dt>应付运费</dt><dd>{{ reviewMoney(review.amounts.pay_postage) }}</dd></div>
      <div><dt>优惠券优惠</dt><dd>{{ reviewMoney(review.amounts.coupon_price) }}</dd></div>
      <div><dt>积分抵扣</dt><dd>{{ reviewMoney(review.amounts.deduction_price) }} · {{ review.amounts.use_integral }} 积分</dd></div>
      <div><dt>促销优惠</dt><dd>{{ reviewMoney(review.amounts.promotions_price) }}</dd></div>
      <div><dt>首单优惠</dt><dd>{{ reviewMoney(review.amounts.first_order_price) }}</dd></div>
      <div><dt>订单改价记录</dt><dd>{{ reviewMoney(review.amounts.change_price) }}</dd></div>
      <div><dt>{{ paid === 1 ? '客户已付金额' : '客户应付金额' }}</dt><dd>{{ reviewMoney(review.amounts.pay_price) }}</dd></div>
      <div><dt>累计退款记录</dt><dd>{{ reviewMoney(review.amounts.refund_price) }}</dd></div>
    </dl>
    <section v-if="review.form.length" class="review-form" aria-label="下单补充信息">
      <h3>下单补充信息</h3>
      <dl class="review-facts"><div v-for="(field, index) in review.form" :key="`${field.id}-${index}`">
        <dt>{{ field.title }}</dt><dd>
          <div v-if="field.images.length" class="review-form-images">
            <el-image v-for="(image, imageIndex) in field.images" :key="image" :src="image" :preview-src-list="field.images" :initial-index="imageIndex" fit="cover" preview-teleported :alt="`${field.title} 图片 ${imageIndex + 1}`" />
          </div>
          <span v-else>{{ field.value || '未填写' }}</span>
        </dd>
      </div></dl>
    </section>
  </section>
</template>

<style scoped>
.order-review { min-width: 0; margin: 20px 0; }
.order-review h3 { margin: 22px 0 12px; font-size: 15px; }
.review-facts { margin: 0; display: grid; gap: 12px; }
.review-facts > div { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 12px; }
.review-facts dt { color: var(--el-text-color-secondary); }
.review-facts dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.review-note { color: var(--el-text-color-secondary); line-height: 1.7; font-size: 13px; overflow-wrap: anywhere; }
.original-number { overflow-wrap: anywhere; }
.review-items-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
.review-items { width: 100%; min-width: 620px; border-collapse: collapse; text-align: left; font-size: 13px; }
.review-items th, .review-items td { padding: 12px; vertical-align: top; border-bottom: 1px solid var(--el-border-color-lighter); }
.review-items th { color: var(--el-text-color-secondary); font-weight: 500; }
.review-items td:first-child { min-width: 150px; max-width: 260px; overflow-wrap: anywhere; }
.review-items td:nth-child(2) { max-width: 140px; overflow-wrap: anywhere; }
.review-items td span { display: block; margin-top: 5px; }
.review-items td:nth-child(n+3) { white-space: nowrap; }
.review-form-images { display: flex; gap: 8px; flex-wrap: wrap; }
.review-form-images :deep(.el-image) { width: 78px; height: 78px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
@media (max-width: 480px) { .review-facts > div { grid-template-columns: minmax(0, 1fr); gap: 5px; } }
</style>
