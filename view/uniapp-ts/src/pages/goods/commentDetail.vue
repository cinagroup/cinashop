<template><ThemePage><view class="page">
 <view v-if="!auth.isLoggedIn" class="notice"><text>登录后查看评价与回复</text><button size="mini" @tap="login">登录并返回此评价</button></view>
 <view v-if="state.loading" class="notice">正在读取评价…</view><view v-if="state.error" class="notice">{{ state.error }}</view><view v-if="state.message" class="notice">{{ state.message }}</view>
 <view class="actions"><button size="mini" :disabled="state.loading||state.busy" @tap="load">刷新核对</button><button v-if="state.uncertain" size="mini" :disabled="!canFinish" @tap="finishUncertain">已核对，结束本次操作</button></view>
 <template v-if="detail">
  <view v-if="detail.product.id" class="product" @tap="openProduct"><image :src="reviewImageSource(detail.product.image)" mode="aspectFill"/><text>{{ detail.product.store_name }}</text><text>›</text></view>
  <view class="card">
   <view class="author"><image v-if="detail.reply.avatar" class="avatar" :src="reviewImageSource(detail.reply.avatar)" mode="aspectFill"/><text>{{ detail.reply.nickname || '匿名用户' }}</text><text v-if="detail.user.level_name" class="badge">{{ detail.user.level_name }}</text><text v-if="detail.user.vip_status" class="badge">SVIP</text></view>
   <view class="stars">{{ starText(Number(detail.star)) }}</view><view class="meta">商品 {{ detail.reply.product_score }} · 服务 {{ detail.reply.service_score }} · 物流 {{ detail.reply.delivery_score }}</view><view class="meta">{{ detail.reply.add_time }} · {{ detail.reply.sku || detail.reply.suk || '默认规格' }}</view><view class="copy">{{ detail.reply.comment }}</view>
   <view class="pictures"><image v-for="(pic,i) in detail.reply.pics" :key="pic" :src="reviewImageSource(pic)" mode="aspectFill" @tap="previewReview(i)"/></view>
   <view v-if="detail.reply.merchant_reply_content" class="merchant"><text>商家回复</text><view>{{ detail.reply.merchant_reply_content }}</view><text class="meta">{{ detail.reply.merchant_reply_time }}</text></view>
   <view class="foot"><text>浏览 {{ detail.reply.views_num }} · 回复 {{ state.commentsTotal }}</text><button size="mini" :disabled="!canWrite" @tap="toggleReviewPraise">{{ detail.is_praise?'取消点赞':'点赞' }} {{ detail.reply.praise }}</button></view>
  </view>
  <view class="card"><view class="title">全部回复 · {{ state.commentsTotal }}</view><view v-if="!state.comments.length" class="notice">暂无回复</view>
   <view v-for="item in state.comments" :key="item.id" class="comment">
    <view class="author"><image v-if="item.user.avatar" class="avatar" :src="reviewImageSource(item.user.avatar)" mode="aspectFill"/><text>{{ item.user.nickname || '用户' }}</text><text v-if="item.user.level_name" class="badge">{{ item.user.level_name }}</text><text v-if="item.user.vip_status" class="badge">SVIP</text></view>
    <view class="copy">{{ item.content }}</view><view class="foot"><text>{{ item.create_time }}</text><button size="mini" :disabled="!canWrite" @tap="toggleCommentPraise(item.id)">{{ item.is_praise?'取消点赞':'点赞' }} {{ item.praise }}</button></view>
    <view v-if="item.children" class="merchant"><text>商家回复</text><view>{{ item.children.content }}</view><view class="foot"><text>{{ item.children.create_time }}</text><button size="mini" :disabled="!canWrite" @tap="toggleCommentPraise(item.children.id)">{{ item.children.is_praise?'取消点赞':'点赞' }} {{ item.children.praise }}</button></view></view>
   </view>
   <button v-if="hasMore" :disabled="state.loading||state.loadingMore||state.busy" @tap="loadMore">{{ state.loadingMore?'正在读取…':'加载更多回复' }}</button>
   <view class="composer"><text>发表回复</text><textarea v-model="state.content" :disabled="!canWrite" :maxlength="4000" placeholder="分享你的看法，最多1000字"/><text class="meta">{{ [...state.content].length }} / 1000 字</text><button :disabled="!canWrite||![...state.content.trim()].length||[...state.content.trim()].length>1000" @tap="submit">{{ state.busy?'正在提交…':'发表回复' }}</button></view>
  </view>
 </template>
</view><DiySuspendedNavigation/></ThemePage></template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { usePublicReviewDetail } from '@/composables/usePublicReviewDetail';
import { reviewImageSource,reviewImagePreview } from '@/utils/reviewImage';
const {auth,state,detail,load,loadMore,hasMore,canWrite,canFinish,submit,finishUncertain,toggleReviewPraise,toggleCommentPraise,login}=usePublicReviewDetail();
const starText=(score:number)=>'★'.repeat(score)+'☆'.repeat(5-score);
function previewReview(index:number){if(!detail.value)return;const preview=reviewImagePreview(detail.value.reply.pics,detail.value.reply.pics[index]??'');if(preview)uni.previewImage(preview);}
function openProduct(){const product=detail.value?.product;if(product?.id)uni.navigateTo({url:(product.is_presale_product?'/pages/activity/presaleDetail?id=':'/pages/goods/detail?id=')+product.id});}
</script>
<style scoped>
.page{padding:24rpx;min-height:100vh;box-sizing:border-box;color:#333;overflow-wrap:anywhere}.card,.product{background:#fff;border-radius:18rpx;padding:26rpx;margin:20rpx 0}.product,.author,.foot,.actions{display:flex;align-items:center;gap:12rpx;flex-wrap:wrap}.product image{width:90rpx;height:90rpx;border-radius:8rpx}.product>text:nth-child(2){flex:1;font-size:27rpx}.author{font-size:28rpx}.avatar{width:60rpx;height:60rpx;border-radius:50%;flex:none}.badge{font-size:20rpx;color:#745025;background:#fff5df;padding:2rpx 8rpx}.stars{color:#916108;margin:18rpx 0 10rpx}.meta,.foot{color:#666;font-size:23rpx;margin:10rpx 0;line-height:1.6}.copy{white-space:pre-wrap;line-height:1.8;font-size:28rpx;margin:18rpx 0}.pictures{display:flex;gap:10rpx;flex-wrap:wrap}.pictures image{width:calc((100% - 20rpx)/3);height:180rpx;border-radius:8rpx}.merchant{background:#f5f5f5;padding:18rpx;border-radius:10rpx;font-size:25rpx;line-height:1.7;white-space:pre-wrap;margin:18rpx 0}.merchant>text:first-child{font-weight:600}.foot{justify-content:space-between}.foot button{margin:0;font-size:23rpx}.notice{text-align:center;padding:25rpx 0;color:#666;font-size:26rpx}.notice button{margin:18rpx auto}.title{font-size:31rpx;font-weight:600}.comment{border-top:1px solid #eee;padding:24rpx 0}.composer{margin-top:24rpx;display:flex;flex-direction:column;gap:14rpx}.composer textarea{box-sizing:border-box;width:100%;min-height:190rpx;border:1px solid #ccc;border-radius:10rpx;padding:18rpx;font-size:28rpx}.composer button{width:100%;color:var(--view-theme,#b82920)}.actions button{font-size:24rpx;margin:0}
</style>
