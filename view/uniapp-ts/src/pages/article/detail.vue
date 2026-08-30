<template>
  <view class="detail-page">
    <view v-if="loading && !article" class="state-block">正在加载...</view>
    <view v-else-if="errorMessage && !article" class="state-block">
      <text>{{ errorMessage }}</text>
      <view class="retry" @tap="loadDetail">重新加载</view>
    </view>

    <view v-else-if="article" class="article-shell">
      <view class="article-head">
        <view class="title">{{ article.title }}</view>
        <view class="meta">
          <text v-if="article.catename">{{ article.catename }}</text>
          <text>{{ article.add_time }}</text>
          <text>{{ article.visit }} 次阅读</text>
        </view>
      </view>

      <image v-if="cover" class="cover" :src="cover" mode="widthFix" />

      <view class="article-body">
        <!--
          Legacy article HTML is untrusted migration input. A local allowlist is
          applied before UniApp's restricted rich-text parser; never use v-html.
        -->
        <rich-text v-if="safeContent" :nodes="safeContent" />
        <text v-else class="empty-content">{{ article.synopsis || "暂无正文" }}</text>
      </view>

      <view v-if="product" class="product-card" @tap="goProduct">
        <image class="product-image" :src="product.image" mode="aspectFill" />
        <view class="product-copy">
          <view class="product-name">{{ product.store_name }}</view>
          <view class="product-bottom">
            <view>
              <text class="product-price">¥{{ product.price }}</text>
              <text v-if="Number(product.ot_price) > Number(product.price)" class="product-old-price">
                ¥{{ product.ot_price }}
              </text>
            </view>
            <text class="product-link">查看商品</text>
          </view>
        </view>
      </view>

      <view class="article-footer-space" />
      <view class="article-actions">
        <view class="read-count">{{ article.visit }} 次阅读</view>
        <view
          class="like-action"
          :class="{ liked: isLiked, disabled: likeSubmitting }"
          @tap="toggleLike"
        >
          <text class="like-symbol">{{ isLiked ? "♥" : "♡" }}</text>
          <text>{{ article.likes }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow } from "@dcloudio/uni-app";
import { apiArticleDetails, apiArticleLike, type ArticleDetail } from "@/api/article";
import { useAuthStore } from "@/stores/auth";
import { sanitizeArticleRichText } from "@/utils/articleRichText";

const authStore = useAuthStore();
const articleId = ref(0);
const article = ref<ArticleDetail | null>(null);
const loading = ref(true);
const likeSubmitting = ref(false);
const errorMessage = ref("");
let loadedForToken = "";

const product = computed(() => article.value?.store_info ?? article.value?.storeInfo ?? null);
const cover = computed(() =>
  article.value?.image_input.find((image) => image.trim().length > 0) ?? "",
);
const isLiked = computed(() => Boolean(article.value?.is_like));
const safeContent = computed(() => sanitizeArticleRichText(article.value?.content ?? ""));

async function loadDetail(): Promise<void> {
  if (!articleId.value || (loading.value && article.value !== null)) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await apiArticleDetails(articleId.value);
    article.value = result;
    loadedForToken = authStore.token;
    uni.setNavigationBarTitle({ title: result.title || "资讯详情" });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "资讯加载失败";
  } finally {
    loading.value = false;
  }
}

async function toggleLike(): Promise<void> {
  if (!article.value || likeSubmitting.value) return;
  if (!authStore.isLoggedIn) {
    uni.navigateTo({ url: "/pages/auth/login" });
    return;
  }

  const likedBefore = isLiked.value;
  likeSubmitting.value = true;
  try {
    await apiArticleLike(article.value.id, { status: likedBefore ? 0 : 1 });
    article.value.is_like = likedBefore ? 0 : 1;
    article.value.likes = Math.max(0, article.value.likes + (likedBefore ? -1 : 1));
    uni.showToast({ title: likedBefore ? "已取消点赞" : "点赞成功", icon: "none" });
  } catch (error) {
    uni.showToast({
      title: error instanceof Error ? error.message : "操作失败",
      icon: "none",
    });
  } finally {
    likeSubmitting.value = false;
  }
}

function goProduct(): void {
  if (!product.value?.id) return;
  uni.navigateTo({ url: `/pages/goods/detail?id=${product.value.id}` });
}

onLoad((options) => {
  const id = Number(options?.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    loading.value = false;
    errorMessage.value = "文章参数无效";
    return;
  }
  articleId.value = id;
});

onShow(() => {
  if (!articleId.value) return;
  if (!article.value || loadedForToken !== authStore.token) void loadDetail();
});
</script>

<style scoped>
.detail-page {
  min-height: 100vh;
  background: #fff;
}

.article-shell {
  padding: 40rpx 32rpx 0;
}

.article-head {
  margin-bottom: 30rpx;
}

.title {
  color: #222;
  font-size: 40rpx;
  font-weight: 700;
  line-height: 58rpx;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx 24rpx;
  margin-top: 18rpx;
  color: #999;
  font-size: 23rpx;
  line-height: 34rpx;
}

.cover {
  display: block;
  width: 100%;
  max-height: 720rpx;
  margin-bottom: 32rpx;
  overflow: hidden;
  border-radius: 14rpx;
}

.article-body {
  overflow: hidden;
  color: #333;
  font-size: 30rpx;
  line-height: 1.8;
  overflow-wrap: anywhere;
}

.empty-content {
  color: #999;
}

.product-card {
  display: flex;
  gap: 20rpx;
  margin-top: 40rpx;
  padding: 20rpx;
  border-radius: 16rpx;
  background: #f7f7f7;
}

.product-image {
  flex-shrink: 0;
  width: 150rpx;
  height: 150rpx;
  border-radius: 12rpx;
  background: #eee;
}

.product-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}

.product-name {
  display: -webkit-box;
  overflow: hidden;
  color: #333;
  font-size: 27rpx;
  font-weight: 600;
  line-height: 40rpx;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.product-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: auto;
}

.product-price {
  color: #e93323;
  font-size: 30rpx;
  font-weight: 700;
}

.product-old-price {
  margin-left: 12rpx;
  color: #aaa;
  font-size: 21rpx;
  text-decoration: line-through;
}

.product-link {
  padding: 10rpx 18rpx;
  border-radius: 24rpx;
  color: #fff;
  background: #e93323;
  font-size: 22rpx;
}

.article-footer-space {
  height: 150rpx;
}

.article-actions {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 108rpx;
  padding: 16rpx 40rpx calc(16rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid #eee;
  background: #fff;
  box-sizing: border-box;
}

.read-count {
  color: #999;
  font-size: 24rpx;
}

.like-action {
  display: flex;
  align-items: center;
  gap: 10rpx;
  min-width: 120rpx;
  justify-content: center;
  padding: 12rpx 22rpx;
  border: 1rpx solid #ddd;
  border-radius: 40rpx;
  color: #666;
  font-size: 25rpx;
}

.like-action.liked {
  border-color: #e93323;
  color: #e93323;
  background: #fff5f3;
}

.like-action.disabled {
  opacity: 0.55;
}

.like-symbol {
  font-size: 32rpx;
  line-height: 1;
}

.state-block {
  padding: 180rpx 40rpx;
  color: #999;
  font-size: 27rpx;
  text-align: center;
}

.retry {
  width: 180rpx;
  margin: 28rpx auto 0;
  padding: 14rpx 0;
  border: 1rpx solid #e93323;
  border-radius: 32rpx;
  color: #e93323;
}
</style>
