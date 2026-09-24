<template>
  <view class="community-deep-link">
    <view v-if="mode === 'topic'" class="heading">
      <view>
        <text class="eyebrow">话题</text>
        <view class="heading-title"># {{ feed.topicName.value || '加载中' }}</view>
      </view>
      <text v-if="!feed.routeError.value && feed.initialized.value" class="publish-link" @tap="openPublish">去发布</text>
    </view>

    <view v-if="mode === 'search'" class="search-panel">
      <view class="search-row">
        <input v-model="feed.keywordInput.value" class="search-input" type="text" maxlength="100"
          confirm-type="search" placeholder="搜索社区笔记" @confirm="feed.submitSearch" />
        <text class="search-button" @tap="feed.submitSearch">搜索</text>
      </view>
      <scroll-view scroll-x class="topic-scroll" :show-scrollbar="false">
        <view class="topic-row">
          <text class="topic-chip" :class="{ selected: !feed.selectedTopicId.value }" @tap="feed.selectTopic(null)">全部</text>
          <text v-for="topic in feed.topics.value" :key="topic.id" class="topic-chip"
            :class="{ selected: feed.selectedTopicId.value === topic.id }" @tap="feed.selectTopic(topic.id)">
            {{ topic.name }}
          </text>
        </view>
      </scroll-view>
    </view>

    <view v-if="mode === 'video'" class="heading">
      <view>
        <text class="eyebrow">社区视频</text>
        <view class="heading-title">{{ feed.activeVideo.value?.title || '发现短片' }}</view>
      </view>
    </view>

    <view v-if="mode === 'topic' && !feed.routeError.value" class="sort-row">
      <text :class="{ active: feed.order.value === 2 }" @tap="feed.changeOrder(2)">最热</text>
      <text :class="{ active: feed.order.value === 1 }" @tap="feed.changeOrder(1)">最新</text>
    </view>

    <view v-if="feed.routeError.value" class="state-box">
      <text>{{ feed.routeError.value }}</text>
      <text class="retry" @tap="retryRoute">重试</text>
    </view>
    <template v-else>
      <view v-if="mode === 'video' && feed.activeVideo.value" class="video-feature">
        <video v-if="postContentType(feed.activeVideo.value) === 2 && videoSource(feed.activeVideo.value)" class="video-player"
          :src="videoSource(feed.activeVideo.value)" :poster="feed.activeVideo.value.image || ''"
          controls :autoplay="false" />
        <view v-else-if="postContentType(feed.activeVideo.value) === 2" class="video-unavailable">该视频暂不可播放</view>
        <image v-else-if="feed.activeVideo.value.image" class="post-image" :src="feed.activeVideo.value.image" mode="widthFix" />
        <view class="video-copy">
          <view class="video-title">{{ feed.activeVideo.value.title || '社区视频' }}</view>
          <view class="video-description">{{ feed.activeVideo.value.content }}</view>
          <view class="post-meta">❤ {{ feed.activeVideo.value.likeNum }} · 💬 {{ feed.activeVideo.value.commentNum }} · 👁 {{ feed.activeVideo.value.playNum }}</view>
        </view>
      </view>

      <view v-if="feed.posts.value.length" class="post-list">
        <view v-for="post in mode === 'video' ? feed.posts.value.slice(1) : feed.posts.value"
          :key="post.id" class="post-card" @tap="openPost(post)">
          <view class="post-title">
            <text v-if="postContentType(post) === 2" class="video-badge">视频</text>
            {{ post.title || '分享' }}
          </view>
          <view class="post-content">{{ post.content }}</view>
          <image v-if="post.image" class="post-image" :src="post.image" mode="aspectFill" />
          <view class="post-meta">❤ {{ post.likeNum }} · 💬 {{ post.commentNum }} · 👁 {{ post.playNum }}</view>
        </view>
      </view>
      <view v-else-if="feed.initialized.value && !feed.loading.value" class="state-box">{{ emptyText }}</view>
      <view v-if="feed.loading.value" class="state-box">加载中...</view>
      <view v-else-if="feed.error.value" class="state-box">
        <text>{{ feed.error.value }}</text>
        <text class="retry" @tap="feed.loadMore">重试</text>
      </view>
      <view v-else-if="feed.finished.value && feed.posts.value.length > 0" class="end-text">没有更多了</view>
    </template>

    <view v-if="detail" class="detail-mask" @tap="closeDetail">
      <view class="detail-sheet" @tap.stop>
        <scroll-view scroll-y class="detail-scroll">
          <view v-if="detailLoading" class="state-box">加载帖子中...</view>
          <view v-else-if="detailError" class="state-box">{{ detailError }}</view>
          <template v-else>
            <view class="video-title">{{ detail.title || '分享' }}</view>
            <view class="video-description">{{ detail.content }}</view>
            <image v-if="detail.image" class="post-image" :src="detail.image" mode="widthFix" />
            <view class="post-meta">❤ {{ detail.likeNum }} · 💬 {{ detail.commentNum }} · 👁 {{ detail.playNum }}</view>
            <view class="comment-heading">评论</view>
            <view v-for="comment in comments" :key="comment.id" class="comment-row">{{ comment.content }}</view>
            <view v-if="!comments.length" class="comment-row">暂无评论</view>
          </template>
        </scroll-view>
        <text class="detail-close" @tap="closeDetail">关闭</text>
      </view>
    </view>
    <view v-if="publishOpen" class="detail-mask" @tap="closePublish">
      <view class="publish-sheet" @tap.stop>
        <view class="video-title">发布到 # {{ feed.topicName.value }}</view>
        <input v-model="publishTitle" class="publish-input" type="text" maxlength="255" placeholder="标题（选填）" />
        <textarea v-model="publishContent" class="publish-textarea" maxlength="500" placeholder="分享你的内容..." />
        <view class="publish-actions">
          <text @tap="closePublish">取消</text>
          <button class="publish-submit" :loading="publishing" :disabled="publishing" @tap="submitPublish">发布</button>
        </view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { apiCommentList, apiCommunityDetail, apiCommunitySave, communityPreviewMode, type CommunityComment, type CommunityPost } from "@/api/community";
import { useCommunityDeepLink, type CommunityDeepLinkMode, type CommunityRouteQuery } from "@/composables/useCommunityDeepLink";
import { communityVideoSource } from "@/utils/communityMedia";
import { useAuthStore } from "@/stores/auth";

const props = defineProps<{ mode: CommunityDeepLinkMode; query: CommunityRouteQuery; videoRoute?: string }>();
const feed = useCommunityDeepLink(props.mode, props.videoRoute);
const auth = useAuthStore();
const emptyText = computed(() => props.mode === "topic" ? "这个话题还没有内容" : props.mode === "search" ? "没有找到相关笔记" : "还没有视频");
const detail = ref<CommunityPost | null>(null);
const comments = ref<CommunityComment[]>([]);
const detailLoading = ref(false);
const detailError = ref("");
let detailGeneration = 0;
const publishOpen = ref(false);
const publishTitle = ref("");
const publishContent = ref("");
const publishing = ref(false);

function postContentType(post: CommunityPost): number {
  return Number(post.contentType ?? (post as CommunityPost & { content_type?: number }).content_type);
}

function videoSource(post: CommunityPost): string {
  return communityVideoSource(post.videoUrl || post.video_url);
}

async function openPost(post: CommunityPost) {
  if (props.mode === "video") { feed.selectVideo(post); return; }
  if (postContentType(post) === 2) {
    uni.navigateTo({ url: `${props.videoRoute || '/pages/discover/discoverVideo/index'}?id=${post.id}` });
    return;
  }
  const requestGeneration = ++detailGeneration;
  detail.value = post;
  detailLoading.value = true;
  detailError.value = "";
  comments.value = [];
  try {
    const [current, currentComments] = await Promise.all([apiCommunityDetail(post.id), apiCommentList(post.id)]);
    if (requestGeneration === detailGeneration) { detail.value = current; comments.value = currentComments; }
  } catch (cause) {
    if (requestGeneration === detailGeneration) detailError.value = cause instanceof Error ? cause.message : "帖子加载失败";
  } finally {
    if (requestGeneration === detailGeneration) detailLoading.value = false;
  }
}

function closeDetail() { detailGeneration++; detail.value = null; comments.value = []; }

function openPublish() {
  if (!feed.selectedTopicId.value || feed.routeError.value) return;
  if (!auth.isLoggedIn && !communityPreviewMode) {
    uni.navigateTo({ url: "/pages/auth/login" });
    return;
  }
  publishOpen.value = true;
}

function closePublish() { if (!publishing.value) publishOpen.value = false; }

async function submitPublish() {
  if (publishing.value || !publishOpen.value || !feed.selectedTopicId.value) return;
  const content = publishContent.value.trim();
  if (!content) { uni.showToast({ title: "内容不能为空", icon: "none" }); return; }
  publishing.value = true;
  try {
    await apiCommunitySave({
      title: publishTitle.value.trim() || undefined,
      content,
      content_type: 1,
      topic_id: [feed.selectedTopicId.value],
    });
    publishOpen.value = false;
    publishTitle.value = "";
    publishContent.value = "";
    uni.showToast({ title: "发布成功", icon: "success" });
    await feed.initialize(props.query);
  } catch (cause) {
    uni.showToast({ title: cause instanceof Error ? cause.message : "发布失败", icon: "none" });
  } finally {
    publishing.value = false;
  }
}

function retryRoute() { void feed.initialize(props.query); }

onMounted(() => void feed.initialize(props.query));
onBeforeUnmount(() => { closeDetail(); publishOpen.value = false; feed.dispose(); });
defineExpose({ loadMore: feed.loadMore });
</script>

<style scoped>
.community-deep-link { min-height: 100vh; padding: 24rpx; box-sizing: border-box; background: #f5f6f8; }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 20rpx; padding: 22rpx 12rpx 28rpx; }
.eyebrow { color: #e93323; font-size: 23rpx; }
.heading-title { margin-top: 10rpx; color: #222; font-size: 36rpx; font-weight: 700; overflow-wrap: anywhere; }
.publish-link { flex: 0 0 auto; color: #e93323; font-size: 25rpx; padding: 15rpx 20rpx; border: 1rpx solid #e93323; border-radius: 32rpx; }
.search-panel { padding: 8rpx 0 20rpx; }
.search-row { display: flex; align-items: center; gap: 16rpx; }
.search-input { flex: 1; min-width: 0; padding: 18rpx 22rpx; border-radius: 32rpx; background: #fff; font-size: 27rpx; }
.search-button { flex: 0 0 auto; color: #e93323; font-size: 27rpx; padding: 12rpx; }
.topic-scroll { width: 100%; margin-top: 20rpx; }
.topic-row { display: flex; min-width: max-content; gap: 14rpx; }
.topic-chip { padding: 12rpx 20rpx; color: #666; background: #fff; border-radius: 28rpx; font-size: 24rpx; white-space: nowrap; }
.topic-chip.selected { color: #fff; background: #e93323; }
.sort-row { display: flex; gap: 36rpx; padding: 10rpx 14rpx 22rpx; color: #777; font-size: 27rpx; }
.sort-row .active { color: #e93323; font-weight: 700; }
.post-list { display: flex; flex-direction: column; gap: 18rpx; }
.post-card { padding: 24rpx; border-radius: 16rpx; background: #fff; }
.post-title { color: #222; font-size: 29rpx; font-weight: 600; }
.video-badge { margin-right: 8rpx; padding: 3rpx 9rpx; color: #fff; background: #e93323; border-radius: 6rpx; font-size: 20rpx; vertical-align: middle; }
.post-content { margin-top: 12rpx; color: #555; font-size: 25rpx; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.post-image { width: 100%; height: 300rpx; margin-top: 16rpx; border-radius: 12rpx; }
.post-meta { margin-top: 18rpx; color: #999; font-size: 22rpx; }
.state-box { display: flex; flex-direction: column; align-items: center; gap: 16rpx; padding: 80rpx 24rpx; color: #888; text-align: center; font-size: 26rpx; }
.retry { color: #e93323; padding: 14rpx 28rpx; }
.end-text { padding: 30rpx; color: #aaa; text-align: center; font-size: 23rpx; }
.video-feature { margin-bottom: 20rpx; overflow: hidden; background: #fff; border-radius: 18rpx; }
.video-player { width: 100%; height: 520rpx; background: #111; }
.video-unavailable { display: flex; align-items: center; justify-content: center; height: 320rpx; color: #fff; background: #222; font-size: 26rpx; }
.video-copy { padding: 22rpx; }
.video-title { color: #222; font-size: 30rpx; font-weight: 600; }
.video-description { margin-top: 12rpx; color: #555; font-size: 25rpx; line-height: 1.5; }
.detail-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: flex-end; background: rgba(0, 0, 0, .5); }
.detail-sheet { width: 100%; max-height: 82vh; display: flex; flex-direction: column; overflow: hidden; border-radius: 24rpx 24rpx 0 0; background: #fff; }
.detail-scroll { padding: 30rpx; box-sizing: border-box; }
.detail-close { padding: 24rpx; color: #e93323; text-align: center; border-top: 1rpx solid #eee; font-size: 27rpx; }
.comment-heading { margin-top: 28rpx; padding-top: 18rpx; border-top: 1rpx solid #eee; font-size: 26rpx; font-weight: 600; }
.comment-row { padding: 14rpx 0; color: #555; font-size: 24rpx; }
.publish-sheet { width: 100%; padding: 32rpx; box-sizing: border-box; border-radius: 24rpx 24rpx 0 0; background: #fff; }
.publish-input, .publish-textarea { width: 100%; margin-top: 18rpx; padding: 18rpx; box-sizing: border-box; border-radius: 12rpx; background: #f6f6f6; font-size: 26rpx; }
.publish-textarea { height: 220rpx; }
.publish-actions { display: flex; justify-content: flex-end; align-items: center; gap: 24rpx; margin-top: 20rpx; color: #666; font-size: 26rpx; }
.publish-submit { margin: 0; padding: 0 36rpx; color: #fff; background: #e93323; border-radius: 36rpx; font-size: 26rpx; }
</style>
