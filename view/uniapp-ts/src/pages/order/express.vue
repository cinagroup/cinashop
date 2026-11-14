<template>
  <ThemePage>
    <view class="tracking-page">
      <view class="tracking-toolbar"><text class="tracking-title">{{ kind === 'refund' ? '退货物流' : '发货物流' }}</text>
        <button size="mini" :disabled="state.loading" @tap="load">刷新物流</button>
        <button v-if="!auth.isLoggedIn" size="mini" @tap="login">登录后查看</button></view>
      <view v-if="state.loading" class="tracking-notice" role="status">正在查询物流…</view>
      <view v-if="state.error" class="tracking-error" role="alert">{{ state.error }}</view>
      <template v-if="result && displayResult">
        <view v-if="kind === 'refund'" class="tracking-notice">当前查询退货运单。填写运单或承运商签收均不代表退款到账，请以退款记录为准。</view>
        <scroll-view v-if="result.packages.length > 1" class="tracking-packages" scroll-x>
          <view class="tracking-package-row"><button v-for="item in result.packages" :key="item.orderId" size="mini"
            :class="{ active: selectedPackageId === item.orderId }" :aria-pressed="selectedPackageId === item.orderId" @tap="select(item)">
            {{ item.expressName || '快递包裹' }} {{ item.expressNo || item.orderId }}</button></view>
        </scroll-view>
        <view class="tracking-card" role="region" aria-label="当前物流信息">
          <view class="tracking-row"><text>{{ kind === 'refund' ? '退款单号' : '订单或包裹号' }}</text><text>{{ displayResult.orderId }}</text></view>
          <view class="tracking-row"><text>物流状态</text><text>{{ displayResult.deliveryStatus }}</text></view>
          <view class="tracking-row"><text>快递公司</text><text>{{ displayResult.expressName || '未记录' }}</text></view>
          <view class="tracking-row"><text>运单号</text><text>{{ displayResult.expressNo || '未填写' }}</text></view>
          <button v-if="displayResult.expressNo" size="mini" class="tracking-copy" @tap="copy">复制运单号</button>
          <view v-if="state.copyMessage" class="tracking-feedback" role="status">{{ state.copyMessage }}</view>
          <view class="tracking-source">{{ sourceLabel }} · {{ updatedText }}</view>
        </view>
        <view v-if="displayResult.message" class="tracking-notice">{{ displayResult.message }}</view>
        <view v-if="displayResult.traces.length" class="tracking-card" role="region" aria-label="承运商物流轨迹">
          <text class="tracking-heading">承运商物流轨迹</text>
          <view v-for="(item, index) in visibleTraces" :key="index" class="tracking-trace">
            <view class="tracking-dot" /><view><text class="tracking-trace-state">{{ item.status }}</text>
              <view>{{ item.content }}</view><text class="tracking-time">{{ item.time || '承运商未注明时间' }}</text></view>
          </view>
          <button v-if="displayResult.traces.length > 1" size="mini" @tap="expand">{{ state.expanded ? '收起物流轨迹' : '查看全部物流轨迹' }}</button>
        </view>
        <view v-else-if="!displayResult.message" class="tracking-card tracking-empty">承运商尚未返回物流轨迹</view>
        <template v-if="shipment">
          <view class="tracking-card"><text class="tracking-heading">{{ kind === 'refund' ? '原订单收货资料' : '收货资料' }}</text>
            <view>{{ shipment.recipientName || '收货人未记录' }} · {{ shipment.recipientPhone || '电话未记录' }}</view>
            <view>{{ shipment.recipientAddress || '地址未记录' }}</view></view>
          <view class="tracking-card"><text class="tracking-heading">{{ kind === 'refund' ? '商家登记的退件收件信息' : '商家登记信息' }}</text>
            <view>{{ shipment.merchant.name || '商家名称未配置' }} · {{ shipment.merchant.phone || '电话未配置' }}</view>
            <view>{{ shipment.merchant.address || '地址未配置，请联系商家核对' }}</view>
            <view class="tracking-source">登记资料不是承运商定位信息。</view></view>
          <view class="tracking-card" role="region" aria-label="当前包裹商品">
            <text class="tracking-heading">{{ kind === 'refund' ? '本次退货商品' : '当前包裹商品' }}</text>
            <view v-if="shipment.itemsError" class="tracking-notice">{{ shipment.itemsError }}</view>
            <view v-else-if="!shipment.items.length" class="tracking-empty">暂无商品记录</view>
            <view v-for="item in shipment.items" :key="item.id" class="tracking-goods">
              <image v-if="item.image && !failedImages.includes(item.id)" :src="item.image" :alt="item.name" mode="aspectFill" @error="imageFailed(item)" />
              <view v-else class="tracking-photo-empty">{{ item.image ? '图片读取失败' : '暂无图片' }}</view>
              <view class="tracking-goods-text"><view>{{ item.name }}</view><text class="tracking-source">{{ item.sku }}</text>
                <view>{{ item.unitPrice === null ? '历史单价未注明' : '单价 ¥' + item.unitPrice }} · {{ item.quantity === null ? '数量请核对退款详情' : '×' + item.quantity }}</view></view>
            </view>
          </view>
        </template>
      </template>
      <view v-else-if="!state.loading && !state.error" class="tracking-notice">请从订单或退款详情进入物流查询。</view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { computed, ref, watch } from 'vue';
import { useBuyerOrderTracking } from '@/composables/useBuyerOrderTracking';
import type { BuyerTrackingItem } from '../../../../common/buyerOrderTracking';
defineOptions({ inheritAttrs: false });
const { auth, state, result, kind, selectedPackageId, displayResult, shipment, load, login, select, copy, expand } = useBuyerOrderTracking();
const visibleTraces = computed(() => state.expanded ? displayResult.value?.traces ?? [] : displayResult.value?.traces.slice(0, 1) ?? []);
const sourceLabel = computed(() => ({ merchant: '商家登记信息', carrier: '承运商查询', cache: '承运商缓存' }[displayResult.value?.trackingSource ?? 'merchant']));
const updatedText = computed(() => displayResult.value?.lastUpdatedAt ? new Date(displayResult.value.lastUpdatedAt * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '暂无承运商查询时间');
const failedImages = ref<number[]>([]);
watch(shipment, () => { failedImages.value = []; }, { flush: 'sync' });
function imageFailed(item: BuyerTrackingItem) { if (shipment.value?.items.includes(item) && !failedImages.value.includes(item.id)) failedImages.value.push(item.id); }
</script>
<style scoped>
.tracking-page { padding:20rpx; font-size:26rpx; line-height:1.65; overflow-wrap:anywhere; }
.tracking-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:16rpx; margin-bottom:20rpx; }.tracking-toolbar button { margin:0; }.tracking-title { font-size:34rpx; font-weight:650; flex:1; }
.tracking-card { background:#fff; padding:24rpx; border-radius:16rpx; margin:20rpx 0; box-sizing:border-box; }.tracking-heading { display:block; font-size:29rpx; font-weight:600; margin-bottom:18rpx; }
.tracking-row { display:flex; justify-content:space-between; gap:20rpx; padding:12rpx 0; border-bottom:1rpx solid #edf0f4; }.tracking-row text:first-child { color:#687382; flex:0 0 160rpx; }.tracking-row text:last-child { min-width:0; text-align:right; }
.tracking-copy { display:block; margin:20rpx 0 12rpx auto; color:var(--view-theme,#1768c8); }.tracking-source,.tracking-time { color:#697585; font-size:23rpx; }.tracking-notice { background:#fff4e5; color:#744500; padding:22rpx; border-radius:12rpx; margin:16rpx 0; }.tracking-error { background:#fff0f0; color:#a72d2d; padding:22rpx; border-radius:12rpx; }
.tracking-feedback { color:#26723d; }.tracking-empty { color:#687382; }.tracking-package-row { display:inline-flex; gap:16rpx; padding:8rpx 0; }.tracking-package-row button { margin:0; white-space:nowrap; }.tracking-package-row button.active { color:var(--view-theme,#1768c8); border:1rpx solid currentColor; }
.tracking-trace { display:flex; align-items:baseline; gap:20rpx; padding:16rpx 0; }.tracking-dot { width:12rpx; height:12rpx; flex:0 0 12rpx; border-radius:50%; background:var(--view-theme,#1768c8); }.tracking-trace-state { font-weight:600; }.tracking-trace > view:last-child { min-width:0; }
.tracking-goods { display:flex; gap:18rpx; margin:20rpx 0; }.tracking-goods image,.tracking-photo-empty { width:112rpx; height:112rpx; flex:0 0 112rpx; border-radius:8rpx; }.tracking-photo-empty { display:flex; align-items:center; justify-content:center; color:#687382; background:#f3f5f7; font-size:21rpx; text-align:center; }.tracking-goods-text { min-width:0; flex:1; }
</style>
