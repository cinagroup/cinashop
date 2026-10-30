<template>
 <view class="bargain-money" :style="view.priceStyle"><text v-if="view.layout===2" class="bargain-prefix" :style="view.prefixStyle">低至</text><text class="bargain-symbol" :style="view.symbolStyle">￥</text><text class="bargain-integer" :style="view.integerStyle">{{parts.integer}}</text><text class="bargain-decimal" :style="view.decimalStyle">.{{parts.decimal}}</text></view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { bargainMoneyParts, type DiyBargainPresentation } from '../../../../common/diyBargain';
const props=defineProps<{price:string;view:DiyBargainPresentation}>();
const parts=computed(()=>bargainMoneyParts(props.price));
</script>
