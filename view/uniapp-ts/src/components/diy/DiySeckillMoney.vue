<template>
 <view class="seckill-money" :style="view.priceStyle"><text v-if="view.layout===0" class="seckill-prefix" :style="view.prefixStyle">秒杀价</text><text class="seckill-symbol" :style="{...view.symbolStyle,...typography.symbolStyle}">￥</text><text class="seckill-integer" :style="{...view.integerStyle,...typography.integerStyle}">{{parts.integer}}</text><text class="seckill-decimal" :style="{...view.decimalStyle,...typography.decimalStyle}">.{{parts.decimal}}</text></view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { seckillMoneyParts, seckillMoneyTypography, type DiySeckillPresentation } from '../../../../common/diySeckill';
const props=defineProps<{price:string;view:DiySeckillPresentation}>();
const parts=computed(()=>seckillMoneyParts(props.price));
const typography=computed(()=>seckillMoneyTypography(props.price,props.view.layout));
</script>
