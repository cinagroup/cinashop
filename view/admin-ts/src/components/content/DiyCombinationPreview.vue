<template>
 <section class="combination-preview" aria-label="拼团只读预览">
  <p class="hint">客户端样式预览 · 商品、人数汇总、拼团与更多均只读，不读取详情或提交购买。</p>
  <div :style="px(view.wrapperStyle)"><div class="combination-panel" :style="px(view.panelStyle)"><div class="combination-header" :style="px(view.headerStyle)"><div class="combination-heading-group"><span v-if="view.textTitle" class="combination-heading" :style="px(view.titleStyle)">{{view.title}}</span><img v-else-if="view.titleImage" :src="view.titleImage" alt="拼团标题" :style="px(view.titleImageStyle)" /><span class="combination-divider" :style="px(view.dividerStyle)">|</span><div v-if="pink" class="combination-avatars"><img v-for="(avatar,index) in pink.avatars" :key="index" :src="avatar" alt="" :style="px(view.avatarStyle)" /></div><span v-if="pink" class="combination-tip" :style="px(view.tipStyle)">{{pink.pink_count}}人拼团成功</span></div><button disabled class="combination-more" :style="px(view.moreStyle)">{{view.moreText}}<span :style="px({fontSize:'24rpx'})"> ›</span></button></div>
   <p v-if="loading" role="status">正在读取拼团商品…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开拼团商品</p><template v-else><div :style="px(view.bodyStyle)"><div v-if="view.layout===3" class="combination-scroll"><div class="combination-list" :style="px(view.listStyle)"><DiyCombinationPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div></div><div v-else class="combination-list" :style="px(view.listStyle)"><DiyCombinationPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div><p v-if="!products.length" class="hint">暂无可展示的拼团商品</p></div><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
  </div></div>
 </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { combinationPresentation } from '../../../../common/diyCombination';
import { combinationPreviewBlock, type CombinationImageCapability } from '@/utils/diyCombinationEditor';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { combinationPreviewStyle as px } from '@/utils/diyCombinationProjection';
import type { CombinationProductPreview, CombinationPinkPreview } from '@/api/diyCombinationAuthor';
import DiyCombinationPreviewCard from './DiyCombinationPreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;capabilities:CombinationImageCapability[];products:CombinationProductPreview[];pink:CombinationPinkPreview|null;loading:boolean;loaded:boolean;error:string}>();
const view=computed(()=>combinationPresentation(combinationPreviewBlock(JSON.parse(JSON.stringify(props.block)),props.capabilities),listPreviewTheme,safeDiyImageUrl,listSafeColor));
</script>
<style scoped>
.combination-preview{container-type:inline-size;line-height:normal;width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.combination-scroll{width:100%;overflow:auto;white-space:nowrap;vertical-align:middle}.combination-panel,.combination-list{box-sizing:border-box;min-width:0}.combination-avatars{display:flex;align-items:center}.combination-heading-group{display:flex;align-items:center;min-width:0}
</style>
