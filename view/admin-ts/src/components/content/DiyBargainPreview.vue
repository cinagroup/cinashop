<template>
 <section class="bargain-preview" aria-label="砍价只读预览">
  <p class="hint">客户端样式预览 · 商品、状态、砍价与更多均只读，不读取详情或提交购买。</p>
  <div :style="px(view.wrapperStyle)"><div class="bargain-panel" :style="px(view.panelStyle)"><div class="bargain-header" :style="px(view.headerStyle)"><div class="bargain-heading-group"><span v-if="view.textTitle" class="bargain-heading" :style="px(view.titleStyle)">{{view.title}}</span><img v-else-if="view.titleImage" :src="view.titleImage" alt="砍价标题" :style="px(view.titleImageStyle)" /><span class="bargain-divider" :style="px(view.dividerStyle)">|</span><span class="bargain-tip" :style="px(view.tipStyle)">{{view.tip}}</span></div><button disabled class="bargain-more" :style="px(view.moreStyle)">{{view.moreText}}<span :style="px({fontSize:'24rpx'})"> ›</span></button></div>
   <p v-if="loading" role="status">正在读取砍价商品…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开砍价商品</p><template v-else><div :style="px(view.bodyStyle)"><div v-if="view.layout===3" class="bargain-scroll"><div class="bargain-list" :style="px(view.listStyle)"><DiyBargainPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div></div><div v-else class="bargain-list" :style="px(view.listStyle)"><DiyBargainPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div><p v-if="!products.length" class="hint">暂无可展示的砍价商品</p></div><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
  </div></div>
 </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { bargainPresentation } from '../../../../common/diyBargain';
import { bargainPreviewBlock, type BargainImageCapability } from '@/utils/diyBargainEditor';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { bargainPreviewStyle as px } from '@/utils/diyBargainProjection';
import type { BargainProductPreview } from '@/api/diyBargainAuthor';
import DiyBargainPreviewCard from './DiyBargainPreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;capabilities:BargainImageCapability[];products:BargainProductPreview[];loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>bargainPresentation(bargainPreviewBlock(JSON.parse(JSON.stringify(props.block)),props.capabilities),listPreviewTheme,safeDiyImageUrl,listSafeColor));
</script>
<style scoped>
.bargain-preview{container-type:inline-size;line-height:normal;width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.bargain-scroll{width:100%;overflow:auto;white-space:nowrap;vertical-align:middle}.bargain-panel,.bargain-list{box-sizing:border-box;min-width:0}.bargain-heading-group{display:flex;align-items:center;min-width:0}
</style>
