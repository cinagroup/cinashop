<template>
  <section class="preview-shell" aria-label="商品文章列表实际字段预览">
    <p class="hint">375 设计宽度预览。只显示当前公开列表，预览中的商品、按钮和文章均不执行跳转、加购、点赞或浏览计数。</p>
    <div class="list-author-preview" :data-kind="p.kind" :data-layout="p.style" :style="px(p.wrapperStyle)">
      <p v-if="loading" role="status">正在读取公开列表…</p>
      <p v-else-if="error" role="alert">{{error}}</p>
      <template v-else-if="loaded">
        <div v-if="p.kind==='goodList'" class="preview-products" :class="`layout-${p.style}`">
          <div v-for="(column,columnIndex) in columns" :key="columnIndex" class="product-column">
          <article v-for="product in column" :key="product.id" :ref="cardRef(columnIndex,product.id)" class="preview-product" :data-product-id="product.id" :style="px(p.panelStyle)">
            <div class="product-picture" :style="px(p.imageStyle)"><img v-if="product.image" :src="product.image" alt="商品图片" :style="px(p.imageStyle)" /><div v-else class="empty-image">暂无图片</div><img v-if="p.showFrame && product.frameImage" class="product-frame" :src="product.frameImage" alt="商品活动边框" /></div>
            <div class="product-copy">
              <p v-if="p.showName" class="product-name" :style="p.nameStyle"><span v-if="p.showBrand && product.brand" class="product-brand">{{product.brand}}</span>{{product.title}}</p>
              <div v-if="p.showLabels" class="product-labels"><span v-for="label in product.labels" :key="label.id" :style="{color:label.color,background:label.background,borderColor:label.border}"><img v-if="label.icon" :src="label.icon" alt="" />{{label.name}}</span></div>
              <div class="product-prices"><strong v-if="p.showPrice" :style="p.priceStyle">¥{{product.price}}</strong><span v-if="p.showOffer && product.offer" class="product-offer">{{product.offer.label}} ¥{{product.offer.price}}</span></div>
              <div class="product-meta"><span v-if="p.showSales" :style="p.salesStyle">已售{{product.sales}}{{product.unit}}</span><span v-if="p.showRating" :style="p.ratingStyle">评分{{product.star}}</span></div>
              <button v-if="p.showAction" type="button" disabled class="product-action" :data-action-style="p.actionStyle" :style="p.buttonStyle" :aria-label="p.cartMode?'预览选择规格加入购物车':'预览查看商品'">{{actionLabel(p.style,p.actionStyle)}}</button>
            </div>
          </article>
          </div>
          <p v-if="!products.length" class="hint">当前范围暂无商品</p>
        </div>
        <div v-else class="preview-articles" :class="`article-layout-${p.style}`">
          <article v-for="article in articles" :key="article.id" class="preview-article" :data-article-id="article.id" :style="px(p.panelStyle)">
            <img v-if="p.style!==0 && article.image" class="article-image" :src="article.image" alt="文章图片" :style="px(p.imageStyle)" />
            <div class="article-copy"><p class="article-title" :style="p.nameStyle">{{article.title}}</p><img v-if="p.style===0 && article.image" class="article-image" :src="article.image" alt="文章图片" :style="px(p.imageStyle)" /><div class="article-meta" :style="p.statisticStyle"><span v-if="p.checks.includes(0)" :style="p.timeStyle">{{article.time}}</span><span v-if="p.checks.includes(1)"><span :style="p.browseStyle">◉ </span>{{article.visit}}</span><span v-if="p.checks.includes(2)"><span :style="p.likeStyle">♡ </span>{{article.likes}}</span></div></div>
          </article>
          <p v-if="!articles.length" class="hint">当前分类暂无文章</p>
        </div>
        <p v-if="p.limitNotice" class="hint">{{p.limitNotice}}</p>
      </template>
      <p v-else class="hint">点击“读取当前公开列表预览”查看真实内容。改变配置后需重新读取。</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { normalizeDiyList, listPreviewTheme } from '@/utils/diyListProjection';
import { listPixelStyle as px, listActionLabel as actionLabel, type ListRecord } from '@/utils/diyListEditor';
import type { ListPreviewProduct, ListPreviewArticle } from '@/api/diyListAuthor';
const props=defineProps<{block:ListRecord;products:ListPreviewProduct[];articles:ListPreviewArticle[];loaded:boolean;loading:boolean;error:string;allowed:()=>boolean}>();
const p=computed(()=>normalizeDiyList(props.block,listPreviewTheme));
const heights=ref(new Map<number,number>()),cards=new Map<number,HTMLElement>(),cardRefs=new Map<string,(value:unknown)=>void>();let alive=true,generation=0,observer:ResizeObserver|null=null;
const columns=computed(()=>{if(p.value.style!==1)return[props.products];const output:[ListPreviewProduct[],ListPreviewProduct[]]=[[],[]],totals=[0,0],values=[...heights.value.values()],estimate=values.length?values.reduce((a,b)=>a+b,0)/values.length:1;for(const product of props.products){const side=totals[0]!<=totals[1]!?0:1;output[side].push(product);totals[side]!+=heights.value.get(product.id)??estimate;}return output;});
function measure(element:HTMLElement,epoch:number){if(!alive||epoch!==generation||!props.allowed()||p.value.style!==1)return;const id=Number(element.dataset.productId);if(cards.get(id)!==element||!props.products.some(row=>row.id===id))return;const height=element.getBoundingClientRect().height;if(!Number.isFinite(height)||height<=0||height>10000||Math.abs((heights.value.get(id)??0)-height)<.5)return;heights.value=new Map(heights.value).set(id,height);}
// A ref owns one column placement. When a card moves to an earlier column,
// Vue can register its replacement before clearing the old column's ref.
function cardRef(column:number,id:number){const key=`${column}:${id}`,cached=cardRefs.get(key);if(cached)return cached;let owned:HTMLElement|undefined;
  const bind=(value:unknown)=>{if(!value||typeof(value as HTMLElement).getBoundingClientRect!=='function'){if(owned){observer?.unobserve(owned);if(cards.get(id)===owned)cards.delete(id);}owned=undefined;return;}
    const element=value as HTMLElement;if(owned&&owned!==element)observer?.unobserve(owned);const previous=cards.get(id);if(previous&&previous!==element)observer?.unobserve(previous);owned=element;cards.set(id,element);observer?.observe(element);const issued=generation,allowed=props.allowed;void nextTick(()=>{if(allowed())measure(element,issued);});};
  cardRefs.set(key,bind);return bind;
}
watch(()=>[props.block,props.products,props.allowed],()=>{generation++;observer?.disconnect();observer=null;heights.value=new Map();if(typeof ResizeObserver!=='undefined'){const issued=generation;observer=new ResizeObserver(entries=>{for(const entry of entries)measure(entry.target as HTMLElement,issued);});for(const element of cards.values())observer.observe(element);const issuedCards=[...cards.values()];void nextTick(()=>{for(const element of issuedCards)measure(element,issued);});}},{immediate:true,flush:'post'});
onBeforeUnmount(()=>{alive=false;generation++;observer?.disconnect();observer=null;cards.clear();cardRefs.clear();heights.value=new Map();});
</script>
<style scoped>
.preview-shell{width:100%;overflow:auto}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.list-author-preview{width:375px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}.preview-products{min-width:0}.product-column{display:grid;grid-template-columns:1fr;gap:8px;min-width:0}.preview-product{position:relative;overflow:hidden;box-sizing:border-box;background:white;min-width:0}.product-picture{position:relative;overflow:hidden;flex-shrink:0}.product-picture>img{display:block;width:100%;height:112px;object-fit:cover}.product-picture>.product-frame{position:absolute;inset:0;height:100%;pointer-events:none}.empty-image{display:grid;place-items:center;width:100%;height:112px;background:#f5f5f5;color:#999;font-size:11px}.product-copy{min-width:0;padding:10px;box-sizing:border-box}.product-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:0;font-size:14px;line-height:20px}.product-brand{font-size:10.5px;background:#333;color:white;padding:0 3px;margin-right:3px}.product-labels{display:flex;gap:3px;flex-wrap:wrap;margin-top:4px}.product-labels>span{display:flex;align-items:center;font-size:10px;border:1px solid transparent;border-radius:3px;padding:0 2.5px}.product-labels img{width:12px;height:12px;margin-right:2px}.product-prices,.product-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px}.product-prices strong{font-size:18px}.product-offer{font-size:10.5px;color:#484643;background:#f7e9cd}.product-meta{font-size:11px;line-height:17px}.product-action{display:block;font-size:11.5px;line-height:1.6;margin:5px 0 0 auto;padding:2px 6px;border:0;border-radius:14px;width:max-content;max-width:100%;opacity:1}.layout-0 .preview-product{display:flex;padding:10px}.layout-0 .product-picture{width:112px}.layout-0 .product-copy{flex:1;padding:0 0 0 10px}.layout-1{display:flex;gap:8px;align-items:flex-start}.layout-1>.product-column{display:flex;flex:1;flex-direction:column;gap:8px;min-width:0}.layout-1 .product-picture>img,.layout-1 .empty-image{height:173px}.layout-2>.product-column{grid-template-columns:repeat(3,minmax(0,1fr))}.layout-2 .product-picture>img,.layout-2 .empty-image{height:105px}.layout-2 .product-copy{padding:8px 4px}.layout-2 .product-prices strong{font-size:14px}.layout-3{padding:12px;background:white;box-sizing:border-box}.layout-3>.product-column{grid-template-columns:repeat(2,minmax(0,1fr))}.layout-3 .preview-product{display:flex}.layout-3 .product-picture{width:72px}.layout-3 .product-picture>img,.layout-3 .empty-image{height:72px}.layout-3 .product-copy{flex:1;padding:0 0 0 7px}.layout-3 .product-name{font-size:13px;line-height:18px}.layout-4 .product-picture>img,.layout-4 .empty-image{height:180px}.layout-4 .product-name{-webkit-line-clamp:1}.layout-5{overflow-x:auto}.layout-5>.product-column{display:flex;min-width:100%;width:max-content}.layout-5 .preview-product{width:100px;flex-shrink:0}.layout-5 .product-picture>img,.layout-5 .empty-image{height:100px}.layout-5 .product-copy{padding:7px 4px}.layout-5 .product-prices strong{font-size:15px}.preview-articles{display:flex;flex-direction:column;gap:10px}.preview-article{display:flex;padding:10px;min-width:0;overflow:hidden;box-sizing:border-box}.article-image{width:120px;height:76px;flex-shrink:0;object-fit:cover}.article-copy{flex:1;min-width:0;padding-left:12px}.article-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:15px;line-height:21px;margin:0}.article-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px;font-size:11.5px}.article-layout-0 .preview-article,.article-layout-2 .preview-article{flex-direction:column;padding:0}.article-layout-0 .article-copy{padding:16px 12px}.article-layout-0 .article-image{display:block;width:100%;height:160px;margin-top:12px}.article-layout-0 .article-title,.article-layout-2 .article-title{-webkit-line-clamp:1}.article-layout-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.article-layout-2 .article-image{width:100%;height:108px}.article-layout-2 .article-copy{padding:10px}.article-layout-2 .article-meta{flex-direction:column;align-items:flex-start}
</style>
