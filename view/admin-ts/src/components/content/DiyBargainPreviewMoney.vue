<template>
 <span class="bargain-money" :style="px(view.priceStyle)"><span v-if="view.layout===2" class="bargain-prefix" :style="px(view.prefixStyle)">低至</span><span class="bargain-symbol" :style="px(view.symbolStyle)">￥</span><span class="bargain-integer" :style="px(view.integerStyle)">{{parts.integer}}</span><span class="bargain-decimal" :style="px(view.decimalStyle)">.{{parts.decimal}}</span></span>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { bargainPreviewStyle as px } from '@/utils/diyBargainProjection';
import { bargainMoneyParts, type DiyBargainPresentation } from '../../../../common/diyBargain';
const props=defineProps<{price:string;view:DiyBargainPresentation}>();
const parts=computed(()=>bargainMoneyParts(props.price));
</script>
