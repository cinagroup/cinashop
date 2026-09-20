<template>
  <div class="refund-record container">
    <h2>退款详情</h2>
    <div class="record-actions"><el-button :disabled="busy" @click="load()">重新读取详情</el-button><el-button :disabled="busy" @click="goList">退款记录</el-button></div>
    <el-alert v-if="routeError || state.error || navigationError" :title="routeError || state.error || navigationError" type="warning" :closable="false" />
    <el-alert v-if="state.operationError" :title="state.operationError" type="warning" :closable="false" />
    <p v-if="state.loading" role="status">正在读取退款详情…</p>
    <template v-if="detail">
      <section class="record-card"><h3>{{ refundStatus(detail) }}</h3><p>{{ refundStatusDescription(detail) }}</p></section>
      <section class="record-card">
        <dl><dt>退款单号</dt><dd>#{{ detail.id }} · {{ detail.refundNo }}</dd><dt>订单编号</dt><dd>{{ detail.orderId }}</dd>
          <dt>退款金额</dt><dd>¥{{ detail.refundPrice }}</dd><dt>已退金额</dt><dd>¥{{ detail.refundedPrice }}</dd>
          <dt>申请件数</dt><dd>{{ detail.refundNum }}</dd><dt>申请原因</dt><dd>{{ detail.refundReason }}</dd>
          <dt v-if="detail.refundExplain">补充说明</dt><dd v-if="detail.refundExplain">{{ detail.refundExplain }}</dd>
          <dt>申请时间</dt><dd>{{ refundTime(detail.addTime) }}</dd>
          <dt v-if="detail.refuseReason">拒绝原因</dt><dd v-if="detail.refuseReason">{{ detail.refuseReason }}</dd></dl>
      </section>
      <section class="record-card"><h3>退款商品</h3>
        <el-alert v-if="detail.itemsError" :title="detail.itemsError" type="warning" :closable="false" />
        <div v-for="item in detail.items" :key="item.id" class="record-item"><ProductImage :src="item.image" :alt="item.name" />
          <div><strong>{{ item.name }}</strong><p>{{ item.sku }}</p><p>本次申请数量：{{ item.quantity ?? '旧快照未注明，请核对总件数' }}</p></div></div>
      </section>
      <section v-if="detail.returnContact" class="record-card"><h3>退货收件信息</h3>
        <p>{{ detail.returnContact.name || '收件人未配置' }} · {{ detail.returnContact.phone || '电话未配置' }}</p>
        <p>{{ detail.returnContact.address || '退货地址未配置，请先联系商家' }}</p>
      </section>
      <section v-if="detail.refundExpress" class="record-card"><h3>已提交的退货物流</h3><p>{{ detail.refundExpressName }} · {{ detail.refundExpress }}</p>
        <p v-if="detail.refundPhone">寄件人电话：{{ detail.refundPhone }}</p><p v-if="detail.refundGoodsExplain">{{ detail.refundGoodsExplain }}</p>
        <p v-if="detail.returnImagesError" role="alert">{{ detail.returnImagesError }}</p>
        <div class="evidence"><ProductImage v-for="item in detail.returnImages" :key="item.url" :src="item.src" alt="已提交的退货凭证" /></div></section>
      <section v-if="returnEligible(detail)" class="record-card"><h3>填写退货物流</h3>
        <div v-if="state.shipment.outcome === 'unknown'" role="alert"><p>物流提交结果尚未确认，请勿重复操作。请保留运单，先核对提交结果。</p><el-button :disabled="busy" @click="load()">核对物流提交结果</el-button></div>
        <p>请核对上方收件信息，寄出商品后再提交。重新读取详情会清空未提交内容。</p>
        <p v-if="state.shipment.carriersError" role="alert">{{ state.shipment.carriersError }}；可重新读取详情重试。</p>
        <fieldset :disabled="!canReturn" class="return-form">
          <label>快递公司<select v-model.number="state.shipment.form.carrierId" aria-label="快递公司"><option :value="0">请选择快递公司</option><option v-for="carrier in state.shipment.carriers" :key="carrier.id" :value="carrier.id">{{ carrier.name }}</option></select></label>
          <label>物流单号<input v-model="state.shipment.form.tracking" aria-label="物流单号" maxlength="100" autocomplete="off" /></label>
          <label>寄件人电话（选填）<input v-model="state.shipment.form.phone" aria-label="寄件人电话" maxlength="32" type="tel" autocomplete="off" /></label>
          <label>退货备注（选填）<input v-model="state.shipment.form.explain" aria-label="退货备注" maxlength="255" autocomplete="off" /></label>
          <label>上传凭证（最多3张，每张10 MiB）<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" :disabled="!canReturn || state.shipment.form.images.length >= 3" @change="chooseReturnImage" /></label>
          <div class="evidence"><div v-for="(item, index) in state.shipment.form.images" :key="item.url"><ProductImage :src="item.src" alt="待提交的退货凭证" /><button type="button" @click="removeReturnImage(index)">移除此凭证</button></div></div>
          <label class="ack"><input v-model="state.shipment.form.acknowledged" type="checkbox" />我已按商家收件信息寄出商品</label>
          <button type="button" class="submit-return" :disabled="!canReturn" @click="submitReturn">提交退货物流</button>
        </fieldset>
      </section>
      <p v-if="state.shipment.outcome === 'success'" role="status">退货物流已回读确认，请以上方售后状态为准；物流提交不代表退款到账。</p>
      <div class="record-actions"><el-button :disabled="busy" @click="goOrder">查看原订单</el-button><el-button :disabled="busy" @click="goService">联系客服</el-button>
        <el-button v-if="refundableCancellation(detail)" type="danger" :disabled="!canCancel" :loading="state.operating" @click="cancel">撤销售后</el-button></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { ElMessageBox } from 'element-plus';
import ProductImage from '@/components/ProductImage.vue';
import { returnEligible } from '../../../../common/refundReturn';
import { useRefundRecords } from '@/composables/useRefundRecords';
import { refundStatus, refundStatusDescription, refundTime, refundableCancellation } from '../../../../common/refundRecords';
async function confirmCancel() {
  try { await ElMessageBox.confirm('确认撤销本次退款申请？退款渠道处理中的申请可能无法撤销。', '撤销售后', { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '保留申请' }); return true; }
  catch (error) { if (error === 'cancel' || error === 'close') return false; throw error; }
}
const { state, detail, busy, canCancel, canReturn, uploadReturnImage, submitReturn, removeReturnImage, navigationError, routeError, load, goList, goOrder, goService, cancel } = useRefundRecords('detail', confirmCancel);
function chooseReturnImage(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (file) void uploadReturnImage(file);
}
</script>
<style scoped>
.refund-record { max-width: 1000px; padding-bottom: 32px; }
h2 { margin: 24px 0; } h3 { margin: 0 0 12px; }
.record-actions { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
.record-card { background: white; border: 1px solid #eee; border-radius: 8px; padding: 20px; margin: 16px 0; }
.record-item { display: flex; gap: 16px; margin: 16px 0; } .record-item :deep(.product-media) { width: 80px; height: 80px; flex: 0 0 80px; }
.record-item > div { min-width: 0; }
dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 12px; } dd { margin: 0; } dt { color: #777; }
p, dd, strong { overflow-wrap: anywhere; line-height: 1.6; } p { margin: 8px 0; }
.return-form { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 16px; }
.return-form label { display: grid; gap: 6px; } .return-form input, .return-form select { box-sizing: border-box; min-width: 0; width: 100%; padding: 10px; border: 1px solid #bbb; border-radius: 4px; font: inherit; }
.return-form .ack { display: flex; align-items: center; } .ack input { width: auto; }
.submit-return { padding: 12px; background: #a84916; color: white; border: 0; border-radius: 4px; font: inherit; } .submit-return:disabled { opacity: .5; }
.evidence { display: flex; flex-wrap: wrap; gap: 12px; } .evidence :deep(.product-media) { width: 100px; height: 100px; }
.evidence button { display: block; margin-top: 8px; }
</style>
