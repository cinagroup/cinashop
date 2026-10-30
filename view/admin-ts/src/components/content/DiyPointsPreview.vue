<template>
  <section class="points-preview" aria-label="积分商城只读预览">
    <p class="hint">客户端样式预览 · 商品、更多与积分价格仅展示，不读取详情或兑换。</p>
    <div :style="px(view.wrapperStyle)"><div class="points-panel" :style="px(view.panelStyle)">
      <div class="points-header" :style="px(view.headerStyle)"><span v-if="view.textTitle" :style="px(view.titleStyle)">{{view.title}}</span><img v-else-if="view.titleImage" :src="view.titleImage" alt="积分商城标题" :style="px(view.titleImageStyle)" /><button disabled class="points-more" :style="px(view.moreStyle)">更多<span style="font-size:12px"> ›</span></button></div>
      <p v-if="loading" role="status">正在读取积分商品…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开积分商品</p>
      <template v-else><div :style="px(view.bodyStyle)"><div v-if="view.layout===0" class="points-scroll" :style="px(view.scrollStyle)"><div class="points-list" :style="px(view.listStyle)"><DiyPointsPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div></div><div v-else class="points-list" :style="px(view.listStyle)"><DiyPointsPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div><p v-if="!products.length" class="hint">暂无可展示的积分商品</p></div><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
    </div></div>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { pointsPresentation } from '../../../../common/diyPoints';
import { pointsPreviewBlock, type PointsImageCapability } from '@/utils/diyPointsEditor';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { listPixelStyle as px } from '@/utils/diyListEditor';
import type { PointsPreview } from '@/api/diyPointsAuthor';
import DiyPointsPreviewCard from './DiyPointsPreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;capabilities:PointsImageCapability[];products:PointsPreview[];loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>pointsPresentation(pointsPreviewBlock(JSON.parse(JSON.stringify(props.block)),props.capabilities),listPreviewTheme,safeDiyImageUrl,listSafeColor));
</script>
<style scoped>
.points-preview{width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.points-scroll{width:100%;overflow:auto}.points-panel,.points-list{box-sizing:border-box;min-width:0}.points-more{font-size:12px}
</style>
