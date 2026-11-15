<template>
 <main class="review-detail"><h1>评价详情</h1>
  <p v-if="!authenticated"><RouterLink :to="loginPath">登录后查看评价与回复</RouterLink></p>
  <p v-if="state.loading" role="status">正在读取评价…</p><p v-if="state.error" role="alert">{{ state.error }}</p>
  <p v-if="state.message" role="status">{{ state.message }}</p>
  <div class="actions"><button type="button" :disabled="state.loading||state.busy" @click="load">刷新核对</button><button v-if="state.uncertain" type="button" :disabled="!canFinish" @click="finishUncertain">已核对，结束本次操作</button></div>
  <template v-if="detail">
   <RouterLink v-if="detail.product.id" class="product" :to="(detail.product.is_presale_product ? '/presale/' : '/goods/')+detail.product.id"><ProductImage :src="detail.product.image" :alt="detail.product.store_name"/><span>{{ detail.product.store_name }}</span><span>查看商品 ›</span></RouterLink>
   <article class="card">
    <div class="author"><ProductImage v-if="detail.reply.avatar" :src="detail.reply.avatar" :alt="detail.reply.nickname+'的头像'" class="avatar"/><strong>{{ detail.reply.nickname || '匿名用户' }}</strong><span v-if="detail.user.level_name" class="badge">{{ detail.user.level_name }}</span><span v-if="detail.user.vip_status" class="badge">SVIP</span></div>
    <p class="rating">{{ '★'.repeat(Number(detail.star)) }} · 商品 {{ detail.reply.product_score }} / 服务 {{ detail.reply.service_score }} / 物流 {{ detail.reply.delivery_score }}</p>
    <p class="meta">{{ detail.reply.add_time }} · {{ detail.reply.sku || detail.reply.suk || '默认规格' }}</p><p class="copy">{{ detail.reply.comment }}</p>
    <div class="pictures"><a v-for="(pic,i) in detail.reply.pics" :key="pic" :href="pic" target="_blank" rel="noopener noreferrer" :aria-label="'查看评价图片 '+(i+1)"><ProductImage :src="pic" :alt="'评价图片 '+(i+1)"/></a></div>
    <blockquote v-if="detail.reply.merchant_reply_content"><strong>商家回复</strong><p>{{ detail.reply.merchant_reply_content }}</p><small>{{ detail.reply.merchant_reply_time }}</small></blockquote>
    <footer><span>浏览 {{ detail.reply.views_num }} · 回复 {{ state.commentsTotal }}</span><button type="button" :disabled="!canWrite" :aria-pressed="detail.is_praise" @click="toggleReviewPraise">{{ detail.is_praise?'取消点赞':'点赞' }} {{ detail.reply.praise }}</button></footer>
   </article>
   <section class="card" aria-label="评价回复"><h2>全部回复 · {{ state.commentsTotal }}</h2>
    <p v-if="!state.comments.length">暂无回复</p>
    <article v-for="item in state.comments" :key="item.id" class="comment">
     <div class="author"><ProductImage v-if="item.user.avatar" :src="item.user.avatar" :alt="item.user.nickname+'的头像'" class="avatar"/><strong>{{ item.user.nickname || '用户' }}</strong><span v-if="item.user.level_name" class="badge">{{ item.user.level_name }}</span><span v-if="item.user.vip_status" class="badge">SVIP</span></div>
     <p class="copy">{{ item.content }}</p><footer><small>{{ item.create_time }}</small><button type="button" :disabled="!canWrite" :aria-pressed="item.is_praise" @click="toggleCommentPraise(item.id)">{{ item.is_praise?'取消点赞':'点赞' }} {{ item.praise }}</button></footer>
     <blockquote v-if="item.children"><strong>商家回复</strong><p>{{ item.children.content }}</p><footer><small>{{ item.children.create_time }}</small><button type="button" :disabled="!canWrite" :aria-pressed="item.children.is_praise" @click="toggleCommentPraise(item.children.id)">{{ item.children.is_praise?'取消点赞':'点赞' }} {{ item.children.praise }}</button></footer></blockquote>
    </article>
    <button v-if="hasMore" type="button" :disabled="state.loading||state.loadingMore||state.busy" @click="loadMore">{{ state.loadingMore?'正在读取…':'加载更多回复' }}</button>
    <form @submit.prevent="submit"><label for="review-reply">发表回复</label><textarea id="review-reply" v-model="state.content" :disabled="!canWrite" maxlength="4000" placeholder="分享你的看法，最多1000字"/><p class="meta">{{ [...state.content].length }} / 1000 字</p><button type="submit" :disabled="!canWrite||![...state.content.trim()].length||[...state.content.trim()].length>1000">{{ state.busy?'正在提交…':'发表回复' }}</button></form>
   </section>
  </template>
 </main>
</template>
<script setup lang="ts">
import { RouterLink } from 'vue-router';
import ProductImage from '@/components/ProductImage.vue';
import { usePublicReviewDetail } from '@/composables/usePublicProductReviews';
const {state,detail,authenticated,loginPath,load,loadMore,hasMore,canWrite,canFinish,submit,finishUncertain,toggleReviewPraise,toggleCommentPraise}=usePublicReviewDetail();
</script>
<style scoped>
.review-detail{max-width:840px;margin:32px auto;padding:0 20px;color:#333;overflow-wrap:anywhere}.review-detail h1{font-size:24px}.review-detail h2{font-size:18px}.card{padding:24px;margin:20px 0;background:#fff;border:1px solid #eee;border-radius:12px}.product,.author,footer,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.product{background:#fff;padding:16px;text-decoration:none;color:inherit}.product>.product-media{width:64px}.product>span:nth-child(2){flex:1}.avatar{width:40px;height:40px;flex:none;border-radius:50%}.badge{background:#fff5df;color:#745025;font-size:12px;padding:3px 6px}.rating{font-size:13px;color:#8c5e0a}.meta,small{color:#666;font-size:12px}.copy{white-space:pre-wrap;line-height:1.8}.pictures{display:flex;flex-wrap:wrap;gap:10px}.pictures>a{width:140px;max-width:40%}button{border:1px solid #ccc;padding:9px 14px;border-radius:6px;background:#fff;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}button[aria-pressed=true]{color:#b82920}footer{justify-content:space-between;margin-top:14px}.comment{padding:18px 0;border-top:1px solid #eee}blockquote{margin:16px 0 0;padding:16px;background:#f6f6f6;border-radius:8px;white-space:pre-wrap;line-height:1.7}form{margin-top:24px;display:flex;flex-direction:column;gap:10px}textarea{box-sizing:border-box;width:100%;min-height:110px;border:1px solid #ccc;border-radius:8px;padding:12px;font:inherit;resize:vertical}form>button{align-self:flex-start}@media(max-width:600px){.review-detail{padding:0 12px}.card{padding:16px}}
</style>
