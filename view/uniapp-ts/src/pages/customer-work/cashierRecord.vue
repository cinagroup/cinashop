<template>
  <CustomerWorkShell title="次卡收银凭据" :manager="manager" active="cashierRecords">
    <template v-if="detail">
      <view class="cw-card"><text class="cw-subtitle">{{ detail.record.order_no }}</text><text class="cw-status">{{ customerCashierPaymentText(detail.record) }}</text>
        <text class="cw-scope">当前订单金额 ¥{{ detail.record.amount }} · {{ detail.record.quantity }} 件</text>
        <text class="cw-scope">{{ detail.record.buyer_uid === 0 ? '游客购买人' : '购买人 UID ' + detail.record.buyer_uid }} · 创建人 UID {{ detail.record.creator_uid }}</text>
        <text class="cw-scope">{{ detail.record.real_name || '未填写姓名' }} · {{ detail.record.user_phone || '未填写电话' }}</text>
        <text v-if="detail.record.root_retired" class="cw-scope">此处为原购买凭据。原订单已进入后续代次，原购买数量和次数不代表当前可核销余量。</text>
      </view>
      <view class="cw-card"><text class="cw-subtitle">原购买商品</text><view v-for="item in detail.items" :key="item.product_id + ':' + item.sku_unique" class="cw-stack cw-divider">
        <text>{{ item.name }}</text><text class="cw-scope">{{ item.sku }} · 商品 {{ item.product_id }} · 规格 {{ item.sku_unique }}</text>
        <text>{{ item.quantity }} 件 · 原购买次数 {{ item.write_times }}</text>
      </view><text class="cw-scope">以上为创建时保留的购买事实。当前有效期和可用次数须通过实际核销页面重新核对。</text></view>
      <view class="cw-card"><text class="cw-subtitle">已核对创建来源</text><text class="cw-scope">创建时间 {{ customerWorkDate(Math.floor(Date.parse(detail.creation.created_at) / 1000)) }}</text>
        <text class="cw-scope cw-request-key">原创建编号 {{ detail.creation.request_key }}</text>
      </view>
      <view class="cw-card"><text class="cw-subtitle">现金付款凭据</text>
        <template v-if="detail.payment"><text class="cw-scope">已核对原现金付款记录、付款审计和原支付事件。</text><text>实际付款 ¥{{ detail.payment.amount }}{{ detail.payment.payment_kind === 'zero' ? ' · 零金额确认' : '' }}</text>
          <text class="cw-scope">{{ customerWorkDate(detail.payment.paid_at) }}</text><text class="cw-scope cw-request-key">原付款编号 {{ detail.payment.request_key }}</text>
        </template>
        <text v-else class="cw-scope">没有已核对的现金付款凭据。当前订单显示{{ customerCashierPaymentText(detail.record) }}；订单付款状态不替代原现金付款证明。</text>
      </view>
      <view v-if="detail.form" class="cw-card" data-cashier-record-form><text class="cw-subtitle">原购买补充信息</text>
        <SystemFormFields :model-value="detail.form.components" title="已保存的原表单答案" disabled read-only :show-image-references="false" :preview-urls="formPreviews" />
        <text v-if="!detail.form.components.length" class="cw-scope">原系统表单没有需要填写的项目。</text>
        <text v-if="detail.form.previews.length" class="cw-scope">图片预览会过期；刷新只续签原已保存图片。</text>
        <button v-if="detail.form.previews.length" class="cw-full" :disabled="previewBusy" @tap="refreshPreviews">刷新原图片预览</button>
        <text v-if="previewError" class="cw-error">{{ previewError }}</text>
      </view>
      <button class="cw-full" :disabled="detail.record.root_retired" @tap="openOrder">查看实际订单并核对退款</button>
      <text v-if="detail.record.root_retired" class="cw-scope">原付款主单已进入后续代次，请从全站订单读取实际履约子单，再核对当前可退商品与金额。</text>
      <button class="cw-full" @tap="manager.go('cashierRecords')">返回本人收银记录</button>
    </template>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import SystemFormFields from '@/components/SystemFormFields.vue';
import { useCustomerWork } from '@/composables/useCustomerWork';
import { useCustomerCashierRead } from '@/composables/useCustomerCashierRead';
import { isCustomerCashierRecordDetail, customerCashierPaymentText, customerCashierFormPreviewMap, customerCashierFormIdentity } from '@/utils/customerWorkCashierRead';
import { customerWorkDate } from '@/utils/customerWork';
import { RequestError } from '@/utils/request';
import type { CustomerCashierRecordDetail } from '@/types/customerWorkCashierRead';
const orderId = ref(0), orderNo = ref(''), detail = ref<CustomerCashierRecordDetail | null>(null);
const previewBusy = ref(false), previewError = ref('');
const formPreviews = computed(() => detail.value?.form ? customerCashierFormPreviewMap(detail.value.form) : {});
const manager = useCustomerWork({ page: 'cashierRecord', query(query) { orderId.value = Number(query.orderId); orderNo.value = query.orderNo!; },
  clear() { detail.value = null; previewBusy.value = false; previewError.value = ''; reader.clear(); }, async load(controller) {
    const valid = controller.fence(), id = orderId.value, number = orderNo.value;
    const response = await reader.read(`records/${id}`, isCustomerCashierRecordDetail, { order_no: number });
    if (!valid()) return;
    if (response.data.record.id !== id || response.data.record.order_no !== number) throw Error('次卡收银物理订单与原业务编号不匹配');
    detail.value = response.data;
  } });
const reader = useCustomerCashierRead(manager);
function openOrder() {
  const original = detail.value;
  if (!manager.current() || !manager.context.value || !original || original.record.root_retired) return;
  manager.go('orderDetail', { orderId: original.record.order_no });
}
async function refreshPreviews() {
  const original = detail.value;
  if (previewBusy.value || !original?.form || !manager.current()) return;
  const valid = manager.fence(), identity = customerCashierFormIdentity(original.form);
  previewBusy.value = true; previewError.value = '';
  try {
    const response = await reader.read(`records/${original.record.id}`, isCustomerCashierRecordDetail, { order_no: original.record.order_no });
    if (!valid() || detail.value !== original) return;
    const renewed = response.data;
    if (renewed.record.id !== original.record.id || renewed.record.order_no !== original.record.order_no
      || renewed.record.origin_hash !== original.record.origin_hash || !renewed.form || customerCashierFormIdentity(renewed.form) !== identity) {
      const failure = Error('原购买表单或图片来源无法核对，请重新读取凭据'); manager.invalidate(failure); throw failure;
    }
    detail.value = { ...original, form: { ...original.form, previews: renewed.form.previews } };
  } catch (failure) { if (valid()) {
    if (!(failure instanceof RequestError) || failure.httpStatus === 403 || [410000,410001,410002].includes(Number(failure.status))) manager.invalidate(Error('原图片凭据或当前经营资格已变化，请重新读取'));
    else previewError.value = failure.message || '原图片预览续签失败';
  } }
  finally { if (valid()) previewBusy.value = false; }
}
</script>
