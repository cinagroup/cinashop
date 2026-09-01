<template>
  <view class="discover">
    <view class="top-bar">
      <text class="top-title">逛逛</text>
      <view class="top-actions">
        <text class="people-btn" @tap="openPeople">好友与关注</text>
        <text class="publish-btn" @tap="openPublish">＋ 发布</text>
      </view>
    </view>

    <scroll-view v-if="highlights.length" scroll-x class="follow-strip" :show-scrollbar="false">
      <view class="follow-row">
        <view
          v-for="item in highlights"
          :key="item.relation_id"
          class="follow-person"
          @tap="openPeople"
        >
          <view class="avatar-wrap">
            <image class="follow-avatar" :src="item.author_image || fallbackAvatar" mode="aspectFill" />
            <view v-if="item.is_new" class="new-dot" />
          </view>
          <text class="follow-name">{{ item.author || "社区用户" }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 帖子列表 -->
    <view v-if="posts.length" class="feed">
      <view v-for="post in posts" :key="post.id" class="post-card" @tap="openDetail(post)">
        <view class="post-title">{{ post.title || "分享" }}</view>
        <view class="post-content">{{ post.content }}</view>
        <image
          v-if="post.image || (post.sliderImage && post.sliderImage.length)"
          class="post-image"
          :src="post.image || (post.sliderImage && post.sliderImage[0]) || placeholder"
          mode="aspectFill"
        />
        <view class="post-meta">
          <text class="meta-item">❤ {{ post.likeNum }}</text>
          <text class="meta-item">💬 {{ post.commentNum }}</text>
          <text class="meta-item">👁 {{ post.playNum }}</text>
          <text class="meta-item time">{{ formatTime(post.addTime) }}</text>
        </view>
      </view>
    </view>
    <view v-else class="empty">还没有帖子, 快来发布第一条吧</view>

    <!-- 发布弹窗 -->
    <view v-if="showPublish" class="mask" @tap="showPublish = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">发布帖子</view>
        <input v-model="publishForm.title" class="sheet-input" type="text" placeholder="标题 (选填)" />
        <textarea
          v-model="publishForm.content"
          class="sheet-textarea"
          placeholder="分享你的内容..."
          :maxlength="500"
        />
        <view class="sheet-btn" @tap="publish">发布</view>
      </view>
    </view>

    <!-- 详情 + 评论弹窗 -->
    <view v-if="detail" class="mask" @tap="closeDetail">
      <view class="detail-sheet" @tap.stop>
        <scroll-view scroll-y class="detail-scroll">
          <view class="detail-title">{{ detail.title || "分享" }}</view>
          <view class="detail-content">{{ detail.content }}</view>
          <view class="detail-meta">
            <text class="like-btn" :class="{ liked: liked }" @tap="like">
              ❤ {{ detail.likeNum }}
            </text>
            <text class="detail-meta-item">💬 {{ detail.commentNum }}</text>
            <text class="detail-meta-item">👁 {{ detail.playNum }}</text>
          </view>
          <view class="comment-section">
            <view class="comment-title">评论 ({{ comments.length }})</view>
            <view v-if="comments.length" class="comment-list">
              <view v-for="c in comments" :key="c.id" class="comment-item">
                <text class="comment-content">{{ c.content }}</text>
                <text class="comment-time">{{ formatTime(c.addTime) }}</text>
              </view>
            </view>
            <view v-else class="comment-empty">暂无评论</view>
          </view>
        </scroll-view>
        <view class="comment-bar">
          <input
            v-model="commentText"
            class="comment-input"
            type="text"
            placeholder="说点什么..."
            confirm-type="send"
            @confirm="sendComment"
          />
          <text class="send-btn" @tap="sendComment">发送</text>
        </view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { onShow } from "@dcloudio/uni-app";
import {
  apiCommunityList,
  apiCommunityLike,
  apiCommunitySave,
  apiCommentList,
  apiCommentSave,
  apiCommunityFollowHighlights,
  communityPreviewMode,
  type CommunityPost,
  type CommunityComment,
} from "@/api/community";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const posts = ref<CommunityPost[]>([]);
const detail = ref<CommunityPost | null>(null);
const comments = ref<CommunityComment[]>([]);
const liked = ref(false);
const commentText = ref("");
const showPublish = ref(false);
const publishForm = ref({ title: "", content: "" });
const highlights = ref<Awaited<ReturnType<typeof apiCommunityFollowHighlights>>>([]);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
const fallbackAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Ccircle cx='36' cy='36' r='36' fill='%23eceff3'/%3E%3Ccircle cx='36' cy='28' r='12' fill='%23c8cdd5'/%3E%3Cpath d='M13 66c3-14 11-22 23-22s20 8 23 22' fill='%23c8cdd5'/%3E%3C/svg%3E";

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  try {
    posts.value = await apiCommunityList();
  } catch {
    posts.value = [];
  }
  if (authStore.isLoggedIn || communityPreviewMode) {
    try {
      highlights.value = await apiCommunityFollowHighlights();
    } catch {
      highlights.value = [];
    }
  } else {
    highlights.value = [];
  }
}

function requireLogin(): boolean {
  if (authStore.isLoggedIn || communityPreviewMode) return true;
  uni.navigateTo({ url: "/pages/auth/login" });
  return false;
}

function openPublish() {
  if (!requireLogin()) return;
  showPublish.value = true;
}

function openPeople() {
  if (!requireLogin()) return;
  uni.navigateTo({ url: "/pages/discover/people" });
}

async function publish() {
  if (!publishForm.value.content.trim()) {
    return uni.showToast({ title: "内容不能为空", icon: "none" });
  }
  try {
    await apiCommunitySave({
      title: publishForm.value.title.trim() || undefined,
      content: publishForm.value.content.trim(),
      content_type: 1,
    });
    uni.showToast({ title: "发布成功", icon: "success" });
    showPublish.value = false;
    publishForm.value = { title: "", content: "" };
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "发布失败", icon: "none" });
  }
}

async function openDetail(post: CommunityPost) {
  detail.value = post;
  liked.value = false;
  try {
    comments.value = await apiCommentList(post.id);
  } catch {
    comments.value = [];
  }
}

function closeDetail() {
  detail.value = null;
}

async function like() {
  if (!requireLogin() || !detail.value) return;
  try {
    const res = await apiCommunityLike(detail.value.id);
    detail.value.likeNum = res.likeNum;
    liked.value = true;
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "点赞失败", icon: "none" });
  }
}

async function sendComment() {
  if (!requireLogin() || !detail.value) return;
  const text = commentText.value.trim();
  if (!text) return uni.showToast({ title: "请输入评论内容", icon: "none" });
  try {
    await apiCommentSave(detail.value.id, text);
    uni.showToast({ title: "评论成功", icon: "success" });
    commentText.value = "";
    comments.value = await apiCommentList(detail.value.id);
    if (detail.value) detail.value.commentNum = comments.value.length;
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "评论失败", icon: "none" });
  }
}

onShow(load);
onMounted(load);
</script>

<style scoped>
.discover {
  padding: 20rpx;
}

.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20rpx;
}

.top-title {
  font-size: 36rpx;
  font-weight: 700;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 14rpx;
}

.people-btn {
  color: #555;
  font-size: 24rpx;
  padding: 9rpx 10rpx;
}

.publish-btn {
  color: #e93323;
  font-size: 26rpx;
  border: 2rpx solid #e93323;
  border-radius: 28rpx;
  padding: 8rpx 24rpx;
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.follow-strip {
  width: 100%;
  margin-bottom: 20rpx;
  border-radius: 16rpx;
  background: #fff;
}

.follow-row {
  display: flex;
  gap: 24rpx;
  min-width: max-content;
  padding: 20rpx 24rpx;
}

.follow-person {
  width: 92rpx;
  text-align: center;
}

.avatar-wrap {
  position: relative;
  width: 72rpx;
  height: 72rpx;
  margin: 0 auto;
}

.follow-avatar {
  width: 72rpx;
  height: 72rpx;
  border-radius: 50%;
  background: #f0f1f3;
}

.new-dot {
  position: absolute;
  top: 0;
  right: 0;
  width: 15rpx;
  height: 15rpx;
  border: 3rpx solid #fff;
  border-radius: 50%;
  background: #e93323;
}

.follow-name {
  display: block;
  overflow: hidden;
  margin-top: 8rpx;
  color: #666;
  font-size: 20rpx;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.post-title {
  font-size: 30rpx;
  font-weight: 600;
  color: #333;
}

.post-content {
  font-size: 26rpx;
  color: #555;
  margin-top: 10rpx;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.post-image {
  width: 100%;
  height: 320rpx;
  border-radius: 12rpx;
  margin-top: 16rpx;
  background: #f7f7f7;
}

.post-meta {
  display: flex;
  gap: 24rpx;
  margin-top: 16rpx;
}

.meta-item {
  font-size: 22rpx;
  color: #999;
}

.meta-item.time {
  margin-left: auto;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  z-index: 99;
}

.sheet {
  width: 100%;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  box-sizing: border-box;
}

.sheet-title {
  font-size: 30rpx;
  font-weight: 600;
  text-align: center;
  margin-bottom: 24rpx;
}

.sheet-input {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  margin-bottom: 16rpx;
}

.sheet-textarea {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  width: 100%;
  height: 220rpx;
  box-sizing: border-box;
}

.sheet-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 12rpx;
  padding: 22rpx 0;
  font-size: 28rpx;
  margin-top: 10rpx;
}

.detail-sheet {
  width: 100%;
  max-height: 85vh;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-scroll {
  max-height: 60vh;
  padding: 30rpx;
  box-sizing: border-box;
}

.detail-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #333;
}

.detail-content {
  font-size: 27rpx;
  color: #444;
  margin-top: 14rpx;
  line-height: 1.6;
}

.detail-meta {
  display: flex;
  gap: 24rpx;
  margin-top: 20rpx;
  padding-bottom: 16rpx;
  border-bottom: 1rpx solid #f0f0f0;
}

.like-btn {
  font-size: 26rpx;
  color: #666;
}

.like-btn.liked {
  color: #e93323;
}

.detail-meta-item {
  font-size: 26rpx;
  color: #666;
}

.comment-section {
  margin-top: 20rpx;
}

.comment-title {
  font-size: 26rpx;
  font-weight: 600;
  margin-bottom: 12rpx;
}

.comment-item {
  padding: 14rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.comment-content {
  font-size: 25rpx;
  color: #333;
}

.comment-time {
  font-size: 20rpx;
  color: #bbb;
  margin-left: 12rpx;
}

.comment-empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 30rpx 0;
}

.comment-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 30rpx;
  border-top: 1rpx solid #f0f0f0;
  background: #fff;
}

.comment-input {
  flex: 1;
  background: #f7f7f7;
  border-radius: 30rpx;
  padding: 16rpx 24rpx;
  font-size: 26rpx;
}

.send-btn {
  color: #e93323;
  font-size: 28rpx;
}
</style>
