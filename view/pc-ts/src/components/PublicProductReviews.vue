<template>
 <section class="public-reviews" aria-label="商品评价">
  <header><h2>商品评价</h2><p v-if="state.page">{{ state.page.stats.total }} 条 · {{ state.page.stats.avgScore }} 分 · 好评率 {{ state.page.stats.goodRate }}%</p></header>
  <button type="button" :disabled="state.loading||state.loadingMore" @click="load">刷新评价</button>
  <nav aria-label="评价筛选"><button v-for="filter in reviewFilters" :key="filter.value" type="button" :aria-pressed="state.filter===filter.value" @click="selectFilter(filter.value)">{{ filter.label }} {{ counts[filter.value] ?? '—' }}</button></nav>
  <p v-if="state.loading" role="status">正在读取评价…</p>
  <div v-if="state.error" role="alert"><p>{{ state.error }}</p><button type="button" :disabled="state.loading||state.loadingMore" @click="state.page ? loadMore() : load()">重新读取</button></div>
  <article v-for="review in state.items" :key="review.id" class="review-card">
   <div class="author"><ProductImage v-if="review.avatar" :src="review.avatar" :alt="review.nickname+'的头像'" class="avatar"/><span v-else class="avatar-fallback" aria-hidden="true">{{ (review.nickname||'用')[0] }}</span><strong>{{ review.nickname || '匿名用户' }}</strong><span v-if="review.level_name" class="badge">{{ review.level_name }}</span><span v-if="review.vip_status" class="badge">SVIP</span></div>
   <p class="rating">{{ '★'.repeat(review.star) }}{{ '☆'.repeat(5-review.star) }} · 商品 {{ review.product_score }} / 服务 {{ review.service_score }} / 物流 {{ review.delivery_score }}</p>
   <p class="meta">{{ review.add_time }} · {{ review.sku || review.suk || '默认规格' }}</p><p class="copy">{{ review.comment }}</p>
   <div v-if="review.pics.length" class="pictures"><a v-for="(pic,i) in review.pics" :key="pic" :href="pic" target="_blank" rel="noopener noreferrer" :aria-label="'查看评价图片 '+(i+1)"><ProductImage :src="pic" :alt="'评价图片 '+(i+1)" loading="lazy"/></a></div>
   <blockquote v-if="review.merchant_reply_content||review.merchant_reply"><strong>商家回复</strong><p>{{ review.merchant_reply_content || review.merchant_reply }}</p><small>{{ review.merchant_reply_time }}</small></blockquote>
   <div v-if="review.replyComment" class="summary"><strong>{{ review.replyComment.user.nickname || '用户' }}：</strong>{{ review.replyComment.content }}<p v-if="review.replyComment.children">商家回复：{{ review.replyComment.children.content }}</p></div>
   <footer><span>浏览 {{ review.views_num }} · {{ review.is_praise?'已赞':'赞' }} {{ review.praise }} · 回复 {{ review.comment_sum }}</span><RouterLink :to="'/reviews/'+review.id">查看评价与全部回复</RouterLink></footer>
  </article>
  <p v-if="state.page&&!state.items.length&&!state.loading">此分类暂无评价</p>
  <button v-if="hasMore" type="button" :disabled="state.loading||state.loadingMore" @click="loadMore">{{ state.loadingMore ? '正在读取…' : '加载更多评价' }}</button>
  <p v-else-if="state.items.length" class="meta">已显示全部 {{ state.page?.total }} 条评价</p>
 </section>
</template>
<script setup lang="ts">
import { computed,toRef } from 'vue';
import { RouterLink } from 'vue-router';
import ProductImage from '@/components/ProductImage.vue';
import { usePublicReviewList } from '@/composables/usePublicProductReviews';
import { reviewFilters } from '../../../common/publicProductReviews';
const props=defineProps<{productId:number}>();
const {state,load,loadMore,selectFilter,hasMore}=usePublicReviewList(toRef(props,'productId'));
const counts=computed(()=>state.page?[state.page.stats.total,state.page.stats.good_count,state.page.stats.in_count,state.page.stats.poor_count]:[]);
</script>
<style scoped>
.public-reviews{margin:28px 0;padding:24px;background:#fff;border-radius:12px;color:#333}.public-reviews h2{font-size:20px;margin:0 0 8px}.public-reviews nav{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}.public-reviews button{padding:9px 16px;border:1px solid #ddd;border-radius:7px;background:#fff;color:inherit;cursor:pointer}.public-reviews button[aria-pressed=true]{color:#b82920;background:#fff0ee;border-color:#b82920}.public-reviews button:disabled{opacity:.55;cursor:wait}.review-card{padding:24px 0;border-top:1px solid #eee;overflow-wrap:anywhere}.author{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.avatar,.avatar-fallback{width:40px;height:40px;border-radius:50%;flex:none}.avatar-fallback{display:grid;place-items:center;background:#f3e8e6}.badge{font-size:12px;color:#745025;background:#fff5df;padding:2px 6px;border-radius:4px}.rating{color:#8c5e0a;font-size:13px}.meta{font-size:12px;color:#666}.copy{white-space:pre-wrap;line-height:1.8}.pictures{display:flex;flex-wrap:wrap;gap:10px}.pictures a{width:100px;max-width:30%;border-radius:6px;overflow:hidden}blockquote,.summary{margin:14px 0;background:#f7f7f7;border-radius:8px;padding:12px;white-space:pre-wrap;line-height:1.7}blockquote p,.summary p{margin:6px 0}footer{display:flex;gap:16px;justify-content:space-between;flex-wrap:wrap;margin-top:16px;font-size:13px}footer a{color:#ae2d23}@media(max-width:600px){.public-reviews{padding:16px}.pictures a{width:80px}}
</style>
