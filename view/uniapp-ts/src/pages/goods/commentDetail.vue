<template>
  <view class="page">
    <view v-if="loading" class="state">加载中…</view>
    <view v-else-if="errorMessage" class="state error">
      <text>{{ errorMessage }}</text>
      <button size="mini" @tap="loadAll">重新加载</button>
    </view>
    <template v-else-if="detail">
      <view v-if="detail.product.id" class="product-card" @tap="openProduct">
        <image class="product-image" :src="detail.product.image || placeholder" mode="aspectFill" />
        <text class="product-name">{{ detail.product.store_name }}</text>
        <text class="arrow">›</text>
      </view>

      <view class="review-card">
        <view class="author-row">
          <image v-if="detail.reply.avatar" class="avatar" :src="detail.reply.avatar" mode="aspectFill" />
          <view v-else class="avatar fallback">{{ (detail.reply.nickname || "用")[0] }}</view>
          <view class="author-copy">
            <view class="author-name">
              <text>{{ detail.reply.nickname || "匿名用户" }}</text>
              <text v-if="detail.user.level_name" class="level">V{{ detail.user.level_name }}</text>
              <text v-if="detail.user.vip_status" class="vip">SVIP</text>
            </view>
            <text class="time">{{ detail.reply.add_time }}</text>
          </view>
        </view>
        <view class="rating-row">
          <text class="stars">{{ starText(Number(detail.star)) }}</text>
          <text v-if="detail.reply.suk" class="sku">{{ detail.reply.suk }}</text>
        </view>
        <view class="review-content">{{ detail.reply.comment }}</view>
        <view v-if="detail.reply.pics.length" class="review-pics">
          <image
            v-for="(pic, index) in detail.reply.pics"
            :key="pic + index"
            class="review-pic"
            :src="pic"
            mode="widthFix"
            @tap="previewReview(index)"
          />
        </view>
        <view class="review-meta">
          <text>浏览 {{ detail.reply.views_num }} 次</text>
          <view class="meta-actions">
            <text :class="{ active: detail.is_praise }" @tap="toggleReviewPraise">
              ♥ {{ detail.reply.praise }}
            </text>
            <text>回复 {{ detail.reply.comment_sum }}</text>
          </view>
        </view>
      </view>

      <view class="comments-card">
        <view class="section-title">{{ detail.reply.comment_sum }} 条回复</view>
        <view v-if="comments.length">
          <view v-for="item in comments" :key="item.id" class="comment-row">
            <image v-if="item.user.avatar" class="comment-avatar" :src="item.user.avatar" mode="aspectFill" />
            <view v-else class="comment-avatar fallback">{{ (item.user.nickname || "用")[0] }}</view>
            <view class="comment-body">
              <view class="comment-head">
                <view>
                  <text class="comment-name">{{ item.user.nickname || "用户" }}</text>
                  <text v-if="item.uid === 0" class="merchant">商家</text>
                  <text v-if="item.user.level_name" class="level">V{{ item.user.level_name }}</text>
                </view>
                <text :class="['comment-praise', { active: item.is_praise }]" @tap="toggleCommentPraise(item)">
                  ♥ {{ item.praise }}
                </text>
              </view>
              <text class="time">{{ item.create_time }}</text>
              <view class="comment-content">{{ item.content }}</view>
              <view v-if="item.children" class="child-comment">
                <text class="child-name">{{ item.children.user.nickname }}：</text>
                <text>{{ item.children.content }}</text>
              </view>
            </view>
          </view>
        </view>
        <view v-else class="empty">还没有回复</view>
      </view>

      <view class="composer-space" />
      <view class="composer">
        <textarea
          v-model="content"
          class="composer-input"
          auto-height
          :maxlength="150"
          placeholder="说说你的看法吧"
        />
        <button class="send" size="mini" :disabled="submitting" @tap="submitComment">
          {{ submitting ? "发送中" : "发送" }}
        </button>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import {
  apiCreateReplyComment,
  apiPraiseProductReview,
  apiPraiseReplyComment,
  apiReplyComments,
  apiReplyInfo,
  apiUnpraiseProductReview,
  apiUnpraiseReplyComment,
} from "@/api/reply";
import type { ProductReviewDetail, ReplyCommentItem } from "@/api/reply";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const reviewId = ref(0);
const detail = ref<ProductReviewDetail | null>(null);
const comments = ref<ReplyCommentItem[]>([]);
const content = ref("");
const loading = ref(true);
const submitting = ref(false);
const errorMessage = ref("");
let loadedToken = "";

const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

function requireLogin(): boolean {
  if (authStore.isLoggedIn) return true;
  uni.navigateTo({ url: "/pages/auth/login" });
  return false;
}

function starText(score: number): string {
  const normalized = Math.min(5, Math.max(0, Math.trunc(score || 0)));
  return "★".repeat(normalized) + "☆".repeat(5 - normalized);
}

async function loadAll() {
  if (!reviewId.value || !requireLogin()) {
    loading.value = false;
    return;
  }
  loading.value = true;
  errorMessage.value = "";
  try {
    const [info, list] = await Promise.all([
      apiReplyInfo(reviewId.value),
      apiReplyComments(reviewId.value, 1, 100),
    ]);
    detail.value = info;
    comments.value = list;
    loadedToken = authStore.token;
  } catch (error) {
    detail.value = null;
    comments.value = [];
    errorMessage.value = error instanceof Error ? error.message : "评价加载失败";
  } finally {
    loading.value = false;
  }
}

async function reloadComments() {
  comments.value = await apiReplyComments(reviewId.value, 1, 100);
  if (detail.value) detail.value.reply.comment_sum = comments.value.length;
}

async function submitComment() {
  if (!requireLogin() || submitting.value) return;
  const value = content.value.trim();
  if (!value) return uni.showToast({ title: "说点什么吧", icon: "none" });
  submitting.value = true;
  try {
    await apiCreateReplyComment(reviewId.value, value);
    content.value = "";
    await reloadComments();
    uni.showToast({ title: "回复成功", icon: "success" });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "回复失败", icon: "none" });
  } finally {
    submitting.value = false;
  }
}

async function toggleReviewPraise() {
  if (!detail.value || !requireLogin()) return;
  try {
    if (detail.value.is_praise) {
      await apiUnpraiseProductReview(reviewId.value);
      detail.value.is_praise = false;
      detail.value.reply.praise = Math.max(0, detail.value.reply.praise - 1);
    } else {
      await apiPraiseProductReview(reviewId.value);
      detail.value.is_praise = true;
      detail.value.reply.praise += 1;
    }
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" });
  }
}

async function toggleCommentPraise(item: ReplyCommentItem) {
  if (!requireLogin()) return;
  try {
    if (item.is_praise) await apiUnpraiseReplyComment(item.id);
    else await apiPraiseReplyComment(item.id);
    await reloadComments();
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" });
  }
}

function previewReview(index: number) {
  if (!detail.value) return;
  uni.previewImage({ urls: detail.value.reply.pics, current: detail.value.reply.pics[index] });
}

function openProduct() {
  const product = detail.value?.product;
  if (!product?.id) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${product.id}` });
}

onLoad((options) => {
  reviewId.value = Number(options?.id ?? 0);
  if (!Number.isSafeInteger(reviewId.value) || reviewId.value <= 0) {
    loading.value = false;
    errorMessage.value = "评价参数错误";
    return;
  }
  void loadAll();
});

onShow(() => {
  if (reviewId.value > 0 && authStore.isLoggedIn && !loading.value
    && loadedToken !== authStore.token) void loadAll();
});
</script>

<style scoped>
.page { min-height: 100vh; padding: 20rpx; background: #f5f5f5; box-sizing: border-box; }
.state { padding: 160rpx 24rpx; text-align: center; color: #999; }
.state.error { display: flex; flex-direction: column; align-items: center; gap: 24rpx; color: #666; }
.product-card, .review-card, .comments-card { background: #fff; border-radius: 20rpx; }
.product-card { display: flex; align-items: center; padding: 20rpx; margin-bottom: 20rpx; }
.product-image { width: 104rpx; height: 104rpx; border-radius: 14rpx; background: #eee; }
.product-name { flex: 1; padding: 0 20rpx; font-size: 28rpx; color: #333; line-height: 1.5; }
.arrow { font-size: 44rpx; color: #bbb; }
.review-card { padding: 28rpx; margin-bottom: 20rpx; }
.author-row { display: flex; align-items: center; }
.avatar, .comment-avatar { flex: none; border-radius: 50%; background: #eee; }
.avatar { width: 68rpx; height: 68rpx; }
.fallback { display: flex; align-items: center; justify-content: center; color: #fff; background: #e93323; }
.author-copy { flex: 1; display: flex; flex-direction: column; gap: 5rpx; padding-left: 16rpx; }
.author-name { display: flex; align-items: center; gap: 10rpx; font-size: 28rpx; color: #333; }
.level, .vip, .merchant { display: inline-block; padding: 2rpx 8rpx; margin-left: 8rpx; border-radius: 8rpx; font-size: 18rpx; }
.level { color: #8b5a2b; background: #fff0d9; }
.vip { color: #fff; background: #222; }
.merchant { color: #e93323; background: #fff1ef; }
.time { font-size: 22rpx; color: #aaa; }
.rating-row { display: flex; align-items: center; gap: 20rpx; margin-top: 24rpx; }
.stars { color: #f5a623; letter-spacing: 3rpx; }
.sku { font-size: 22rpx; color: #999; }
.review-content { margin-top: 20rpx; font-size: 29rpx; color: #333; line-height: 1.65; white-space: pre-wrap; }
.review-pics { display: flex; flex-direction: column; gap: 14rpx; margin-top: 20rpx; }
.review-pic { width: 100%; border-radius: 14rpx; }
.review-meta { display: flex; justify-content: space-between; margin-top: 24rpx; font-size: 22rpx; color: #999; }
.meta-actions { display: flex; gap: 26rpx; }
.active { color: #e93323 !important; }
.comments-card { padding: 28rpx; }
.section-title { padding-bottom: 8rpx; font-size: 29rpx; font-weight: 600; color: #333; }
.comment-row { display: flex; padding: 26rpx 0; border-bottom: 1rpx solid #f1f1f1; }
.comment-avatar { width: 60rpx; height: 60rpx; }
.comment-body { flex: 1; min-width: 0; padding-left: 16rpx; }
.comment-head { display: flex; justify-content: space-between; align-items: center; }
.comment-name { font-size: 25rpx; color: #333; }
.comment-praise { flex: none; font-size: 23rpx; color: #999; }
.comment-content { margin-top: 14rpx; font-size: 27rpx; color: #333; line-height: 1.6; white-space: pre-wrap; }
.child-comment { margin-top: 14rpx; padding: 14rpx; border-radius: 10rpx; background: #f7f7f7; font-size: 24rpx; color: #555; }
.child-name { color: #e93323; }
.empty { padding: 50rpx 0; text-align: center; font-size: 25rpx; color: #aaa; }
.composer-space { height: 130rpx; }
.composer { position: fixed; right: 0; bottom: 0; left: 0; display: flex; align-items: flex-end; gap: 16rpx; padding: 18rpx 22rpx; padding-bottom: calc(18rpx + env(safe-area-inset-bottom)); background: #fff; box-shadow: 0 -2rpx 12rpx rgba(0, 0, 0, .05); }
.composer-input { flex: 1; min-height: 64rpx; max-height: 180rpx; padding: 15rpx 20rpx; box-sizing: border-box; border-radius: 32rpx; background: #f5f5f5; font-size: 26rpx; line-height: 1.35; }
.send { margin: 0; color: #fff; border: 0; border-radius: 30rpx; background: #e93323; }
.send[disabled] { opacity: .55; }
</style>
