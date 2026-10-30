<template>
 <section class="seckill-preview" aria-label="秒杀只读预览">
  <p class="hint">客户端样式预览 · 商品、状态、秒杀与更多均只读，不读取详情或提交购买。</p>
  <div :style="px(view.wrapperStyle)"><div class="seckill-panel" :style="px(view.panelStyle)"><div class="seckill-header" :style="px(view.headerStyle)"><div class="seckill-heading-group"><span v-if="view.textTitle" class="seckill-heading" :style="px(view.titleStyle)">{{view.title}}</span><img v-else-if="view.titleImage" :src="view.titleImage" alt="秒杀标题" :style="px(view.titleImageStyle)" /><span class="seckill-tip" :style="px(view.tipStyle)">{{view.tip}}</span><span class="seckill-countdown" :style="px(view.countdownStyle)"><template v-for="(part,index) in countdown" :key="index"><span v-if="index" class="seckill-countdown-dot" :style="px(view.dotStyle)">:</span><span class="seckill-countdown-digit" :style="px(view.digitStyle)">{{part}}</span></template></span></div><button disabled class="seckill-more" :style="px(view.moreStyle)">{{view.moreText}}<span :style="px({fontSize:'24rpx'})"> ›</span></button></div>
   <p v-if="loading" role="status">正在读取秒杀商品…</p><p v-else-if="error" role="alert">{{error}}</p><p v-else-if="!loaded" class="hint">请显式读取当前公开秒杀商品</p><template v-else><div :style="px(view.bodyStyle)"><div v-if="view.layout===3" class="seckill-scroll"><div class="seckill-list" :style="px(view.listStyle)"><DiySeckillPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div></div><div v-else class="seckill-list" :style="px(view.listStyle)"><DiySeckillPreviewCard v-for="product in products" :key="product.id" :product="product" :view="view" /></div><p v-if="!products.length" class="hint">暂无可展示的秒杀商品</p></div><p v-if="view.limitNotice" class="hint">{{view.limitNotice}}</p></template>
  </div></div>
 </section>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { seckillPresentation, seckillCountdown } from '../../../../common/diySeckill';
import { seckillPreviewBlock, type SeckillImageCapability } from '@/utils/diySeckillEditor';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { safeDiyImageUrl } from '@/utils/diyStateProjection';
import { seckillPreviewStyle as px } from '@/utils/diySeckillProjection';
import type { SeckillProductPreview } from '@/api/diySeckillAuthor';
import DiySeckillPreviewCard from './DiySeckillPreviewCard.vue';
const props=defineProps<{block:Record<string,unknown>;capabilities:SeckillImageCapability[];products:SeckillProductPreview[];loading:boolean;loaded:boolean;error:string;stop:number}>();
const view=computed(()=>seckillPresentation(seckillPreviewBlock(JSON.parse(JSON.stringify(props.block)),props.capabilities),listPreviewTheme,safeDiyImageUrl,listSafeColor));
const now=ref(Date.now());let timer:ReturnType<typeof setInterval>|undefined,epoch=0;
function clearClock(){epoch++;if(timer!==undefined)clearInterval(timer);timer=undefined;}
watch(()=>[props.stop,props.loaded,props.loading],()=>{clearClock();now.value=Date.now();const stamp=epoch;if(props.loaded&&!props.loading&&props.stop*1000>now.value)timer=setInterval(()=>{if(epoch!==stamp)return;now.value=Date.now();if(now.value>=props.stop*1000)clearClock();},1000);},{immediate:true,flush:'sync'});
onBeforeUnmount(clearClock);const countdown=computed(()=>seckillCountdown(props.stop,now.value));
</script>
<style scoped>
.seckill-preview{container-type:inline-size;line-height:normal;width:min(375px,100%);box-sizing:border-box;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.seckill-scroll{width:100%;overflow:auto;white-space:nowrap;vertical-align:middle}.seckill-panel,.seckill-list{box-sizing:border-box;min-width:0}.seckill-heading-group{display:flex;align-items:center;min-width:0}
</style>
