<template>
 <view class="presale-money" :style="view.priceStyle"><text v-if="view.layout!==1" class="presale-prefix" :style="view.prefixStyle">{{view.layout===0?'预售:':'预售价'}}</text><text class="presale-symbol" :style="view.symbolStyle">￥</text><text class="presale-integer" :style="view.integerStyle">{{parts.integer}}</text><text class="presale-decimal" :style="view.decimalStyle">.{{parts.decimal}}</text></view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { presaleMoneyParts, type DiyPresalePresentation } from '../../../../common/diyPresale';
const props=defineProps<{price:string;view:DiyPresalePresentation}>();
const parts=computed(()=>presaleMoneyParts(props.price));
</script>
