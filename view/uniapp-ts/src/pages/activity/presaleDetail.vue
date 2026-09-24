<template>
  <view class="presale-detail">
    <view v-if="loading" class="notice" role="status">正在加载预售规格与购买规则…</view>
    <view v-if="error" class="error" role="alert">{{ error }}</view>
    <button v-if="!prepared" size="mini" :disabled="loading || locked" @tap="load">刷新预售商品</button>
    <view v-if="detail" class="product">
      <image v-if="selectedSku?.image || detail.image" class="goods-img" :src="selectedSku?.image || detail.image" mode="aspectFit" />
      <view class="info-section">
        <view class="goods-name">{{ detail.title }}</view>
        <view class="notice">{{ detail.subtitle }}</view>
        <view class="notice" role="status">{{ open ? '预售进行中' : detail.schedule.state === 'future' ? '预售尚未开始，请开始后刷新' : '当前不可预订，请刷新确认规则与时间' }}</view>
        <view class="notice">北京时间：{{ formatDate(detail.schedule.start_time) }} 至 {{ formatDate(detail.schedule.stop_time) }}</view>
        <view class="notice">预售结束后 {{ detail.schedule.shipping_days_after_end }} 天内发货；发货、自提及自动交付均须等待预售结束。</view>
        <view v-if="detail.purchase_limits.mode === 'per_order'" class="notice">每单限购 {{ detail.purchase_limits.quantity }} 件</view>
        <view v-else-if="detail.purchase_limits.mode === 'cumulative'" class="error">累计限购预售暂未开放，当前不可结算。</view>
        <view class="section-title">选择商品规格</view>
        <button v-for="sku in detail.skus" :key="sku.unique" class="sku" :class="{ selected: selected === sku.unique }"
          :aria-pressed="selected === sku.unique" :disabled="locked || loading || sku.max_quantity < 1" @tap="choose(sku.unique)">
          {{ sku.suk || '默认规格' }} · ¥{{ sku.catalog_price }}{{ sku.stock < 1 ? ' · 已售罄' : sku.max_quantity < 1 ? ' · 暂不可购买' : '' }}
        </button>
        <view v-if="!detail.skus.length" class="notice">暂无可购买规格</view>
        <view v-if="selectedSku" class="price">商品参考价 ¥{{ selectedSku.catalog_price }}</view>
        <view v-if="selectedSku" class="notice">库存 {{ selectedSku.stock }} {{ detail.unit_name }} · 当前最多可选 {{ selectedSku.max_quantity }} {{ detail.unit_name }}</view>
        <view class="quantity-row">
          <text>购买数量</text>
          <input :value="quantity" type="number" :disabled="locked || loading" @input="setQuantity" aria-label="购买数量" />
        </view>
        <view class="notice">一次支付全款，无定金或尾款。会员价、积分抵扣、运费和最终应付以结算页报价为准；选择规格不预留库存。</view>
        <view v-if="prepared" class="notice" role="status">购买记录已创建，继续结算不会重复加购。</view>
      </view>
    </view>
    <view class="action-bar"><button class="buy-btn" :disabled="!canBuy" :loading="buying || navigating" @tap="purchase">{{ prepared ? '继续结算' : '立即预订' }}</button></view>
  </view>
</template>

<script setup lang="ts">
import { usePresalePurchase } from '@/composables/usePresalePurchase';
const { detail, selected, quantity, selectedSku, loading, buying, navigating, error, open, locked, canBuy, prepared,
  choose, load, purchase } = usePresalePurchase();
function setQuantity(event: unknown) {
  if (locked.value || loading.value) return;
  const payload = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  const value = payload.detail?.value ?? payload.target?.value, raw = typeof value === 'string' ? value : '';
  quantity.value = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : raw;
}
// Fixed UTC+8, including runtimes without Intl timezone support.
function formatDate(seconds: number) {
  return new Date(seconds * 1000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
</script>

<style scoped>
.presale-detail { padding: 24rpx 24rpx calc(150rpx + env(safe-area-inset-bottom)); }
.product { margin-top: 24rpx; background: white; border-radius: 16rpx; overflow: hidden; }
.goods-img { width: 100%; height: 440rpx; background: #f5f5f5; }
.info-section { padding: 24rpx; }
.goods-name { font-size: 34rpx; font-weight: 600; overflow-wrap: anywhere; }
.notice { margin: 18rpx 0; font-size: 25rpx; color: #666; line-height: 1.6; overflow-wrap: anywhere; }
.error { padding: 20rpx; color: #a72823; background: #fff0ed; margin-bottom: 20rpx; }
.section-title { margin-top: 24rpx; font-size: 28rpx; }
.sku { margin-top: 16rpx; font-size: 26rpx; white-space: normal; overflow-wrap: anywhere; }
.selected { color: #ad261d; border: 2rpx solid #e93323; }
.price { color: #b72a1d; margin: 24rpx 0; font-size: 34rpx; }
.quantity-row { display: flex; gap: 20rpx; align-items: center; font-size: 28rpx; }
.quantity-row input { width: 140rpx; padding: 12rpx; border: 1rpx solid #aaa; }
.action-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: white; box-shadow: 0 -2rpx 10rpx #0001; }
.buy-btn { background: #e93323; color: white; font-size: 30rpx; }
.buy-btn[disabled] { background: #eee; color: #777; }
</style>
