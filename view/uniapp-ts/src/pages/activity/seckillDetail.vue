<template>
  <view class="seckill-detail">
    <view v-if="loading" class="notice">正在加载活动规格…</view>
    <view v-if="error" class="error">{{ error }}</view>
    <button v-if="!prepared" size="mini" :disabled="loading || locked" @tap="load">刷新活动与规格</button>
    <view v-if="detail" class="product">
      <image class="goods-img" :src="selectedSku?.image || detail.image || placeholder" mode="aspectFit" />
      <view class="info-section">
        <view class="goods-name">{{ detail.title }}</view>
        <view class="notice">{{ open ? detail.schedule.message : detail.schedule.state === 'active' ? '当前场次已变化，请刷新活动' : detail.schedule.message }}</view>
        <view class="notice">北京时间 · 每单限购 {{ detail.once_limit }} 件 · 累计限购 {{ detail.total_limit }} 件</view>
        <view class="section-title">选择活动规格</view>
        <button v-for="sku in detail.skus" :key="sku.unique" class="sku" :class="{ selected: selected === sku.unique }"
          :disabled="locked || loading || sku.max_quantity < 1" @tap="choose(sku.unique)">
          {{ sku.suk || '默认规格' }} · ¥{{ sku.catalog_price }}{{ sku.max_quantity < 1 ? ' · 已售罄' : '' }}
        </button>
        <view v-if="!detail.skus.length" class="notice">暂无可购买规格</view>
        <view v-if="selectedSku" class="price">活动参考价 ¥{{ selectedSku.catalog_price }}</view>
        <view class="quantity-row">
          <text>购买数量</text>
          <input :value="quantity" type="number" :disabled="locked || loading" @input="setQuantity" aria-label="购买数量" />
        </view>
        <view class="notice">库存和限购余量尚未预留，最终金额及购买资格由服务端重新校验。</view>
      </view>
    </view>
    <view class="action-bar"><button class="buy-btn" :disabled="!canBuy" :loading="buying || navigating" @tap="purchase">{{ prepared ? '继续结算' : '立即抢购' }}</button></view>
  </view>
</template>

<script setup lang="ts">
import { useSeckillPurchase } from '@/composables/useSeckillPurchase';
const { detail, selected, quantity, selectedSku, loading, buying, navigating, error, open, locked, canBuy, prepared, choose, load, purchase } = useSeckillPurchase();
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
function setQuantity(event: unknown) {
  const payload = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  const value = payload.detail?.value ?? payload.target?.value;
  const raw = typeof value === 'string' ? value : '';
  quantity.value = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : raw;
}
</script>

<style scoped>
.seckill-detail { padding: 24rpx 24rpx calc(150rpx + env(safe-area-inset-bottom)); }
.product { margin-top: 24rpx; background: white; border-radius: 16rpx; overflow: hidden; }
.goods-img { width: 100%; height: 520rpx; background: #f5f5f5; }
.info-section { padding: 24rpx; }
.goods-name { font-size: 34rpx; font-weight: 600; overflow-wrap: anywhere; }
.notice { margin: 18rpx 0; font-size: 25rpx; color: #666; line-height: 1.6; }
.error { padding: 20rpx; color: #a72823; background: #fff0ed; margin-bottom: 20rpx; }
.section-title { margin-top: 24rpx; font-size: 28rpx; }
.sku { margin-top: 16rpx; font-size: 26rpx; }
.sku.selected { color: #ad261d; border: 2rpx solid #e93323; }
.price { color: #b72a1d; margin: 24rpx 0; font-size: 34rpx; }
.quantity-row { display: flex; gap: 20rpx; align-items: center; font-size: 28rpx; }
.quantity-row input { width: 140rpx; padding: 12rpx; border: 1rpx solid #aaa; }
.action-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: white; box-shadow: 0 -2rpx 10rpx #0001; }
.buy-btn { background: #e93323; color: white; font-size: 30rpx; }
.buy-btn[disabled] { background: #eee; color: #777; }
</style>
