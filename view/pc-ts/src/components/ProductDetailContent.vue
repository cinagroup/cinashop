<template>
  <div class="product-detail-content">
    <section class="detail-section" aria-label="商品优惠券">
      <header><div><h2>商品优惠券</h2><p v-if="state.page">共 {{ state.page.total }} 张适用优惠券 · 已显示 {{ state.items.length }} 张</p></div><button type="button" :disabled="state.loading || state.loadingMore || !!state.writingId || !!state.checkingId" @click="load()">刷新优惠券</button></header>
      <p v-if="state.loading" role="status">正在读取商品优惠券…</p>
      <div v-if="state.error" class="notice error" role="alert"><p>{{ state.error }}</p><button type="button" :disabled="state.loading || state.loadingMore" @click="load(!!state.page && !state.invalidPagination)">{{ state.invalidPagination ? '刷新优惠券' : '重新读取优惠券' }}</button></div>
      <p v-if="state.notice" class="notice" role="status">{{ state.notice }}</p>
      <p v-if="state.actionError" class="notice error" role="alert">{{ state.actionError }}</p>
      <section v-if="unlistedPending.length" class="pending-claims" aria-label="待核对的领取操作">
        <h3>待核对的领取操作</h3><p>优惠券已离开当前目录，仍可核对原领取状态。</p>
        <article v-for="item in unlistedPending" :key="item.couponId" class="coupon-card" :data-pending-coupon-id="item.couponId"><h3>{{ item.title }}</h3>
          <p role="status">{{ item.phase === 'inflight' ? '正在领取，请勿重复操作' : '领取结果尚未确认，请先核对' }}</p>
          <button v-if="item.phase === 'uncertain'" type="button" :disabled="!!state.checkingId || !!state.writingId || state.loading || state.loadingMore" @click="check(item.couponId)">{{ state.checkingId === item.couponId ? '正在核对…' : '核对领取状态' }}</button>
          <button v-if="item.phase === 'uncertain' && item.checked" type="button" :disabled="!!state.checkingId || !!state.writingId" @click="finish(item.couponId)">已核对，结束本次操作</button>
        </article>
      </section>
      <div class="coupon-grid">
        <article v-for="item in state.items" :key="item.id" class="coupon-card" :data-coupon-id="item.id">
          <div class="coupon-heading"><span>{{ scopes[item.scopeType] }}</span><span v-if="item.isMember" class="member">会员专享</span></div>
          <h3>{{ item.title }}</h3>
          <p class="benefit">{{ benefit(item) }}</p>
          <p class="coupon-meta">{{ validity(item) }}</p>
          <p v-if="received(item)" class="claim-result">已领取</p>
          <template v-else-if="pending(item.id)">
            <p class="claim-pending" role="status">{{ pending(item.id)?.phase === 'inflight' ? '正在领取，请勿重复操作' : '领取结果尚未确认，请先核对' }}</p>
            <button v-if="pending(item.id)?.phase === 'uncertain'" type="button" :disabled="!!state.checkingId || !!state.writingId || state.loading || state.loadingMore" @click="check(item.id)">{{ state.checkingId === item.id ? '正在核对…' : '核对领取状态' }}</button>
            <button v-if="pending(item.id)?.phase === 'uncertain' && pending(item.id)?.checked" type="button" :disabled="!!state.checkingId || !!state.writingId" @click="finish(item.id)">已核对，结束本次操作</button>
          </template>
          <RouterLink v-else-if="session.uid === 0" class="claim-link" :to="loginPath">登录后领取</RouterLink>
          <template v-else><button type="button" :disabled="!canClaim(item)" @click="claim(item.id)">领取</button><p v-if="!item.claimable" class="coupon-meta">{{ reason(item.claimReason) }}</p></template>
        </article>
      </div>
      <p v-if="state.page && !state.items.length && !state.loading && !state.error" class="empty">暂无适用优惠券</p>
      <button v-if="hasMore && !state.invalidPagination" class="more" type="button" :disabled="state.loading || state.loadingMore || !!state.writingId || !!state.checkingId || !!state.error" @click="load(true)">{{ state.loadingMore ? '正在读取…' : '加载更多优惠券' }}</button>
      <p v-else-if="state.page && state.items.length && !state.error" class="coupon-meta">已显示全部 {{ state.page.total }} 张适用优惠券</p>
      <RouterLink v-if="session.uid > 0" class="wallet-link" to="/user/coupon">查看我的优惠券 ›</RouterLink>
    </section>

    <section class="detail-section" aria-label="商品图文详情">
      <header><h2>商品详情</h2><button type="button" :disabled="state.descriptionLoading" @click="refreshDescription">重新读取正文与图片</button></header>
      <p v-if="state.descriptionLoading" role="status">正在读取商品正文…</p>
      <div v-if="state.descriptionError" class="notice error" role="alert">{{ state.descriptionError }}</div>
      <p v-if="failedImages.length" class="notice error" role="alert">有 {{ failedImages.length }} 张正文图片加载失败，可重新读取正文与图片</p>
      <div v-if="state.contentVisible && state.description && !state.descriptionLoading" :key="state.contentVersion" ref="descriptionBody" class="description-body" @error.capture="imageFailed" v-html="descriptionHtml" />
      <p v-else-if="state.contentVisible && !state.descriptionLoading && !state.descriptionError" class="empty">暂无商品详情</p>
    </section>

    <section class="detail-section" aria-label="优品推荐">
      <header><h2>优品推荐</h2><button type="button" :disabled="state.recommendationLoading" @click="refreshRecommendations">刷新推荐</button></header>
      <p v-if="state.recommendationLoading" role="status">正在读取推荐商品…</p>
      <div v-if="state.recommendationError" class="notice error" role="alert">{{ state.recommendationError }}</div>
      <div v-if="state.contentVisible" class="recommendation-grid">
        <RouterLink v-for="item in state.recommendations" :key="item.id" class="recommendation-card" :to="'/goods/' + item.id" :aria-label="'查看推荐商品：' + item.title">
          <ProductImage :key="state.recommendationVersion + ':' + item.id" :src="item.image" :alt="item.title" loading="lazy" />
          <h3>{{ item.title || '商品' }}</h3><div class="recommendation-meta"><strong>¥{{ item.price }}</strong><span>销量 {{ item.sales }}</span></div>
        </RouterLink>
      </div>
      <p v-if="state.contentVisible && !state.recommendations.length && !state.recommendationLoading && !state.recommendationError" class="empty">暂无推荐商品</p>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import ProductImage from '@/components/ProductImage.vue';
import { useProductDetailContent } from '@/composables/useProductDetailContent';
import type { DetailRecommendation, ProductDetailCoupon } from '@/api/productDetailContent';
const props = defineProps<{ productId: number; description: string; recommendations: DetailRecommendation[] }>();
const { state, session, pending, unlistedPending, received, canClaim, load, claim, check, finish, refreshDescription, refreshRecommendations, hasMore, loginPath } = useProductDetailContent(toRef(props, 'productId'), toRef(props, 'description'), toRef(props, 'recommendations'));
const scopes = ['通用券', '品类券', '商品券', '品牌券'];
function benefit(item: ProductDetailCoupon) {
  const threshold = Number(item.minimum) > 0 ? `满 ¥${item.minimum}` : '无门槛';
  return item.benefitType === 2 ? `${threshold}享 ${Number(item.benefitValue) / 10} 折` : `${threshold}减 ¥${item.benefitValue}`;
}
function date(time: number | null) { return time === null ? '' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000)); }
function validity(item: ProductDetailCoupon) {
  if (item.validity.kind === 'relative') return `领取后 ${item.validity.days} 天内可用`;
  const start = date(item.validity.startTime), end = date(item.validity.endTime);
  return start && end ? `${start} 至 ${end} 可用` : end ? `有效期至 ${end}` : start ? `${start} 起可用` : '有效期以优惠券详情为准';
}
function reason(value: string) {
  if (/[\u3400-\u9fff]/u.test(value)) return value;
  if (['member_required', 'membership_required', 'not_member', 'paid_member_required'].includes(value)) return '开通对应会员权益后可领取';
  if (['sold_out', 'out_of_stock', 'exhausted'].includes(value)) return '优惠券已领完';
  if (['limit_reached', 'receive_limit'].includes(value)) return '已达到领取上限';
  return '当前暂不可领取，请刷新查看最新状态';
}
const descriptionBody = ref<HTMLDivElement | null>(null), failedImages = ref<string[]>([]);
watch(() => [state.contentVersion, state.description, state.contentVisible], () => { failedImages.value = []; }, { flush: 'sync' });
const decodeSource = (source: string) => source.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const descriptionHtml = computed(() => state.description.replace(/<img\b[^>]*>/gi, tag => {
  const source = /\bsrc="([^"]*)"/i.exec(tag)?.[1];
  return !source || failedImages.value.includes(decodeSource(source)) ? '<span class="description-image-unavailable" role="img" aria-label="商品正文图片暂不可用">商品正文图片暂不可用</span>' : tag;
}));
function imageFailed(event: Event) {
  const image = event.target as HTMLImageElement | null;
  if (!state.contentVisible || !image || image.tagName !== 'IMG' || !descriptionBody.value?.contains(image)) return;
  const source = image.getAttribute('src');
  if (source && !failedImages.value.includes(source)) failedImages.value = [...failedImages.value, source];
}
</script>
<style scoped>
.detail-section{margin:28px 0;padding:24px;border-radius:12px;background:#fff;color:#333;min-width:0}.detail-section header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}.detail-section h2{font-size:20px;margin:0}.detail-section header p,.coupon-meta{font-size:13px;color:#666;line-height:1.7}.detail-section button,.claim-link{display:inline-block;border:1px solid #b82920;border-radius:7px;background:#fff;padding:9px 14px;color:#a82920;cursor:pointer;line-height:1.5;font-size:14px;text-align:center}.detail-section button:disabled{cursor:default;color:#777;border-color:#ddd;background:#f5f5f5}.coupon-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.coupon-card{padding:18px;border:1px solid #eeddd8;border-radius:10px;overflow-wrap:anywhere;min-width:0}.coupon-heading{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:#995325}.member{padding:2px 6px;background:#fff3dc;color:#71501e;border-radius:3px}.coupon-card h3{font-size:16px;line-height:1.6;margin:12px 0 8px}.benefit{color:#ad2d22;font-size:18px;line-height:1.6;margin:8px 0}.claim-result{color:#666;font-size:14px}.claim-pending{font-size:13px;line-height:1.7;color:#855600}.coupon-card button+button{margin-top:10px}.notice{padding:12px 16px;line-height:1.8;background:#fff8e9;border-radius:8px;overflow-wrap:anywhere;color:#765426}.notice p{margin:0 0 10px}.error{color:#a02c24}.more{margin-top:20px}.wallet-link{display:inline-block;margin:16px 0 0;color:#a82920;font-size:14px}.empty{padding:28px 0;text-align:center;color:#777;line-height:1.7}.description-body{max-width:100%;line-height:1.9;overflow-wrap:anywhere;overflow-x:auto}.description-body :deep(img){display:block;max-width:100%;height:auto;margin:12px auto}.description-body :deep(table){width:100%;max-width:100%;table-layout:fixed}.description-body :deep(td),.description-body :deep(th){overflow-wrap:anywhere}.description-body :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere}.description-body :deep(.description-image-unavailable){display:block;padding:40px 16px;background:#f5f5f5;color:#777;text-align:center;margin:12px 0}.recommendation-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:18px}.recommendation-card{color:inherit;min-width:0;overflow-wrap:anywhere}.recommendation-card h3{font-size:14px;line-height:1.6;font-weight:500;margin:12px 0 8px}.recommendation-meta{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.recommendation-meta strong{font-size:17px;color:#ad2d22}.recommendation-meta span{font-size:12px;color:#777}@media(max-width:900px){.coupon-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.recommendation-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:600px){.detail-section{padding:16px}.coupon-grid{grid-template-columns:minmax(0,1fr)}.recommendation-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.detail-section header{gap:12px}.detail-section button,.claim-link{max-width:100%;box-sizing:border-box}.benefit{font-size:17px}}
</style>
