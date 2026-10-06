<template>
  <view class="cart-mask" @tap="$emit('close')"><view class="cart-sheet" @tap.stop role="dialog" aria-label="分类购物车">
    <view class="heading"><text>购物车</text><button size="mini" :disabled="disabled || !cart.ready || !cart.items.length" @tap="$emit('clear')">清空</button><button size="mini" @tap="$emit('close')">关闭</button></view>
    <view v-if="cart.loading" class="notice">正在读取购物车报价…</view>
    <view v-else-if="cart.error" class="notice" role="alert">{{ cart.error }}<button size="mini" :disabled="disabled" @tap="$emit('reload')">重新读取购物车</button></view>
    <view v-else-if="!cart.items.length" class="notice">购物车是空的</view>
    <view v-for="item in cart.items" :key="item.id" class="line"><image v-if="item.productInfo?.image" :src="item.productInfo.image" mode="aspectFill" />
      <view class="info"><view>{{ item.productInfo?.storeName || '商品已失效' }}</view><view class="muted">{{ item.productInfo?.suk }}</view>
        <view v-if="item.isValid" class="price">¥{{ cartUnitPrice(item) }}<text class="muted"> {{ cartPriceLabel(item) }}</text></view><view v-else class="muted">已下架、售罄或规格失效</view>
        <view v-if="item.isValid" class="quantity"><button size="mini" :disabled="disabled" @tap="$emit('quantity', item.id, -1)">−</button><text>{{ item.cartNum }}</text><button size="mini" :disabled="disabled || item.cartNum >= Math.min(item.productInfo?.stock ?? 0, 32767)" @tap="$emit('quantity', item.id, 1)">＋</button></view>
        <button size="mini" :disabled="disabled" @tap="$emit('remove', item.id)">删除</button>
      </view>
    </view>
    <view class="notice">商品预估金额，不含运费与结算优惠；失效商品不参与合计。</view>
    <view class="footer"><text>合计 ¥{{ total }}</text><button :disabled="disabled || !cart.ready || !validCount" @tap="$emit('checkout')">去结算</button></view>
  </view></view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useCartStore } from '@/stores/cart';
import { cartTotal, cartUnitPrice, cartPriceLabel } from '../../../../common/cartPrice';
const props = defineProps<{ disabled: boolean }>();
defineEmits<{ close: []; clear: []; reload: []; quantity: [id: number, diff: -1 | 1]; remove: [id: number]; checkout: [] }>();
const cart = useCartStore();
const total = computed(() => cart.ready ? cartTotal(cart.items.map(item => ({ ...item, checked: item.isValid }))) : '—');
const validCount = computed(() => cart.items.filter(item => item.isValid).length);
void props;
</script>
<style scoped>
.cart-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:120;display:flex;align-items:flex-end;}.cart-sheet{background:#fff;max-height:78vh;overflow-y:auto;width:100%;padding:24rpx;border-radius:24rpx 24rpx 0 0;box-sizing:border-box;padding-bottom:calc(24rpx + env(safe-area-inset-bottom));}.heading,.footer,.quantity{display:flex;align-items:center;gap:16rpx;}.heading>text{flex:1;}.heading button,.quantity button{margin:0;}.line{display:flex;gap:20rpx;padding:24rpx 0;border-bottom:1px solid #eee;font-size:26rpx;}.line image{width:120rpx;height:120rpx;}.info{flex:1;min-width:0;overflow-wrap:anywhere;}.muted,.notice{color:#777;font-size:23rpx;}.notice{padding:24rpx 0;line-height:1.6;}.price,.footer>text{color:var(--view-priceColor);}.footer{justify-content:space-between;padding-top:12rpx;}.footer button{margin:0;color:var(--view-bntColor);background:var(--view-theme);font-size:27rpx;}.quantity{margin:14rpx 0;}
</style>
