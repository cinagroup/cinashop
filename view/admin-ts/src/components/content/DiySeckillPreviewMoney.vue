<template>
 <span class="seckill-money" :style="px(view.priceStyle)"><span v-if="view.layout===0" class="seckill-prefix" :style="px(view.prefixStyle)">秒杀价</span><span class="seckill-symbol" :style="px({...view.symbolStyle,...typography.symbolStyle})">￥</span><span class="seckill-integer" :style="px({...view.integerStyle,...typography.integerStyle})">{{parts.integer}}</span><span class="seckill-decimal" :style="px({...view.decimalStyle,...typography.decimalStyle})">.{{parts.decimal}}</span></span>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { seckillPreviewStyle as px } from '@/utils/diySeckillProjection';
import { seckillMoneyParts, seckillMoneyTypography, type DiySeckillPresentation } from '../../../../common/diySeckill';
const props=defineProps<{price:string;view:DiySeckillPresentation}>();
const parts=computed(()=>seckillMoneyParts(props.price));
const typography=computed(()=>seckillMoneyTypography(props.price,props.view.layout));
</script>
