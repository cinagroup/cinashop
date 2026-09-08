<template>
  <view class="combination-detail">
    <view v-if="loading" class="notice">正在加载活动规格与参团资格…</view>
    <view v-if="error" class="error">{{ error }}</view>
    <button v-if="!prepared" size="mini" :disabled="loading || locked" @tap="load">刷新活动与拼团</button>
    <button v-if="!detail && !loading && error && selectedGroup" size="mini" :disabled="locked" @tap="discardGroup">放弃指定团并重新选择</button>
    <view v-if="detail" class="product">
      <image class="goods-img" :src="selectedSku?.image || detail.image || placeholder" mode="aspectFit" />
      <view class="info-section">
        <view class="goods-name">{{ detail.title }}</view>
        <view class="notice">{{ open ? '拼团活动进行中' : '活动未开始或已结束，请刷新确认' }}</view>
        <view class="notice">{{ detail.people }} 人成团 · 每单限购 {{ detail.once_limit }} 件 · 累计限购 {{ detail.total_limit }} 件</view>
        <view class="notice">北京时间：{{ formatDate(detail.start_time) }} 至 {{ formatDate(detail.stop_time) }}</view>
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
        <view class="section-title">开团或参加指定团</view>
        <button class="group" :class="{ selected: selectedGroup === 0 }" :disabled="locked || loading" @tap="chooseGroup(0)">发起新团</button>
        <button v-for="group in groups" :key="group.id" class="group" :class="{ selected: selectedGroup === group.id }"
          :disabled="locked || loading || !groupAvailable(group)" @tap="chooseGroup(group.id)">
          <text>参加团 #{{ group.id }}</text>
          <text>已参与 {{ group.active_people }} / {{ group.required_people }} 人 · 待支付预占 {{ group.reserved_people }} 人</text>
          <text>{{ group.already_joined ? '您已参加该团' : group.has_pending_order ? '您有该团待支付订单' : groupAvailable(group) ? '可用席位 ' + group.available_places : '该团已不可参加' }}</text>
          <text>截止：{{ formatDate(group.stop_time) }}</text>
        </button>
        <view v-if="!groups.length" class="notice">暂无可展示的进行中拼团</view>
        <view v-if="selectedGroup && !selectedGroupAvailable" class="error">原指定团已不可参加；不会自动改为开团，请明确重新选择。</view>
        <view class="notice">每笔订单占 1 个团员席位，与购买件数不同。目录不预留库存或席位，支付后才参与拼团；价格和资格由服务端重新校验。</view>
      </view>
    </view>
    <view class="action-bar"><button class="buy-btn" :disabled="!canBuy" :loading="buying || navigating" @tap="purchase">{{ prepared ? '继续结算' : selectedGroup ? '参加所选团' : '立即开团' }}</button></view>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import { useCombinationPurchase } from '@/composables/useCombinationPurchase';
const { detail, selected, quantity, selectedSku, loading, buying, navigating, error, open, locked, canBuy, prepared,
  selectedGroup, groups, selectedGroupAvailable, groupAvailable, choose, chooseGroup, discardGroup, load, purchase } = useCombinationPurchase();
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
function setQuantity(event: unknown) {
  const payload = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  const value = payload.detail?.value ?? payload.target?.value;
  const raw = typeof value === 'string' ? value : '';
  quantity.value = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : raw;
}
// Fixed UTC+8 formatting also works in native targets without Intl timezone support.
function formatDate(value: string | null) {
  if (!value) return '不限';
  return new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}
</script>

<style scoped>
.combination-detail { padding: 24rpx 24rpx calc(150rpx + env(safe-area-inset-bottom)); }
.product { margin-top: 24rpx; background: white; border-radius: 16rpx; overflow: hidden; }
.goods-img { width: 100%; height: 520rpx; background: #f5f5f5; }
.info-section { padding: 24rpx; }
.goods-name { font-size: 34rpx; font-weight: 600; overflow-wrap: anywhere; }
.notice { margin: 18rpx 0; font-size: 25rpx; color: #666; line-height: 1.6; }
.error { padding: 20rpx; color: #a72823; background: #fff0ed; margin-bottom: 20rpx; }
.section-title { margin-top: 24rpx; font-size: 28rpx; }
.sku, .group { margin-top: 16rpx; font-size: 26rpx; }
.group { padding: 20rpx; text-align: left; line-height: 1.8; }
.group text { display: block; }
.selected { color: #ad261d; border: 2rpx solid #e93323; }
.price { color: #b72a1d; margin: 24rpx 0; font-size: 34rpx; }
.quantity-row { display: flex; gap: 20rpx; align-items: center; font-size: 28rpx; }
.quantity-row input { width: 140rpx; padding: 12rpx; border: 1rpx solid #aaa; }
.action-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: white; box-shadow: 0 -2rpx 10rpx #0001; }
.buy-btn { background: #e93323; color: white; font-size: 30rpx; }
.buy-btn[disabled] { background: #eee; color: #777; }
</style>
