<template>
  <ThemePage>
    <view class="assigned-page">
      <view class="heading"><button @tap="manager.back">返回</button><text class="title">后台分配订单</text><button :disabled="manager.loading.value || manager.busy.value" @tap="manager.refresh">刷新</button></view>
      <view v-if="!manager.auth.isLoggedIn" class="card"><text>请使用原账号登录后核对订单与原请求。</text><button @tap="manager.login">登录</button></view>

      <!-- Recovery stays outside current-store/context admission. A removed
           Manager may still read this user's minimal immutable receipt. -->
      <view v-if="manager.journalError.value" class="warning" data-assigned="journal-error">{{ manager.journalError.value }}。请保留本机记录，不要重复发货。</view>
      <view v-if="manager.pending.value.length" class="warning" data-assigned="pending">
        <text class="strong">原发货结果需核对</text><text>查询原请求后继续。没有查到回执不表示发货失败。</text>
        <view v-for="intent in manager.pending.value" :key="intent.request_key" class="pending">
          <text>订单 {{ intent.input.order_id }} · 履约门店 {{ intent.input.store_id }}</text><text class="muted">请求 {{ intent.request_key }}</text>
          <view class="buttons"><button :disabled="manager.busy.value" @tap="manager.check(intent)">查询原回执</button>
            <button :disabled="manager.busy.value || !manager.canRestore(intent)" @tap="manager.restore(intent)">恢复同一请求</button></view>
          <text v-if="!manager.canRestore(intent)" class="muted">恢复提交需当前门店管理身份；原用户仍可查询回执。</text>
        </view>
      </view>
      <view v-if="manager.notice.value" class="notice" data-assigned="notice">{{ manager.notice.value }}</view>
      <view v-if="manager.error.value" class="warning" data-assigned="error">{{ manager.error.value }}</view>
      <view v-if="manager.receipt.value" class="card" data-assigned="receipt"><text class="strong">原发货记录已确认</text>
        <text>订单 {{ manager.receipt.value.order_id }} · 履约门店 {{ manager.receipt.value.target_store_id }}</text>
        <text class="muted">请求 {{ manager.receipt.value.request_key }}</text><text>订单财务归属仍为平台。此回执确认发货信息已记录，不代表渠道上报已完成。</text></view>

      <view v-if="manager.stores.value.length" class="card">
        <text class="strong">当前履约门店</text><picker :range="manager.stores.value" range-key="name" :value="storeIndex" @change="manager.chooseStore"><view class="selector">{{ manager.storeName.value }} ⌄</view></picker>
        <text class="muted">仅显示后台当前分配给此门店的待办。订单财务归属仍为平台。</text>
      </view>
      <view v-if="manager.loading.value" class="card">正在读取当前门店与分配待办…</view>
      <view v-for="item in manager.items.value" :key="item.order_id" class="card" data-assigned="item">
        <text class="strong">{{ item.order_no }}</text><text>整单 {{ item.total_num }} 件 · 后台第 {{ item.grant.ordinal }} 次批准</text>
        <text class="muted">需先读取并核对最新订单，才能确认本次发货。</text>
        <button :disabled="manager.busy.value || manager.loading.value" @tap="manager.open(item)">核对订单并发货</button>
      </view>
      <view v-if="manager.selectedStore.value && !manager.loading.value && !manager.items.value.length && !manager.error.value" class="card muted">当前门店没有可显示的分配待办。</view>
      <button v-if="manager.nextAfter.value !== null" class="more" :disabled="manager.loading.value || manager.busy.value" @tap="manager.more">读取更多待办</button>

      <view v-if="manager.review.value" class="card review" data-assigned="review">
        <view class="review-head"><text class="strong">核对 {{ manager.review.value.order_no }}</text><button :disabled="manager.busy.value" @tap="manager.closeReview">关闭</button></view>
        <text>履约门店：{{ manager.storeName.value }}</text><text class="muted">订单财务归属：平台</text>
        <view class="recipient"><text>{{ manager.review.value.recipient.name }} · {{ manager.review.value.recipient.phone }}</text><text>{{ manager.review.value.recipient.address }}</text></view>
        <text class="strong">本次整单商品</text><view v-for="cart in manager.review.value.source.cart_rows" :key="cart.row_id" class="goods">
          <text>商品 {{ cart.product_id }} · {{ cart.quantity }} 件</text><text class="muted">规格 {{ cart.unique || '默认规格' }}</text></view>
        <text class="muted">本入口仅支持整单手工快递，请确认实物与订单数量完全一致。</text>
        <text class="strong">快递公司</text><picker :range="manager.review.value.carriers" range-key="name" :value="manager.carrierIndex.value < 0 ? 0 : manager.carrierIndex.value" @change="chooseCarrier"><view class="selector">{{ selectedCarrier || '请选择当前可用快递公司' }} ⌄</view></picker>
        <text class="strong">真实快递单号</text><input v-model="manager.tracking.value" maxlength="64" placeholder="填写本次整单交付的真实单号" />
        <button class="primary" :disabled="!manager.canSubmit.value" @tap="manager.submit">确认整单快递发货</button>
      </view>
    </view>
  </ThemePage>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { useManagerAssignedFulfillment } from '@/composables/useManagerAssignedFulfillment';
const manager = useManagerAssignedFulfillment();
const storeIndex = computed(() => Math.max(0, manager.stores.value.findIndex(s => s.store_id === manager.selectedStore.value)));
const selectedCarrier = computed(() => manager.review.value?.carriers[manager.carrierIndex.value]?.name || '');
function chooseCarrier(event: { detail: { value: string | number } }) { if (!manager.busy.value) manager.carrierIndex.value = Number(event.detail.value); }
</script>
<style scoped>
.assigned-page{max-width:900px;margin:0 auto;padding:24rpx 24rpx 70rpx;background:#f5f7f6;color:#25312e;min-height:100vh;font-size:28rpx;box-sizing:border-box;word-break:break-word}.heading,.review-head,.buttons{display:flex;gap:16rpx;align-items:center;flex-wrap:wrap}.heading{margin:14rpx 0 28rpx}.title{flex:1;font-size:34rpx;font-weight:650}.card,.warning,.notice{display:flex;flex-direction:column;gap:18rpx;padding:26rpx;margin-bottom:24rpx;border-radius:16rpx;border:1rpx solid #dfe8e2;background:#fff}.warning{background:#fff3db;border-color:#edd4a5}.notice{background:#e8f2eb;border-color:#c7dfce}.strong{font-weight:650}.muted{color:#64736c;font-size:25rpx;line-height:1.6}.selector{padding:22rpx;background:#edf3ef;border-radius:12rpx;font-weight:600}.pending,.recipient,.goods{display:flex;flex-direction:column;gap:12rpx;padding:20rpx 0;border-top:1rpx solid #dce4df}.review-head .strong{flex:1}.review{border-color:#8cac96}button{font-size:26rpx;line-height:1.5;padding:16rpx 22rpx;margin:0;border:1rpx solid #cfdbd5;border-radius:12rpx;color:#284e41;background:white}button::after{border:none}button[disabled]{opacity:.5}.primary{background:#28583e;color:white;margin-top:16rpx}.more{width:100%;margin-bottom:24rpx}input{width:100%;height:92rpx;padding:20rpx;box-sizing:border-box;border:1rpx solid #d8e2db;border-radius:10rpx;background:#f6f8f6;font-size:28rpx}@media(max-width:600px){.assigned-page{padding:18rpx}.title{font-size:31rpx}.heading{gap:12rpx}.card,.warning,.notice{padding:23rpx}}
</style>
