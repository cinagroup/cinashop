<template>
  <div class="tracking-page container">
    <h2>{{ kind === 'refund' ? '退货物流' : '发货物流' }}</h2>
    <form class="tracking-search" @submit.prevent="query">
      <label>{{ kind === 'refund' ? '退款记录 ID' : '订单号' }}<el-input v-model="search" :maxlength="96" :placeholder="kind === 'refund' ? '从退款详情进入或输入记录 ID' : '输入订单号'" /></label>
      <el-button type="primary" native-type="submit" :loading="state.loading">{{ result ? '刷新物流' : '查询物流' }}</el-button>
    </form>
    <p v-if="state.loading" role="status">正在查询物流…</p>
    <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="tracking-notice" />
    <template v-if="result && displayResult">
      <el-alert v-if="kind === 'refund'" title="当前查询退货运单。填写运单或承运商签收均不代表退款到账，请以退款记录为准。" :closable="false" class="tracking-notice" />
      <div v-if="result.packages.length > 1" class="tracking-package-picker" role="group" aria-label="选择包裹">
        <button v-for="item in result.packages" :key="item.orderId" type="button" :aria-pressed="selectedPackageId === item.orderId"
          :class="{ active: selectedPackageId === item.orderId }" @click="select(item)">{{ item.expressName || '快递包裹' }} {{ item.expressNo || item.orderId }}</button>
      </div>
      <section class="tracking-card" aria-label="当前物流信息">
        <dl><dt>{{ kind === 'refund' ? '退款单号' : '订单或包裹号' }}</dt><dd>{{ displayResult.orderId }}</dd>
          <dt>物流状态</dt><dd>{{ displayResult.deliveryStatus }}</dd><dt>快递公司</dt><dd>{{ displayResult.expressName || '未记录' }}</dd>
          <dt>运单号</dt><dd>{{ displayResult.expressNo || '未填写' }} <el-button v-if="displayResult.expressNo" size="small" @click="copy">复制运单号</el-button></dd></dl>
        <p v-if="state.copyMessage" role="status">{{ state.copyMessage }}</p><p class="tracking-muted">{{ sourceLabel }} · {{ updatedText }}</p>
      </section>
      <el-alert v-if="displayResult.message" :title="displayResult.message" :closable="false" type="info" class="tracking-notice" />
      <section v-if="displayResult.traces.length" class="tracking-card" aria-label="承运商物流轨迹">
        <h3>承运商物流轨迹</h3><ol class="tracking-traces"><li v-for="(item, index) in visibleTraces" :key="index">
          <strong>{{ item.status }}</strong><p>{{ item.content }}</p><time>{{ item.time || '承运商未注明时间' }}</time></li></ol>
        <el-button v-if="displayResult.traces.length > 1" @click="expand">{{ state.expanded ? '收起物流轨迹' : '查看全部物流轨迹' }}</el-button>
      </section>
      <section v-else-if="!displayResult.message" class="tracking-card tracking-muted">承运商尚未返回物流轨迹</section>
      <template v-if="shipment">
        <section class="tracking-card"><h3>{{ kind === 'refund' ? '原订单收货资料' : '收货资料' }}</h3>
          <p>{{ shipment.recipientName || '收货人未记录' }} · {{ shipment.recipientPhone || '电话未记录' }}</p><p>{{ shipment.recipientAddress || '地址未记录' }}</p></section>
        <section class="tracking-card"><h3>{{ kind === 'refund' ? '商家登记的退件收件信息' : '商家登记信息' }}</h3>
          <p>{{ shipment.merchant.name || '商家名称未配置' }} · {{ shipment.merchant.phone || '电话未配置' }}</p>
          <p>{{ shipment.merchant.address || '地址未配置，请联系商家核对' }}</p><p class="tracking-muted">登记资料不是承运商定位信息。</p></section>
        <section class="tracking-card" aria-label="当前包裹商品"><h3>{{ kind === 'refund' ? '本次退货商品' : '当前包裹商品' }}</h3>
          <el-alert v-if="shipment.itemsError" :title="shipment.itemsError" :closable="false" type="warning" />
          <p v-else-if="!shipment.items.length" class="tracking-muted">暂无商品记录</p>
          <div v-for="item in shipment.items" :key="item.id" class="tracking-goods"><ProductImage :src="item.image" :alt="item.name" />
            <div><strong>{{ item.name }}</strong><p class="tracking-muted">{{ item.sku }}</p>
              <p>{{ item.unitPrice === null ? '历史单价未注明' : '单价 ¥' + item.unitPrice }} · {{ item.quantity === null ? '数量请核对退款详情' : '×' + item.quantity }}</p></div></div>
        </section>
      </template>
    </template>
    <p v-else-if="!state.loading && !state.error" class="tracking-muted">输入订单号查询发货物流，退货物流请从退款详情进入。</p>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ProductImage from '@/components/ProductImage.vue';
import { useBuyerOrderTracking } from '@/composables/useBuyerOrderTracking';
const { state, result, search, kind, selectedPackageId, displayResult, shipment, query, select, copy, expand } = useBuyerOrderTracking();
const visibleTraces = computed(() => state.expanded ? displayResult.value?.traces ?? [] : displayResult.value?.traces.slice(0, 1) ?? []);
const sourceLabel = computed(() => ({ merchant: '商家登记信息', carrier: '承运商查询', cache: '承运商缓存' }[displayResult.value?.trackingSource ?? 'merchant']));
const updatedText = computed(() => displayResult.value?.lastUpdatedAt ? new Date(displayResult.value.lastUpdatedAt * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '暂无承运商查询时间');
</script>
<style scoped>
.tracking-page { max-width:1000px; padding-bottom:32px; overflow-wrap:anywhere; }.tracking-page h2 { font-size:24px; margin:24px 0; }.tracking-page h3 { font-size:17px; margin:0 0 14px; }
.tracking-search { display:flex; align-items:flex-end; flex-wrap:wrap; gap:12px; margin:20px 0; }.tracking-search label { display:grid; gap:8px; width:360px; max-width:100%; }.tracking-card { background:#fff; border:1px solid #edf0f4; padding:24px; border-radius:10px; margin:20px 0; }.tracking-card p { line-height:1.7; margin:8px 0; }
.tracking-card dl { display:grid; grid-template-columns:140px minmax(0,1fr); gap:16px; }.tracking-card dt { color:#697585; }.tracking-card dd { margin:0; line-height:1.6; }.tracking-card dd .el-button { margin-left:12px; }.tracking-muted,.tracking-traces time { color:#697585; font-size:13px; }
.tracking-package-picker { display:flex; flex-wrap:wrap; gap:12px; }.tracking-package-picker button { background:#fff; border:1px solid #ccd3dc; border-radius:6px; padding:12px; font:inherit; cursor:pointer; }.tracking-package-picker button.active { color:var(--view-theme,#1768c8); border-color:currentColor; }
.tracking-notice { margin:16px 0; }.tracking-traces { padding-left:22px; }.tracking-traces li { padding:0 0 20px 10px; }.tracking-goods { display:flex; gap:16px; padding:16px 0; }.tracking-goods :deep(.product-media) { width:90px; flex:0 0 90px; }.tracking-goods > div { min-width:0; flex:1; }
@media(max-width:640px) { .tracking-search { align-items:stretch; }.tracking-card { padding:18px; }.tracking-card dl { grid-template-columns:1fr; gap:8px; }.tracking-card dd { margin-bottom:10px; }.tracking-card dd .el-button { display:block; margin:8px 0 0; } }
</style>
