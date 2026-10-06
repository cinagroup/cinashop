<template>
  <view class="product-card" :class="layout" @tap="$emit('detail')">
    <image v-if="product.image" class="product-image" :src="product.image" mode="aspectFill" />
    <view v-else class="product-image missing-image">暂无图片</view>
    <view class="product-info"><view class="product-title"><text v-if="product.brand_name" class="brand">{{ product.brand_name }}</text>{{ product.store_name }}</view>
      <view class="product-price">¥{{ product.price }}</view><view v-if="product.is_vip && product.vip_price && product.vip_price !== '0.00'" class="vip">SVIP专享 ¥{{ product.vip_price }}</view><view class="sales">已售 {{ product.sales }}</view>
      <view class="card-actions" @tap.stop>
        <template v-if="product.cart_button === 0"><button size="mini" :disabled="disabled" @tap="$emit('buy')">立即购买</button></template>
        <template v-else-if="layout !== 'grid' && product.spec_type === 0 && quantity > 0"><button size="mini" :disabled="disabled" @tap="$emit('step', -1)">−</button><input :key="quantity" :value="quantity" type="number" :disabled="disabled" aria-label="购物车数量" @blur="inputQuantity" /><button size="mini" :disabled="disabled || quantity >= product.stock" @tap="$emit('step', 1)">＋</button></template>
        <template v-else><button size="mini" :disabled="disabled || product.stock < 1" @tap="$emit('add')">{{ product.stock < 1 ? '已售罄' : product.spec_type ? '选规格' : '加入购物车' }}</button><button v-if="layout === 'grid'" size="mini" :disabled="disabled" @tap="$emit('buy')">购买</button></template>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import type { CategoryProduct } from '../../../../common/categoryCatalog';
const props = defineProps<{ product: CategoryProduct; layout: 'big' | 'row' | 'grid'; quantity: number; disabled: boolean }>();
const emit = defineEmits<{ detail: []; add: []; buy: []; step: [diff: -1 | 1]; quantity: [value: unknown] }>();
function inputQuantity(event: unknown) { if (!props.disabled) { const input = event as { detail?: { value?: unknown }; target?: { value?: unknown } }; emit('quantity', input.detail?.value ?? input.target?.value); } }
</script>
<style scoped>
.product-card{background:#fff;border-radius:16rpx;overflow:hidden;}.product-card.row{display:flex;padding:18rpx;gap:18rpx;}.product-card.row .product-image{width:160rpx;height:160rpx;flex-shrink:0;}.product-card.big .product-image{width:100%;height:340rpx;}.product-card.grid .product-image{width:100%;height:300rpx;}.product-info{padding:18rpx;min-width:0;flex:1;}.row .product-info{padding:0;}.product-title{font-size:26rpx;line-height:1.5;overflow-wrap:anywhere;}.brand{display:inline-block;color:var(--view-theme);border:1px solid var(--view-theme);font-size:20rpx;margin-right:8rpx;padding:0 5rpx;}.product-price{font-size:34rpx;font-weight:600;color:var(--view-priceColor);margin-top:10rpx;}.vip,.sales{font-size:22rpx;color:#777;margin:8rpx 0;}.card-actions{display:flex;align-items:center;gap:8rpx;margin-top:14rpx;flex-wrap:wrap;}.card-actions button{margin:0;padding:0 14rpx;line-height:2;font-size:23rpx;color:var(--view-bntColor);background:var(--view-theme);}.card-actions input{width:70rpx;text-align:center;border:1px solid #ddd;border-radius:6rpx;font-size:24rpx;padding:4rpx;}.missing-image{display:flex;align-items:center;justify-content:center;color:#999;background:#eee;font-size:23rpx;}
</style>
