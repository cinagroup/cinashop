<template><ThemePage><view class="page">
 <view class="stats" v-if="state.page"><text class="score">{{ state.page.stats.avgScore }} 分</text><text>{{ state.page.stats.total }} 条评价 · 好评率 {{ state.page.stats.goodRate }}%</text></view>
 <button size="mini" :disabled="state.loading||state.loadingMore" @tap="load">刷新评价</button>
 <view class="filters"><button v-for="filter in reviewFilters" :key="filter.value" size="mini" :class="{active:state.filter===filter.value}" @tap="selectFilter(filter.value)">{{ filter.label }} {{ counts[filter.value] ?? '—' }}</button></view>
 <view v-if="state.loading" class="notice">正在读取评价…</view><view v-if="state.error" class="notice"><text>{{ state.error }}</text><button size="mini" :disabled="state.loading||state.loadingMore" @tap="state.page?loadMore():load()">重新读取</button></view>
 <view v-for="review in state.items" :key="review.id" class="card">
  <view class="author"><image v-if="review.avatar" class="avatar" :src="reviewImageSource(review.avatar)" mode="aspectFill"/><text v-else class="avatar fallback">{{ (review.nickname||'用')[0] }}</text><text>{{ review.nickname || '匿名用户' }}</text><text v-if="review.level_name" class="badge">{{ review.level_name }}</text><text v-if="review.vip_status" class="badge">SVIP</text></view>
  <view class="stars">{{ starText(review.star) }}</view><view class="meta">商品 {{ review.product_score }} · 服务 {{ review.service_score }} · 物流 {{ review.delivery_score }}</view>
  <view class="meta">{{ review.add_time }} · {{ review.sku || review.suk || '默认规格' }}</view><view class="copy">{{ review.comment }}</view>
  <view class="pictures"><image v-for="(pic,i) in review.pics" :key="pic" :src="reviewImageSource(pic)" mode="aspectFill" @tap="previewImage(review.pics,i)"/></view>
  <view v-if="review.merchant_reply_content||review.merchant_reply" class="merchant"><text>商家回复</text><view>{{ review.merchant_reply_content || review.merchant_reply }}</view><text class="meta">{{ review.merchant_reply_time }}</text></view>
  <view v-if="review.replyComment" class="summary"><text>{{ review.replyComment.user.nickname || '用户' }}：{{ review.replyComment.content }}</text><view v-if="review.replyComment.children">商家回复：{{ review.replyComment.children.content }}</view></view>
  <view class="meta">浏览 {{ review.views_num }} · {{ review.is_praise?'已赞':'赞' }} {{ review.praise }} · 回复 {{ review.comment_sum }}</view><button size="mini" @tap="openDetail(review.id)">查看评价与全部回复</button>
 </view>
 <view v-if="state.page&&!state.items.length&&!state.loading" class="notice">此分类暂无评价</view><button v-if="hasMore" :disabled="state.loading||state.loadingMore" @tap="loadMore">{{ state.loadingMore?'正在读取…':'加载更多评价' }}</button><view v-else-if="state.items.length" class="notice">已显示全部 {{ state.page?.total }} 条评价</view>
</view><DiySuspendedNavigation/></ThemePage></template>
<script setup lang="ts">
import { computed } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { usePublicReviewList } from '@/composables/usePublicReviewList';
import { reviewImageSource,reviewImagePreview } from '@/utils/reviewImage';
import { reviewFilters } from '../../../../common/publicProductReviews';
const {state,load,loadMore,selectFilter,hasMore,openDetail}=usePublicReviewList();
const counts=computed(()=>state.page?[state.page.stats.total,state.page.stats.good_count,state.page.stats.in_count,state.page.stats.poor_count]:[]);
const starText=(score:number)=>'★'.repeat(score)+'☆'.repeat(5-score);
function previewImage(pics:string[],current:number){const preview=reviewImagePreview(pics,pics[current]??'');if(preview)uni.previewImage(preview);}
</script>
<style scoped>
.page{padding:24rpx;min-height:100vh;box-sizing:border-box;color:#333;overflow-wrap:anywhere}.stats,.card{background:#fff;border-radius:18rpx;padding:26rpx;margin-bottom:20rpx}.stats{display:flex;flex-direction:column;gap:12rpx;font-size:26rpx}.score{font-size:40rpx;color:#a16b0a;font-weight:700}.filters{display:flex;gap:8rpx;margin:24rpx 0}.filters button{flex:1;padding:0 8rpx;font-size:24rpx;white-space:nowrap}.filters .active{color:var(--view-theme,#b82920);background:#fff0ee}.author{display:flex;align-items:center;gap:12rpx;flex-wrap:wrap;font-size:28rpx}.avatar{width:60rpx;height:60rpx;border-radius:50%;flex:none}.fallback{display:flex;align-items:center;justify-content:center;background:#f3e8e6}.badge{font-size:20rpx;color:#745025;background:#fff5df;padding:2rpx 8rpx}.stars{color:#916108;margin:18rpx 0 10rpx}.meta{color:#666;font-size:23rpx;margin:10rpx 0;line-height:1.6}.copy{white-space:pre-wrap;line-height:1.8;font-size:28rpx;margin:18rpx 0}.pictures{display:flex;gap:10rpx;flex-wrap:wrap}.pictures image{width:calc((100% - 20rpx)/3);height:180rpx;border-radius:8rpx}.merchant,.summary{background:#f5f5f5;padding:18rpx;border-radius:10rpx;font-size:25rpx;line-height:1.7;white-space:pre-wrap;margin:18rpx 0}.merchant>text:first-child{font-weight:600}.notice{text-align:center;padding:30rpx 0;color:#666;font-size:26rpx}.notice button{margin:18rpx auto}.card>button{margin:16rpx 0 0;font-size:24rpx}
</style>
