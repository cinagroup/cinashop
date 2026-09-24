<template>
  <view class="presale-page">
    <view class="heading">预售专区</view>
    <view class="notice">全款预售 · 时间为北京时间。列表价格仅供参考，购买资格以详情与结算校验为准。</view>
    <view class="filters">
      <button v-for="filter in PRESALE_FILTERS" :key="filter.id" :class="{ active: state.type === filter.id }"
        :disabled="navigating" @tap="select(filter.id)">{{ filter.name }}</button>
    </view>
    <button size="mini" :disabled="state.loading || navigating" @tap="load()">刷新列表</button>
    <view v-if="state.error" class="error">{{ state.error }}<button size="mini" :disabled="state.loading || navigating" @tap="load(state.page > 0)">重试加载</button></view>
    <view class="products">
      <view v-for="item in state.list" :key="item.id" class="product" @tap="openProduct(item.id)">
        <image v-if="item.image" :src="item.image" mode="aspectFill" class="product-image" />
        <view class="product-content">
          <view v-if="item.brand" class="brand">{{ item.brand }}</view>
          <view class="name">{{ item.name }}</view>
          <view class="labels"><view v-for="label in item.labels" :key="label.id" class="label"
            :style="{ color: label.color, backgroundColor: label.background, borderColor: label.border }">
            <image v-if="label.icon" :src="label.icon" class="label-icon" />{{ label.name }}</view></view>
          <view class="price">参考价 ¥{{ item.price }}</view>
          <view class="schedule">{{ state.type === 1 ? '开始' : '结束' }}：{{ presaleBeijingTime(state.type === 1 ? item.starts : item.ends) }}</view>
          <view class="schedule">预售结束后 {{ item.shippingDays }} 天内发货</view>
          <view class="detail-link">查看规格与购买规则 ›</view>
        </view>
      </view>
    </view>
    <view v-if="state.loading" class="notice">正在加载预售商品…</view>
    <view v-else-if="!state.error && !state.list.length" class="notice">当前状态暂无预售商品</view>
    <button v-if="state.list.length < state.count && !state.error" :disabled="state.loading || navigating" @tap="load(true)">加载更多</button>
    <view v-else-if="state.list.length && !state.loading && !state.error" class="notice">已加载全部 {{ state.count }} 件商品</view>
  </view>
</template>
<script setup lang="ts">
import { usePresaleCatalog } from '@/composables/usePresaleCatalog';
import { PRESALE_FILTERS, presaleBeijingTime } from '../../../../common/presaleCatalog';
const { state, navigating, openProduct, load, select } = usePresaleCatalog();
</script>
<style scoped>
.presale-page{padding:24rpx;max-width:1100px;margin:auto;color:#252533}.heading{font-size:40rpx;font-weight:700}.notice{color:#656575;font-size:26rpx;line-height:1.6;margin:20rpx 0}.filters{display:flex;gap:12rpx;margin:24rpx 0}.filters button{flex:1;font-size:28rpx;padding:0 8rpx}.filters .active{background:#6946a1;color:white}.products{display:flex;flex-direction:column;gap:20rpx;margin:24rpx 0}.product{display:flex;gap:20rpx;padding:24rpx;border:1px solid #e7e3ed;border-radius:16rpx;background:white;overflow:hidden}.product-image{width:170rpx;height:170rpx;flex-shrink:0}.product-content{min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.brand,.schedule{color:#686473;font-size:24rpx;line-height:1.7}.labels{display:flex;flex-wrap:wrap;gap:8rpx;margin:10rpx 0}.label{font-size:22rpx;padding:2rpx 8rpx;border:1px solid;border-radius:6rpx;max-width:100%;overflow-wrap:anywhere}.label-icon{width:24rpx;height:24rpx;margin-right:4rpx}.price{color:#9b2d52;margin:12rpx 0}.detail-link{color:#6946a1;margin-top:12rpx;font-size:26rpx}.error{color:#a32626;margin:16rpx 0;overflow-wrap:anywhere}
</style>
