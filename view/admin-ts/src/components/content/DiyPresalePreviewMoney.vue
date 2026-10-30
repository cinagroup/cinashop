<template>
 <span class="presale-money" :style="px(view.priceStyle)"><span v-if="view.layout!==1" class="presale-prefix" :style="px(view.prefixStyle)">{{view.layout===0?'预售:':'预售价'}}</span><span class="presale-symbol" :style="px(view.symbolStyle)">￥</span><span class="presale-integer" :style="px(view.integerStyle)">{{parts.integer}}</span><span class="presale-decimal" :style="px(view.decimalStyle)">.{{parts.decimal}}</span></span>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { presalePreviewStyle as px } from '@/utils/diyPresaleProjection';
import { presaleMoneyParts, type DiyPresalePresentation } from '../../../../common/diyPresale';
const props=defineProps<{price:string;view:DiyPresalePresentation}>();
const parts=computed(()=>presaleMoneyParts(props.price));
</script>
