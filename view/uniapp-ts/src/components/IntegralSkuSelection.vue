<template>
  <view class="integral-selection">
    <view class="heading">选择兑换规格</view>
    <view v-if="detail.productAttr.length" class="notice">{{ detail.productAttr.map(attr => `${attr.name}：${attr.values.join(' / ')}`).join('；') }}</view>
    <view class="sku-options">
      <button v-for="sku in detail.skus" :key="sku.id" class="sku-option" :class="{ active: selected !== '' && selected === sku.unique }"
        :aria-pressed="selected === sku.unique" :disabled="disabled || !sku.purchasable || sku.stock < 1" @tap="$emit('choose', sku.unique)">
        {{ sku.suk || '默认规格' }} · {{ integralSkuPriceLabel(sku) }}{{ !sku.purchasable || sku.stock < 1 ? ' · 暂不可兑换' : '' }}
      </button>
    </view>
    <view v-if="!detail.skus.length" class="notice">暂无可兑换规格</view>
    <view v-if="selectedSku" class="notice">可兑库存 {{ selectedSku.stock }} {{ detail.storeInfo.unitName || '件' }} · 本次最多 {{ maxQuantity }} 件</view>
    <view class="quantity-row">
      <text>兑换数量</text><button size="mini" :disabled="disabled || maxQuantity < 1 || quantity === 1" @tap="$emit('step', -1)">−</button>
      <input :value="quantity" type="number" aria-label="兑换数量" :disabled="disabled || maxQuantity < 1" @input="quantityInput" />
      <button size="mini" :disabled="disabled || maxQuantity < 1 || quantity === maxQuantity" @tap="$emit('step', 1)">＋</button>
    </view>
    <view v-if="totals" class="selection-total">本次数量小计 {{ totals.integral }} 积分 + ¥{{ totals.cash }}</view>
    <view v-else class="notice" role="status">请选择可兑换规格和上限内的整数数量</view>
    <view v-if="selectedSku?.issues.length" class="notice">该规格资料异常，兑换资格以重新读取结果为准。</view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { integralMaxQuantity, integralSelectionTotals, integralSkuPriceLabel, type IntegralDetail } from '../../../common/integralPurchase';
const props = defineProps<{ detail: IntegralDetail; selected: string; quantity: number | string; disabled: boolean }>();
const emit = defineEmits<{ choose: [unique: string]; quantity: [value: unknown]; step: [diff: -1 | 1] }>();
const selectedSku = computed(() => props.detail.skus.find(sku => sku.unique === props.selected));
const maxQuantity = computed(() => integralMaxQuantity(props.detail, props.selected));
const totals = computed(() => typeof props.quantity === 'number' ? integralSelectionTotals(props.detail, props.selected, props.quantity) : null);
function quantityInput(event: unknown) {
  if (props.disabled) return;
  const input = event as { detail?: { value?: unknown }; target?: { value?: unknown } };
  emit('quantity', input.detail?.value ?? input.target?.value);
}
</script>
<style scoped>
.heading {font-size:30rpx;font-weight:600;margin-bottom:18rpx;}
.notice {font-size:24rpx;line-height:1.6;color:#666;margin:16rpx 0;overflow-wrap:anywhere;}
.sku-options {display:flex;flex-direction:column;gap:16rpx;}
.sku-option {margin:0;padding:14rpx 18rpx;font-size:25rpx;text-align:left;white-space:normal;line-height:1.7;overflow-wrap:anywhere;}
.sku-option.active {border:2rpx solid var(--view-theme, #e93323);color:var(--view-theme, #e93323);background:var(--view-minorColorT, rgba(233, 51, 35, 0.1));}
.quantity-row {display:flex;gap:14rpx;align-items:center;margin-top:24rpx;font-size:26rpx;}
.quantity-row > text {flex:1;min-width:0;}
.quantity-row input {width:110rpx;padding:10rpx;text-align:center;border:1rpx solid #ccc;border-radius:8rpx;}
.quantity-row button {margin:0;min-width:54rpx;padding:0 12rpx;}
.selection-total {margin-top:20rpx;font-size:28rpx;color:var(--view-priceColor, #e93323);overflow-wrap:anywhere;}
</style>
