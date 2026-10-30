<template>
 <span class="combination-money" :style="px(view.priceStyle)"><span v-if="view.layout===0" class="combination-prefix" :style="px(view.prefixStyle)">拼团价</span><span class="combination-symbol" :style="px(view.symbolStyle)">￥</span><span class="combination-integer" :style="px(view.integerStyle)">{{parts.integer}}</span><span class="combination-decimal" :style="px(view.decimalStyle)">.{{parts.decimal}}</span></span>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { combinationPreviewStyle as px } from '@/utils/diyCombinationProjection';
import { combinationMoneyParts, type DiyCombinationPresentation } from '../../../../common/diyCombination';
const props=defineProps<{price:string;view:DiyCombinationPresentation}>();
const parts=computed(()=>combinationMoneyParts(props.price));
</script>
