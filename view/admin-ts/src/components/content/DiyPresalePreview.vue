<template>
 <section class="presale-preview" aria-label="预售只读预览">
  <p class="hint">客户端样式预览 · 商品、状态、预定与更多均只读，不读取详情或提交购买。</p>
  <div :style="px(view.wrapperStyle)"><div class="presale-panel" :style="px(view.panelStyle)"><div class="presale-header" :style="px(view.headerStyle)"><div class="presale-heading-group"><span v-if="view.textTitle" class="presale-heading" :style="px(view.titleStyle)">{{view.title}}</span><img v-else-if="view.titleImage" :src="view.titleImage" alt="预售标题" :style="px(view.titleImageStyle)" /><span class="presale-divider" :style="px(view.dividerStyle)">|</span><span class="presale-tip" :style="px(view.tipStyle)">{{view.tip}}</span></div><button disabled class="presale-more" :style="px(view.moreStyle)">{{view.moreText}}<span :style="px({fontSize:'24rpx'})"> ›</span></button></div>
   <p v-if="loading" role="status">正在读取预售商品…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开预售商品</p><template v-else><div :style="px(view.bodyStyle)"><div v-if="view.layout===3" class="presale-scroll"><div class="presale-list" :style="px(view.listStyle)"><DiyPresalePreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div></div><div v-else class="presale-list" :style="px(view.listStyle)"><DiyPresalePreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div><p v-if="!products.length" class="hint">暂无可展示的预售商品</p></div><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
  </div></div>
 </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { presalePresentation } from '../../../../common/diyPresale';
import { presalePreviewBlock, type PresaleImageCapability } from '@/utils/diyPresaleEditor';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { presalePreviewStyle as px } from '@/utils/diyPresaleProjection';
import type { PresalePreview } from '@/api/diyPresaleAuthor';
import DiyPresalePreviewCard from './DiyPresalePreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;capabilities:PresaleImageCapability[];products:PresalePreview[];loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>presalePresentation(presalePreviewBlock(JSON.parse(JSON.stringify(props.block)),props.capabilities),listPreviewTheme,safeDiyImageUrl,listSafeColor));
</script>
<style scoped>
.presale-preview{container-type:inline-size;line-height:normal;width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.presale-scroll{width:100%;overflow:auto;white-space:nowrap;vertical-align:middle}.presale-panel,.presale-list{box-sizing:border-box;min-width:0}.presale-heading-group{display:flex;align-items:center;min-width:0}
</style>
