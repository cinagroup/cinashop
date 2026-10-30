<template>
 <view class="combination-money" :style="view.priceStyle"><text v-if="view.layout===0" class="combination-prefix" :style="view.prefixStyle">拼团价</text><text class="combination-symbol" :style="view.symbolStyle">￥</text><text class="combination-integer" :style="view.integerStyle">{{parts.integer}}</text><text class="combination-decimal" :style="view.decimalStyle">.{{parts.decimal}}</text></view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { combinationMoneyParts, type DiyCombinationPresentation } from '../../../../common/diyCombination';
const props=defineProps<{price:string;view:DiyCombinationPresentation}>();
const parts=computed(()=>combinationMoneyParts(props.price));
</script>
