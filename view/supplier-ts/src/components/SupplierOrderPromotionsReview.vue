<script setup lang="ts">
import type { SupplierOrderPromotionsReview } from '@/utils/orderPromotionsReview';
import { reviewMoney } from '@/utils/orderReview';
defineProps<{ promotions?: SupplierOrderPromotionsReview; paymentSummary: boolean }>();
</script>

<template>
  <section class="promotions-review" aria-label="促销分摊记录参考">
    <h3>促销分摊记录参考</h3>
    <p v-if="!promotions" role="status">促销分摊信息未返回，请重新读取详情。</p>
    <p v-else-if="promotions.state === 'none'" role="status">本订单未记录促销分摊。</p>
    <p v-else-if="promotions.state === 'unavailable'" role="status">促销分摊暂无法核对：{{ promotions.reason }}</p>
    <template v-else>
      <p v-if="paymentSummary" class="promotions-note" role="note">这是付款汇总的历史促销分摊，勿与各子订单重复相加。</p>
      <p class="promotions-note">{{ promotions.basis === 'modern' ? '分摊金额已与下单快照及订单促销账本核对。' : '历史订单账本参考，缺少可核对的现代分摊快照。' }}</p>
      <ol class="promotions-items">
        <li v-for="item in promotions.items" :key="item.promotion_id">
          <strong>活动 #{{ item.promotion_id }}</strong>
          <dl class="promotions-facts">
            <div v-if="item.frozen_name !== null"><dt>下单快照中的活动名称</dt><dd>{{ item.frozen_name || '未填写' }}</dd></div>
            <div><dt>当前活动标题</dt><dd>{{ item.current_title === null ? '当前活动标题不可用' : item.current_title || '当前活动标题未填写' }}</dd></div>
            <div><dt>本单分摊记录</dt><dd>{{ reviewMoney(item.amount) }}</dd></div>
          </dl>
        </li>
      </ol>
      <dl class="promotions-facts promotions-total"><div><dt>本单促销分摊合计</dt><dd>{{ reviewMoney(promotions.total) }}</dd></div></dl>
      <p class="promotions-note">当前标题可能与下单时不同，仅供辨认，不用于重新计算优惠。分摊记录不代表当前活动资格、赠品交付或资金到账。</p>
    </template>
  </section>
</template>

<style scoped>
.promotions-review { min-width: 0; margin: 22px 0; }
.promotions-review h3 { font-size: 15px; margin: 0 0 12px; }
.promotions-review p { overflow-wrap: anywhere; line-height: 1.7; }
.promotions-note { color: var(--el-text-color-secondary); font-size: 13px; }
.promotions-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.promotions-items li { min-width: 0; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; }
.promotions-items strong { display: block; margin-bottom: 12px; }
.promotions-facts { margin: 0; display: grid; gap: 12px; }
.promotions-facts > div { display: grid; grid-template-columns: 154px minmax(0, 1fr); gap: 12px; }
.promotions-facts dt { color: var(--el-text-color-secondary); }
.promotions-facts dd { min-width: 0; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.promotions-total { margin-top: 16px; }
@media (max-width: 480px) { .promotions-facts > div { grid-template-columns: minmax(0, 1fr); gap: 5px; } }
</style>
