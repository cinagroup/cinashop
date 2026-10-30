<template>
  <section class="promotion-preview" aria-label="商品选项卡只读预览">
    <p class="hint">客户端样式预览 · 选项卡只展示，商品和按钮不执行跳转、规格读取或加购。</p>
    <div class="promotion-nav" :data-style="view.style" :style="px(view.wrapperStyle)">
      <div class="promotion-tabs">
        <div v-for="tab in view.tabs" :key="tab.index" class="promotion-tab" :data-tab="tab.index" :style="px(tabStyle(tab.index).itemStyle)">
          <div v-if="view.style===4" class="promotion-image-wrap" :style="px(tabStyle(tab.index).imageWrapStyle)"><img v-if="tab.image" :src="tab.image" alt="选项卡图片" :style="px(tabStyle(tab.index).imageStyle)" /></div>
          <span class="promotion-text" :style="px(tabStyle(tab.index).textStyle)">{{tab.label}}</span>
          <div v-if="view.style===1 || view.style===2" class="promotion-line" :style="px(tabStyle(tab.index).lineStyle)" />
          <span v-if="view.style===0 && tab.description" class="promotion-description" :style="px(tabStyle(tab.index).descriptionStyle)">{{tab.description}}</span>
        </div>
      </div>
    </div>
    <DiyListPreview v-if="delegated" :block="delegated.block" :products="products" :articles="[]" :loaded="loaded" :loading="loading" :error="error" :allowed="allowed" />
    <p v-else class="hint">此选项卡不在公开页前12项展示范围内，配置仍完整保存。</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import DiyListPreview from './DiyListPreview.vue';
import { normalizeDiyPromotionPreview, promotionPreviewProducts } from '@/utils/diyPromotionProjection';
import { promotionTabPresentation } from '../../../../common/diyPromotion';
import { listPixelStyle as px } from '@/utils/diyListEditor';
import type { PromotionRecord, PromotionImageCapability } from '@/utils/diyPromotionEditor';
import type { ListPreviewProduct } from '@/api/diyListAuthor';
const props = defineProps<{block:PromotionRecord;tabIndex:number;capabilities:PromotionImageCapability[];products:ListPreviewProduct[];loaded:boolean;loading:boolean;error:string;allowed:()=>boolean}>();
const plain = computed(() => JSON.parse(JSON.stringify(props.block)) as PromotionRecord);
const view = computed(() => normalizeDiyPromotionPreview(plain.value, props.capabilities));
const delegated = computed(() => promotionPreviewProducts(plain.value, props.tabIndex));
const tabStyle = (index:number) => promotionTabPresentation(view.value, index, props.tabIndex);
</script>
<style scoped>
.promotion-preview{width:min(375px,100%);box-sizing:border-box;min-width:0;overflow-wrap:anywhere}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.promotion-nav{box-sizing:border-box;min-width:0}.promotion-tabs{white-space:nowrap;overflow:auto}.promotion-image-wrap img{object-fit:cover}.promotion-preview>:deep(.preview-shell){overflow:visible}.promotion-preview>:deep(.list-author-preview){width:100%}
</style>
