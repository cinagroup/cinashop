<template>
  <view class="scope-page">
    <view class="heading">券范围商品</view>
    <view v-if="state.loaded" class="summary">{{ state.title }} · {{ scopeLabel }}</view>
    <view class="notice">这里只展示券范围内当前可见的商品。目录价不是会员价或用券后价格；库存、门槛和活动互斥以结算页服务端报价为准。进入详情不会自动使用优惠券。</view>
    <view v-if="state.loaded && !error" class="scope-definition">
      <view class="summary">配置范围总览</view>
      <view class="notice">以下是商家配置的范围，不是当前可购买商品数量。品类/品牌包含下级，商品包含关联子商品；名称不提供直接购买入口。</view>
      <button size="mini" :disabled="state.loading || scopeState.loading" @tap="loadScope(false)">{{ scopeState.loaded ? '刷新配置范围' : '查看配置范围' }}</button>
      <view v-if="scopeState.loading" class="notice">正在读取范围说明…</view>
      <view v-if="scopeState.error" class="error"><view>{{ scopeState.error }}</view><button size="mini" :disabled="scopeState.loading || state.loading" @tap="loadScope(scopeState.nextCursor !== null)">重试范围说明</button></view>
      <template v-if="scopeState.loaded">
        <view v-if="scopeState.scopeType === 0" class="notice">通用范围，无指定配置集合；能否用券仍以结算为准。</view>
        <view v-else class="notice">已读取 {{ scopeState.entries.length }} / {{ scopeState.total }} 个配置项。{{ !scopeState.total ? '未配置范围，不代表全店通用。' : '' }}</view>
        <scroll-view scroll-y class="scope-names"><view v-for="entry in scopeState.entries" :key="entry.id" class="scope-name">
          <text v-for="ancestor in entry.ancestors" :key="ancestor.id">{{ ancestor.name ?? '名称不可见或已移除' }} / </text><text class="summary">{{ entry.name ?? '名称不可见或已移除' }}</text>
          <text v-if="!entry.hierarchyComplete">（层级不完整或配置不一致，请联系商家确认）</text>
        </view></scroll-view>
        <button v-if="scopeState.nextCursor !== null" size="mini" :disabled="scopeState.loading || state.loading" @tap="loadScope(true)">继续读取配置范围</button>
      </template>
    </view>
    <button size="mini" :disabled="state.loading" @tap="load(false)">刷新范围商品</button>
    <view v-if="state.loading" class="notice">正在读取券范围商品…</view>
    <view v-if="error" class="error"><view>{{ error }}</view><button size="mini" :disabled="state.loading" @tap="load(state.nextCursor !== null)">重试加载范围商品</button></view>
    <view class="scope-grid">
      <view v-for="product in state.list" :key="product.id" class="scope-product">
        <image v-if="product.image" :src="product.image" mode="aspectFit" class="product-image" />
        <view class="product-title">{{ product.title }}</view><view class="catalog-price">目录价 ¥{{ product.catalogPrice }}</view>
        <button size="mini" :disabled="blocked" @tap="openProduct(product.id)">查看商品详情</button>
      </view>
    </view>
    <view v-if="!state.loading && !error && state.loaded && !state.list.length" class="notice">{{ state.nextCursor !== null ? '本批未匹配到范围商品，尚未扫描完，请继续加载。' : '当前券范围内暂无可见商品。' }}</view>
    <button v-if="state.nextCursor !== null" :disabled="state.loading" @tap="load(true)">继续加载范围商品</button>
    <view v-else-if="state.loaded && !state.loading && !error && state.list.length" class="notice">已读取全部当前范围商品</view>
  </view>
  <DiySuspendedNavigation />
</template>
<script setup lang="ts">
import { useCouponProducts } from "@/composables/useCouponProducts";
defineOptions({ inheritAttrs: false });
const { state, scopeState, error, blocked, scopeLabel, load, loadScope, openProduct } = useCouponProducts();
</script>
<style scoped>
.scope-page { padding: 24rpx 24rpx calc(32rpx + env(safe-area-inset-bottom)); font-size: 28rpx; overflow-wrap: anywhere; }
.heading { font-size: 36rpx; font-weight: 700; }.summary { margin-top: 18rpx; font-weight: 600; }
.scope-definition { background: white; border-radius: 14rpx; margin: 24rpx 0; padding: 24rpx; line-height: 1.7; }.scope-names { max-height: 400rpx; }.scope-name { margin: 16rpx 0; }
.notice { color: #666; line-height: 1.7; font-size: 24rpx; margin: 24rpx 0; }.error { color: #b72a1d; margin: 20rpx 0; line-height: 1.7; }
.scope-grid { display: flex; flex-wrap: wrap; gap: 20rpx; margin: 24rpx 0; }.scope-product { box-sizing: border-box; flex: 1 1 280rpx; max-width: 680rpx; padding: 24rpx; border-radius: 14rpx; background: white; }
.product-image { width: 100%; height: 230rpx; }.product-title { font-weight: 600; margin: 16rpx 0; }.catalog-price { color: #b72a1d; margin: 16rpx 0; }.scope-product button { margin: 0; }
</style>
