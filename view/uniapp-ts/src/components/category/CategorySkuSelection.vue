<template>
  <view class="category-sku" role="dialog" aria-label="选择商品规格">
    <view class="sku-heading"><text>选择商品规格</text><button size="mini" :disabled="disabled" @tap="$emit('close')">关闭</button></view>
    <view class="sku-summary">
      <image v-if="selectedSku?.image || detail.image" :src="selectedSku?.image || detail.image" mode="aspectFill" @tap="preview" />
      <view><view class="sku-name">{{ detail.store_name }}</view><view v-if="selectedSku" class="price">¥{{ skuDisplayPrice(selectedSku) }}</view>
        <view v-if="selectedSku && skuPriceLabel(selectedSku)">{{ skuPriceLabel(selectedSku) }}</view>
        <view v-if="offer">SVIP专享 ¥{{ offer }}</view><view v-if="selectedSku">库存 {{ selectedSku.stock }} · {{ selectedSku.suk }}</view></view>
    </view>
    <view v-for="(attr, index) in detail.product_attrs || []" :key="attr.name" class="dimension">
      <view>{{ attr.name }}</view><view class="options"><button v-for="value in attr.values" :key="value" :disabled="disabled" :class="{active: selectedParts[index] === value}" @tap="pickPart(index, value)">{{ value }}</button></view>
    </view>
    <view class="options complete-skus"><button v-for="item in detail.skus" :key="item.unique" :disabled="disabled" :class="{active: selected === item.unique, soldout: item.stock < 1}" @tap="$emit('choose', item.unique)">
      {{ item.suk }}{{ item.stock < 1 ? '（售罄）' : '' }}
    </button></view>
    <view v-if="!detail.skus.length" class="notice">暂无可购买规格</view>
    <view class="quantity-row"><text>购买数量</text><button size="mini" :disabled="disabled || maximum < 1 || quantity === 1" @tap="$emit('step', -1)">−</button>
      <input :key="selected" :value="quantity" type="number" aria-label="购买数量" :disabled="disabled || maximum < 1" @input="inputQuantity" />
      <button size="mini" :disabled="disabled || maximum < 1 || quantity === maximum" @tap="$emit('step', 1)">＋</button></view>
    <view class="notice">本次最多 {{ maximum }} 件；实际优惠、运费与资格以结算页重新报价为准。</view>
    <button class="confirm" :disabled="disabled || maximum < 1" @tap="$emit('confirm')">{{ maximum < 1 ? '暂无库存' : mode === 'buy' ? '立即购买' : '加入购物车' }}</button>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { GoodsDetail } from '@/types/product';
import { skuDisplayPrice, skuPriceLabel, skuVipOffer } from '../../../../common/skuMembershipPrice';
const props = defineProps<{ detail: GoodsDetail; selected: string; quantity: number | string; maximum: number; disabled: boolean; mode: 'cart' | 'buy' }>();
const emit = defineEmits<{ choose: [unique: string]; quantity: [value: unknown]; step: [diff: -1 | 1]; confirm: []; close: [] }>();
const selectedSku = computed(() => props.detail.skus.find(item => item.unique === props.selected));
const selectedParts = computed(() => selectedSku.value?.suk.split(',') ?? []);
const offer = computed(() => skuVipOffer(selectedSku.value, props.detail.is_vip === 1));
function pickPart(index: number, value: string) {
  if (props.disabled) return; const parts = [...selectedParts.value]; parts[index] = value;
  const item = props.detail.skus.find(sku => sku.suk === parts.join(','));
  if (item) emit('choose', item.unique); else uni.showToast({ title: '该规格组合不存在，请选择其它规格', icon: 'none' });
}
function inputQuantity(event: unknown) { if (!props.disabled) { const input = event as { detail?: { value?: unknown }; target?: { value?: unknown } }; emit('quantity', input.detail?.value ?? input.target?.value); } }
function preview() {
  const urls = [...new Set(props.detail.skus.map(item => item.image).filter((url): url is string => !!url))];
  if (!urls.length && props.detail.image) urls.push(props.detail.image);
  if (urls.length) uni.previewImage({ urls, current: selectedSku.value?.image || props.detail.image });
}
</script>
<style scoped>
.category-sku{padding:24rpx;background:#fff;max-height:80vh;overflow-y:auto;border-radius:24rpx 24rpx 0 0;box-sizing:border-box;padding-bottom:calc(24rpx + env(safe-area-inset-bottom));}
.sku-heading,.quantity-row{display:flex;align-items:center;gap:16rpx;font-size:28rpx;}.sku-heading>text,.quantity-row>text{flex:1;}.sku-heading button,.quantity-row button{margin:0;}
.sku-summary{display:flex;gap:20rpx;margin:24rpx 0;font-size:24rpx;line-height:1.7;}.sku-summary image{width:150rpx;height:150rpx;flex-shrink:0;}.sku-name{font-size:28rpx;overflow-wrap:anywhere;}.price{color:var(--view-priceColor);font-size:36rpx;}.dimension{font-size:26rpx;margin:18rpx 0;}.options{display:flex;gap:12rpx;flex-wrap:wrap;margin:12rpx 0;}.options button{margin:0;font-size:24rpx;line-height:1.6;padding:12rpx 18rpx;white-space:normal;}.options .active{background:var(--view-minorColorT);border:1px solid var(--view-theme);color:var(--view-theme);}.soldout{color:#888;}.quantity-row input{width:100rpx;text-align:center;border:1px solid #ddd;border-radius:6rpx;padding:12rpx;}.notice{font-size:23rpx;color:#777;margin:20rpx 0;line-height:1.6;}.confirm{color:var(--view-bntColor);background:var(--view-theme);font-size:28rpx;}
</style>
