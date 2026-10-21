<template>
  <ThemePage>
  <view class="discover">
    <view v-if="availability.closed.value && routeError" class="community-route-error" role="alert">{{ routeError }}</view>
    <CommunityAvailability :closed="availability.closed.value" :checking="availability.checking.value" :message="availability.message.value" @retry="recoverCommunity" />
    <view v-show="availability.allowed.value">
    <view v-if="!authorMode" class="top-bar">
      <text class="top-title">逛逛</text>
      <view class="top-actions">
        <text class="people-btn" @tap="openSearch">搜索</text>
        <text class="people-btn" @tap="openVideo">视频</text>
        <text class="people-btn" @tap="openPeople">好友与关注</text>
        <text class="people-btn" @tap="openAuthor(authStore.uid)">我的主页</text>
        <text class="publish-btn" @tap="openPublish">＋ 发布</text>
      </view>
    </view>

    <template v-if="!authorMode">
    <scroll-view v-if="topics.length" scroll-x class="topic-strip" :show-scrollbar="false">
      <view class="topic-row">
        <text v-for="topic in topics" :key="topic.id" class="topic-chip" @tap="openTopic(topic.id)">
          # {{ topic.name }}
        </text>
      </view>
    </scroll-view>

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

    <view v-if="home.error.value || routeError" class="publish-error" role="alert">{{ routeError || home.error.value }}</view>
    <button v-if="home.error.value" :disabled="home.loading.value" @tap="load">重试帖子列表</button>
    <!-- 帖子列表 -->
    <view v-if="posts.length" class="feed">
      <view v-for="post in posts" :key="post.id" class="post-card" @tap="openDetail(post)">
        <view class="post-title">{{ post.title || "分享" }}</view>
        <view class="post-content">{{ post.content }}</view>
        <image
          v-if="post.image || (post.sliderImage && post.sliderImage.length)"
          class="post-image"
          :src="communityVideoSource(post.image || post.sliderImage?.[0]) || placeholder"
          mode="aspectFill"
        />
        <text v-if="post.contentType === 2" class="upload-hint">▶ 视频 · 点击查看</text>
        <view class="post-meta">
          <text class="meta-item">❤ {{ post.likeNum }}</text>
          <text class="meta-item">💬 {{ post.commentNum }}</text>
          <text class="meta-item">👁 {{ post.playNum }}</text>
          <text class="meta-item time">{{ formatTime(post.addTime) }}</text>
        </view>
        <CommunityPostActions :post="engagement.view(post)" :busy="engagement.busy.value" :unknown="engagement.unknown(post.id)"
          :refreshing="engagement.reconciling.value === post.id" :notice="engagement.notices.value[post.id]" :error="engagement.errors.value[post.id]"
          @like="engagement.toggleLike(post)" @share="engagement.openShare(post)" @refresh="engagement.reconcile(post.id)" />
      </view>
    </view>
    <view v-else class="empty">还没有帖子, 快来发布第一条吧</view>
    </template>
    <view v-else class="author-page">
      <view class="author-heading">
        <text class="top-title">{{ authorProfile?.author || '作者主页' }}</text>
        <button @tap="author.refresh" :disabled="authorBusy || authorLoading">刷新主页</button>
      </view>
      <view v-if="authorError" class="publish-error" role="status">{{ authorError }}</view>
      <button v-if="!authStore.isLoggedIn" @tap="requireLogin">登录</button>
      <view v-if="authorProfile" class="author-profile">
        <image v-if="communityVideoSource(authorProfile.author_image)" class="follow-avatar" :src="communityVideoSource(authorProfile.author_image)" mode="aspectFill" />
        <text>ID：{{ authorProfile.relation_id }}</text>
        <text v-if="authorProfile.level_name">{{ authorProfile.level_name }}</text>
        <text v-if="authorProfile.vip_status">付费会员</text>
        <view class="author-description">{{ authorProfile.desc || '还没有填写简介' }}</view>
        <view class="author-stats">
          <text @tap="openSocial('follow')">关注 {{ authorProfile.follow_num }}</text>
          <text @tap="openSocial('friend')">好友 {{ authorProfile.friend_count }}</text>
          <text @tap="openSocial('fans')">粉丝 {{ authorProfile.fans_num }}</text>
          <text>获赞 {{ authorProfile.like_num }}</text>
        </view>
        <template v-if="authorIsSelf">
          <button :disabled="authorBusy || authorUnknown" @tap="author.beginDescription">编辑简介</button>
          <view v-if="editingDescription" class="description-editor">
            <textarea v-model="authorDescription" :maxlength="50" :disabled="authorBusy" placeholder="个人简介，最多50个字符" />
            <button :disabled="authorBusy" @tap="author.saveDescription">保存简介</button>
            <button :disabled="authorBusy" @tap="editingDescription = false">取消修改简介</button>
          </view>
          <button @tap="openPublish">发布新帖</button>
          <view class="source-tabs">
            <button :class="{ chosen: authorTab === 'works' }" :disabled="authorBusy" @tap="author.changeTab('works')">作品</button>
            <button :class="{ chosen: authorTab === 'liked' }" :disabled="authorBusy" @tap="author.changeTab('liked')">赞过</button>
          </view>
        </template>
        <template v-else>
          <button :disabled="authorBusy || authorUnknown" @tap="author.toggleFollow">{{ unfollowPending ? '确认取消关注' : authorProfile.is_follow ? '已关注' : '关注作者' }}</button>
          <button v-if="unfollowPending" :disabled="authorBusy" @tap="unfollowPending = false">保留关注</button>
        </template>
        <input v-model="authorKeyword" :maxlength="100" class="sheet-input" placeholder="搜索作品" @confirm="author.refresh" />
        <button :disabled="authorBusy" @tap="author.refresh">搜索作品</button>
      </view>
      <view v-if="authorLoading" class="upload-hint">加载中…</view>
      <view v-for="post in authorPosts" :key="post.id" class="post-card author-post">
        <view @tap="openDetail(post)">
          <view class="post-title">{{ post.title || '分享' }}</view>
          <view class="post-content">{{ post.content }}</view>
          <text class="post-status">{{ moderationText(post) }}</text>
          <view v-if="author.owns(post) && post.refusal" class="publish-error">{{ post.refusal }}</view>
          <image v-if="communityVideoSource(post.image)" class="post-image" :src="communityVideoSource(post.image)" mode="aspectFill" />
        </view>
        <CommunityPostActions :post="engagement.view(post)" :busy="engagement.busy.value" :unknown="engagement.unknown(post.id)"
          :refreshing="engagement.reconciling.value === post.id" :notice="engagement.notices.value[post.id]" :error="engagement.errors.value[post.id]"
          @like="engagement.toggleLike(post)" @share="engagement.openShare(post)" @refresh="engagement.reconcile(post.id)" />
        <view v-if="author.owns(post)" class="author-controls">
          <button :disabled="authorBusy || authorUnknown" @tap="editPost(post.id)">编辑帖子 {{ post.id }}</button>
          <button v-if="deletePostId !== post.id" :disabled="authorBusy || authorUnknown" @tap="author.requestDelete(post)">删除帖子 {{ post.id }}</button>
          <template v-else>
            <text>删除《{{ post.title || '分享' }}》后将不再展示。</text>
            <button :disabled="authorBusy" @tap="author.confirmDelete">确认删除帖子 {{ post.id }}</button>
            <button :disabled="authorBusy" @tap="author.cancelDelete">保留帖子</button>
          </template>
        </view>
      </view>
      <view v-if="!authorLoading && authorProfile && !authorPosts.length" class="empty">暂无内容</view>
      <button v-if="authorHasMore" :disabled="authorLoading || authorBusy" @tap="author.loadMore">加载更多作品</button>
    </view>

    <!-- 发布弹窗 -->
    <view v-if="showPublish" class="mask" @tap="closePublish">
      <view class="sheet publish-sheet" @tap.stop>
        <template v-if="!relationPanel">
        <view class="sheet-title">{{ publishEditRequested ? '编辑帖子' : '发布帖子' }}</view>
        <view v-if="publishLoadingEdit" class="upload-hint">正在加载原帖…</view>
        <button v-if="publishEditRequested && !publishEditId && !publishLoadingEdit" @tap="publisher.loadForEdit(publishEditRequested)">重新加载原帖</button>
        <input v-model="publishTitle" :disabled="publishLocked" :maxlength="255" class="sheet-input" type="text" placeholder="标题 (选填)" />
        <textarea
          v-model="publishContent" :disabled="publishLocked"
          class="sheet-textarea"
          placeholder="分享你的内容..."
          :maxlength="500"
        />
        <view v-if="!videoWanted" class="photo-upload">
          <text class="upload-hint">照片 {{ publishImages.length }}/9 · 每张最大 10 MiB，第一张为封面</text>
          <view class="photo-grid">
            <view v-for="(photo, index) in publishImages" :key="photo.url" class="photo-item">
              <image :src="communityVideoSource(photo.src)" mode="aspectFill" />
              <text v-if="index === 0" class="photo-cover-label">封面</text>
              <button :disabled="publishLocked" @tap="removeImage(index)">移除照片 {{ index + 1 }}</button>
            </view>
          </view>
          <button v-if="publishImages.length < 9" :disabled="publishLocked" @tap="chooseImages">添加照片</button>
          <button v-if="publishImages.length || imageUploadFailed" :disabled="publishLocked" @tap="clearImages">移除全部照片</button>
        </view>
        <view class="video-upload">
          <text class="upload-hint">MP4 视频，最大 50 MiB</text>
          <button v-if="!publishVideo && !publishImages.length" :disabled="publishLocked || imageUploadFailed" @tap="chooseVideo">{{ publishBusy ? '上传中…' : publishChoosing ? '选择中…' : '选择视频' }}</button>
          <button v-if="videoWanted && !publishVideo && !publishBusy" :disabled="publishLocked" @tap="removeVideo">取消视频，改发文字</button>
          <template v-if="publishVideo">
            <video class="community-video" :src="communityVideoSource(publishVideo.src)" controls :autoplay="false" />
            <text class="upload-hint">已上传：{{ publishVideo.name }}</text>
            <button :disabled="publishLocked" @tap="removeVideo">移除视频</button>
            <image v-if="publishCover" class="video-cover" :src="communityVideoSource(publishCover.src)" mode="aspectFit" />
            <button :disabled="publishLocked" @tap="chooseCover">{{ publishCover ? '更换视频封面' : '添加视频封面' }}</button>
            <button v-if="publishCover || imageUploadFailed" :disabled="publishLocked" @tap="removeCover">移除视频封面</button>
          </template>
        </view>
        <view class="selected-relations">
          <button :disabled="publishLocked" @tap="relations.openTopics">选择话题（{{ selectedTopics.length }}/5）</button>
          <button v-for="topic in selectedTopics" :key="topic.id" :disabled="publishLocked" @tap="relations.removeTopic(topic.id)">移除话题：{{ topic.name }}</button>
          <button :disabled="publishLocked" @tap="relations.openProducts">添加商品（{{ selectedProducts.length }}/5）</button>
          <button v-for="product in selectedProducts" :key="product.product_id" :disabled="publishLocked" @tap="relations.removeProduct(product.product_id)">移除商品：{{ product.store_name }}</button>
        </view>
        <view v-if="publishError" class="publish-error" role="status">{{ publishError }}</view>
        <button class="sheet-btn" :disabled="publishLocked || !!publishEditRequested && !publishEditId" @tap="publish">{{ publishBusy ? '处理中…' : publishEditRequested ? '提交修改' : '发布' }}</button>
        <button v-if="publishEditRequested" :disabled="publishLocked" @tap="cancelEdit">取消编辑</button>
        <button v-if="publishUnknown" :disabled="publishBusy" @tap="endUnknownPublish">{{ publishEditRequested ? '结束本次编辑并刷新作品' : '结束本次发布并刷新帖子' }}</button>
        <button v-else :disabled="publishBusy || publishChoosing" @tap="closePublish">稍后发布</button>
        </template>
        <view v-else class="relation-panel">
          <view class="sheet-title">{{ relationPanel === 'topics' ? '参与话题' : '添加商品' }}</view>
          <view v-if="relationPanel === 'products'" class="source-tabs">
            <button v-for="tab in productSources" :key="tab.key" :class="{ chosen: productSource === tab.key }" @tap="relations.changeSource(tab.key)">{{ tab.label }}</button>
          </view>
          <input v-model="relationKeyword" class="sheet-input" :maxlength="100" :placeholder="relationPanel === 'topics' ? '搜索话题' : '搜索商品'" @confirm="relationPanel === 'products' && relations.loadProducts(true)" />
          <button v-if="relationPanel === 'products'" @tap="relations.loadProducts(true)">搜索商品</button>
          <view v-if="relationLoading" class="upload-hint">加载中…</view>
          <view v-if="relationError" class="publish-error" role="status">{{ relationError }}</view>
          <button v-if="relationError && relationPanel === 'topics'" @tap="relations.loadTopics">重试话题</button>
          <button v-if="pendingTopic" @tap="relations.discardPendingTopic">不参与原话题</button>
          <template v-if="relationPanel === 'topics'">
            <button v-for="topic in relationTopics" :key="topic.id" :disabled="relationLoading"
              :class="{ chosen: selectedTopics.some(item => item.id === topic.id) }" @tap="relations.toggleTopic(topic)">
              {{ selectedTopics.some(item => item.id === topic.id) ? '已选 · ' : '' }}{{ topic.name }}
            </button>
            <view v-if="!relationLoading && !relationTopics.length" class="upload-hint">暂无匹配话题</view>
          </template>
          <template v-else>
            <button v-for="product in relationProducts" :key="product.product_id" class="related-product" :disabled="relationLoading"
              :class="{ chosen: selectedProducts.some(item => item.product_id === product.product_id) }" @tap="relations.toggleProduct(product)">
              <image v-if="communityVideoSource(product.image)" :src="communityVideoSource(product.image)" mode="aspectFill" />
              <view>{{ selectedProducts.some(item => item.product_id === product.product_id) ? '已选 · ' : '' }}{{ product.store_name }}<text>¥{{ product.price }}</text></view>
            </button>
            <view v-if="!relationLoading && !relationProducts.length" class="upload-hint">暂无匹配商品</view>
            <button v-if="relationError" :disabled="relationLoading" @tap="relations.loadProducts(relationProducts.length === 0)">重试商品</button>
            <button v-else-if="relationHasMore" :disabled="relationLoading" @tap="relations.loadProducts()">加载更多商品</button>
          </template>
          <button @tap="relations.close">完成选择</button>
        </view>
      </view>
    </view>

    <!-- 详情 + 评论弹窗 -->
    <view v-show="detailOpen" class="mask" @tap="closeDetail">
      <view class="detail-sheet" @tap.stop>
        <scroll-view scroll-y class="detail-scroll">
          <button @tap="closeDetail">{{ authorMode ? "返回作品" : "关闭详情" }}</button>
          <view v-if="detailLoading" class="upload-hint">正在打开帖子…</view>
          <view v-if="detailError" class="publish-error" role="alert">{{ detailError }}</view>
          <button v-if="detailError" @tap="openDetail(detailRequested)">重新打开帖子</button>
          <template v-if="detail && !detailLoading && !detailError">
          <view class="detail-title">{{ detail.title || "分享" }}</view>
          <view class="detail-content">{{ detail.content }}</view>
          <view class="post-status">{{ moderationText(detail) }}</view>
          <view v-if="detail.is_self && detail.refusal" class="publish-error">{{ detail.refusal }}</view>
          <button v-if="detail.type === 2" @tap="openAuthor(detail.relationId)">查看作者主页</button>
          <button v-if="detail.is_self === 1 && detail.type === 2 && detail.relationId === authStore.uid" @tap="editPost(detail.id)">编辑这篇帖子</button>
          <view v-if="detail.topic?.length" class="selected-relations">
            <button v-for="topic in detail.topic" :key="topic.id" @tap="openTopic(topic.id)"># {{ topic.name }}</button>
          </view>
          <view v-if="detail.product?.length" class="detail-products">
            <text class="upload-hint">相关商品 · 当前价格</text>
            <button v-for="product in detail.product" :key="product.id" class="related-product" @tap="openRelatedProduct(product.id)">
              <image v-if="communityVideoSource(product.image)" :src="communityVideoSource(product.image)" mode="aspectFill" />
              <view>{{ product.store_name }}<text>¥{{ product.price }}</text></view>
            </button>
          </view>
          <view v-if="detail.contentType === 1 && detailImages.length" class="detail-gallery">
            <image v-for="(source, index) in detailImages" :key="source" :src="source" mode="widthFix"
              @tap="previewImage(index)" @error="imageLoadFailed = true" />
          </view>
          <view v-if="imageLoadFailed" class="publish-error">图片暂时无法显示，可重新加载。</view>
          <button v-if="imageLoadFailed" @tap="reloadVideo">重新加载图片</button>
          <video v-if="detail.contentType === 2 && communityVideoSource(detail.videoUrl || detail.video_url)"
            class="community-video" :src="communityVideoSource(detail.videoUrl || detail.video_url)"
            :poster="communityVideoSource(detail.image)" controls :autoplay="false"
            @error="videoFailed = true" />
          <view v-if="videoFailed" class="publish-error">视频暂时无法播放，可重新加载。</view>
          <button v-if="videoFailed" @tap="reloadVideo">重新加载视频</button>
          <view class="detail-meta">
            <text>❤ {{ detail.likeNum }}</text>
            <text class="detail-meta-item">💬 {{ detail.commentNum }}</text>
            <text class="detail-meta-item">👁 {{ detail.playNum }}</text>
          </view>
          <CommunityPostActions :post="engagement.view(detail)" :busy="engagement.busy.value" :unknown="engagement.unknown(detail.id)"
            :refreshing="engagement.reconciling.value === detail.id" :notice="engagement.notices.value[detail.id]" :error="engagement.errors.value[detail.id]"
            @like="engagement.toggleLike(detail)" @share="engagement.openShare(detail)" @refresh="engagement.reconcile(detail.id)" />
          </template>
          <CommunityComments :post-id="detailLoading || detailError ? 0 : detail?.id ?? 0" :total="detail?.commentNum ?? 0" :writable="detail?.status === 1 && detail?.is_verify === 1" @count="updateCommentCount" />
        </scroll-view>
      </view>
    </view>
    </view>
  </view>
  <CommunitySharePanel :controller="engagement" />
  <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import CommunityAvailability from '@/components/community/CommunityAvailability.vue';
import { useCommunityAvailability } from '@/utils/communityAvailability';
import ThemePage from '@/components/ThemePage.vue';
import CommunityComments from '@/components/community/CommunityComments.vue';
import CommunityPostActions from '@/components/community/CommunityPostActions.vue';
import CommunitySharePanel from '@/components/community/CommunitySharePanel.vue';
import { useCommunityEngagement } from '@/composables/useCommunityEngagement';
import { useCommunityHomeFeed } from '@/composables/useCommunityHomeFeed';
import { useShareReferral } from '@/composables/useShareReferral';
import { communityPageQuery, communityInbound, communitySharePath } from '@/utils/communityShare';
import { computed, ref, watch } from "vue";
import { useCommunityPublish } from "@/composables/useCommunityPublish";
import { useCommunityAuthor } from "@/composables/useCommunityAuthor";
import { communityVideoSource } from "@/utils/communityMedia";
import { onLoad, onShow, onHide, onUnload, onShareAppMessage, onShareTimeline } from "@dcloudio/uni-app";
import {
  apiCommunityVisit,
  apiCommunityState,
  communityPreviewMode,
  type CommunityPost,
} from "@/api/community";
import { useAuthStore } from "@/stores/auth";

import { parseCommunityWorkspaceEntry, type CommunityWorkspaceEntry } from "@/utils/communityEntry";

const availability = useCommunityAvailability();
const authStore = useAuthStore();
const authorMode = ref(false), routeError = ref('');
const engagement = useCommunityEngagement({
  update(id, patch) {
    for (const list of [posts.value, authorPosts.value]) for (const post of list) if (post.id === id) Object.assign(post, patch);
    if (detail.value?.id === id) Object.assign(detail.value, patch);
  },
  liked() { if (authorMode.value && authorProfile.value && !authorBusy.value) void author.refresh(); },
  find(id) { return id === undefined ? detail.value : [detail.value, ...posts.value, ...authorPosts.value].find(post => post?.id === id) ?? null; },
});
const home = useCommunityHomeFeed(engagement, () => !authorMode.value && !routeError.value);
const { posts, topics, highlights } = home;
const referrals = useShareReferral();
const author = useCommunityAuthor(engagement);
const { profile: authorProfile, posts: authorPosts, tab: authorTab, keyword: authorKeyword,
  description: authorDescription, editingDescription, loading: authorLoading, busy: authorBusy, error: authorError,
  unknown: authorUnknown, hasMore: authorHasMore, isSelf: authorIsSelf, deleteId: deletePostId, unfollow: unfollowPending } = author;
const detail = ref<CommunityPost | null>(null), detailOpen = ref(false), detailLoading = ref(false), detailError = ref('');
const detailRequested = ref(0);
let pageVisible = true, pageDisposed = false, resumeDetail = 0;
let entryState: CommunityWorkspaceEntry | undefined;
const pageOwner = () => `${authStore.uid}:${authStore.token}:${authStore.sessionVersion}`;
const showPublish = ref(false);
const publisher = useCommunityPublish();
const { editId: publishEditId, editRequested: publishEditRequested, loadingEdit: publishLoadingEdit } = publisher;
const relations = publisher.relations;
const { panel: relationPanel, availableTopics: relationTopics, products: relationProducts, selectedTopics, selectedProducts,
  keyword: relationKeyword, source: productSource, loading: relationLoading, error: relationError, hasMore: relationHasMore, pendingTopic } = relations;
const productSources = [{ key: "pay" as const, label: "已购" }, { key: "collect" as const, label: "收藏" }, { key: "visit" as const, label: "浏览" }];
const { title: publishTitle, content: publishContent, video: publishVideo, busy: publishBusy,
  choosing: publishChoosing, locked: publishLocked, unknown: publishUnknown, error: publishError,
  images: publishImages, cover: publishCover, imageFailed: imageUploadFailed,
  chooseImages, chooseCover, removeImage, clearImages, removeCover, videoWanted, chooseVideo, removeVideo } = publisher;
const videoFailed = ref(false);
const imageLoadFailed = ref(false);
const detailImages = computed(() => (detail.value?.sliderImage?.length
  ? detail.value.sliderImage : detail.value?.image ? [detail.value.image] : []).map(communityVideoSource).filter(Boolean));
function previewImage(index: number) {
  if (detailImages.value[index]) uni.previewImage({ current: index, urls: detailImages.value });
}
let detailGeneration = 0;
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
const fallbackAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Ccircle cx='36' cy='36' r='36' fill='%23eceff3'/%3E%3Ccircle cx='36' cy='28' r='12' fill='%23c8cdd5'/%3E%3Cpath d='M13 66c3-14 11-22 23-22s20 8 23 22' fill='%23c8cdd5'/%3E%3C/svg%3E";

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  if (!availability.allowed.value || !pageVisible || pageDisposed || routeError.value) return;
  if (authorMode.value) { if (!authorLoading.value) await author.refresh(); return; }
  await home.load();
}

function requireLogin(): boolean {
  if (availability.closed.value) return false;
  if (authStore.isLoggedIn || communityPreviewMode) return true;
  uni.navigateTo({ url: "/pages/auth/login" });
  return false;
}

function openPublish() {
  if (!availability.allowed.value || !pageVisible || pageDisposed || routeError.value || !requireLogin()) return;
  if (publishEditRequested.value && !publisher.reset()) return;
  showPublish.value = true;
}
function openAuthor(id: number) {
  if (!requireLogin() || !Number.isSafeInteger(id) || id < 0) return;
  uni.navigateTo({ url: `/pages/discover/workspace?author_id=${id}` });
}
function openSocial(tab: string) {
  if (authorIsSelf.value && ["friend", "follow", "fans"].includes(tab)) uni.navigateTo({ url: `/pages/discover/people?tab=${tab}` });
}
function moderationText(post: CommunityPost) {
  if (post.is_verify === -2 || post.status === 0) return "已下架，仅自己可见";
  if (post.is_verify === -1) return "审核未通过，仅自己可见";
  if (post.is_verify === 0) return "正在审核，仅自己可见";
  return "已公开";
}
async function editPost(id: number) {
  if (!requireLogin() || publishLocked.value) return;
  closeDetail(); showPublish.value = true;
  await publisher.loadForEdit(id);
}
function cancelEdit() { if (publisher.reset()) showPublish.value = false; }

function openPeople() {
  if (!requireLogin()) return;
  uni.navigateTo({ url: "/pages/discover/people" });
}

function openTopic(id: number) {
  uni.navigateTo({ url: `/pages/discover/discoverTopic/index?id=${id}` });
}
function openRelatedProduct(id: number) {
  if (Number.isSafeInteger(id) && id > 0 && detail.value?.product?.some(product => product.id === id)) {
    uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
  }
}

function openSearch() {
  uni.navigateTo({ url: "/pages/discover/discoverSearch/index" });
}

function openVideo() {
  uni.navigateTo({ url: "/pages/discover/discoverVideo/index" });
}

function closePublish() {
  if (!publishBusy.value && !publishChoosing.value && !publishLoadingEdit.value) { relations.close(); showPublish.value = false; }
}
function endUnknownPublish() {
  if (publisher.reset()) { showPublish.value = false; void load(); }
}
async function publish() {
  const owner = pageOwner(), revision = detailGeneration;
  const current = () => pageVisible && !pageDisposed && owner === pageOwner() && revision === detailGeneration;
  const id = await publisher.publish();
  if (!id || !current()) return;
  uni.showToast({ title: "已提交，请以审核结果为准", icon: "none" });
  publisher.reset(); showPublish.value = false;
  await load();
  if (!current()) return;
  await openDetail(id);
}
async function reloadVideo() {
  const id = detail.value?.id, revision = detailGeneration, owner = pageOwner(), ticket = engagement.nextTicket();
  if (!id || !pageVisible || pageDisposed) return;
  try { const post = await apiCommunityState(id);
    if (pageVisible && !pageDisposed && owner === pageOwner() && revision === detailGeneration && detail.value?.id === id) {
      detail.value = engagement.adopt([post], ticket)[0]; videoFailed.value = false; imageLoadFailed.value = false;
    }
  } catch { if (pageVisible && !pageDisposed && owner === pageOwner() && revision === detailGeneration) detailError.value = '媒体暂时无法加载，请重试'; }
}

async function openDetail(post: CommunityPost | number) {
  const id = typeof post === 'number' ? post : post.id;
  if (!availability.allowed.value || !pageVisible || pageDisposed || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) return;
  if (detailOpen.value && detailRequested.value === id && !detailError.value) return;
  resumeDetail = 0;
  const revision = ++detailGeneration, owner = pageOwner(), ticket = engagement.nextTicket();
  detailRequested.value = id; detailOpen.value = true; detail.value = null;
  detailLoading.value = true; detailError.value = ''; videoFailed.value = false; imageLoadFailed.value = false;
  engagement.closeShare();
  const current = () => pageVisible && !pageDisposed && owner === pageOwner() && revision === detailGeneration;
  try { const fresh = await apiCommunityVisit(id); if (current()) detail.value = engagement.adopt([fresh], ticket)[0]; }
  catch (reason) { if (current()) detailError.value = reason instanceof Error ? reason.message : '帖子无法打开'; }
  finally { if (current()) detailLoading.value = false; }
}

function closeDetail() {
  detailGeneration++;
  detail.value = null; detailOpen.value = false; detailLoading.value = false; detailError.value = ''; detailRequested.value = 0;
  engagement.closeShare();
}

async function initializePublisher(entry: Extract<CommunityWorkspaceEntry, { kind: 'publish' }>) {
  if (availability.closed.value) return;
  const owner = pageOwner(), revision = detailGeneration;
  const current = () => pageVisible && !pageDisposed && !routeError.value && owner === pageOwner() && revision === detailGeneration;
  // A fresh guest has no prior availability observation. Validate the route
  // first, then check the public config before choosing a login destination.
  if (!authStore.isLoggedIn && !communityPreviewMode) {
    if (!await availability.refresh() || !current()) return;
  }
  if (!current() || availability.closed.value) return;
  if (entry.editId) await editPost(entry.editId);
  else if (requireLogin()) {
    showPublish.value = true;
    if (entry.topicId) await relations.seedTopic(entry.topicId);
  }
}

onLoad((input) => {
  let query: Record<string, string | undefined>, entry: CommunityWorkspaceEntry;
  try {
    query = communityPageQuery(input ?? {});
    entry = parseCommunityWorkspaceEntry(query); entryState = entry;
    const incoming = communityInbound('/pages/discover/workspace', query);
    referrals.captureInbound({ path: 'pages/discover/workspace', query });
    if (incoming && (query.post_id !== undefined || query.post_type !== undefined) && incoming.contentType === 2) {
      uni.redirectTo({ url: communitySharePath(incoming.id, 2, incoming.spid) }); return;
    }
    if (incoming) {
      if (availability.closed.value) resumeDetail = incoming.id;
      else void openDetail(incoming.id);
    }
  } catch (reason) { routeError.value = reason instanceof Error ? reason.message : '社区地址无效'; return; }
  if (entry.kind === "author") {
    authorMode.value = true;
    void author.initialize(entry.authorId);
  }
  if (entry.kind === "publish") {
    void initializePublisher(entry);
  }
});

function updateCommentCount(value: { postId: number; count: number }) {
  if (detail.value?.id !== value.postId) return;
  detail.value.commentNum = value.count;
  for (const list of [posts.value, authorPosts.value]) for (const post of list) if (post.id === value.postId) post.commentNum = value.count;
}

watch(availability.closed, closed => {
  if (!closed) return;
  resumeDetail = detailRequested.value || detail.value?.id || resumeDetail;
  closeDetail(); showPublish.value = false;
}, { flush: 'sync' });
async function recoverCommunity() {
  if (!pageVisible || pageDisposed || routeError.value) return;
  const owner = pageOwner(), started = detailGeneration;
  const current = () => !availability.closed.value && owner === pageOwner() && started === detailGeneration && pageVisible && !pageDisposed;
  if (!await availability.refresh(communityPreviewMode) || !current()) return;
  await load();
  if (!current()) return;
  if (resumeDetail) {
    const id = resumeDetail, revision = ++detailGeneration, ticket = engagement.nextTicket();
    try { const post = await apiCommunityState(id);
      if (!availability.closed.value && owner === pageOwner() && revision === detailGeneration && pageVisible && !pageDisposed) {
        detail.value = engagement.adopt([post], ticket)[0]; detailRequested.value = id; detailOpen.value = true; resumeDetail = 0;
      }
    } catch (reason) {
      if (!availability.closed.value && owner === pageOwner() && revision === detailGeneration && pageVisible && !pageDisposed)
        detailError.value = reason instanceof Error ? reason.message : '帖子状态加载失败';
    }
  } else if (entryState?.kind === 'publish') {
    if (entryState.editId) await editPost(entryState.editId);
    else { openPublish(); if (entryState.topicId) await relations.seedTopic(entryState.topicId); }
  }
}

onShow(() => { if (!pageDisposed) { pageVisible = true; home.show(); void load(); } });
onHide(() => { pageVisible = false; closeDetail(); });
onUnload(() => { pageVisible = false; pageDisposed = true; closeDetail(); });
watch(pageOwner, () => { resumeDetail = 0; closeDetail(); showPublish.value = false; }, { flush: 'sync' });
// #ifdef MP-WEIXIN
onShareAppMessage(engagement.miniMessage);
onShareTimeline(engagement.miniTimeline);
// #endif
</script>

<style scoped>
.publish-sheet { max-height: 88vh; overflow-y: auto; box-sizing: border-box; }
.video-upload { display: flex; flex-direction: column; gap: 12rpx; margin: 20rpx 0; }
.upload-hint { color: #666; font-size: 24rpx; overflow-wrap: anywhere; }
.community-video { display: block; width: 100%; height: 340rpx; margin: 12rpx 0; }
.publish-error { color: #a32920; font-size: 26rpx; margin: 16rpx 0; }
.photo-upload { margin: 20rpx 0; }
.photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12rpx; margin: 12rpx 0; }
.photo-item { min-width: 0; }
.photo-item image { width: 100%; height: 150rpx; }
.photo-item button { padding: 0; font-size: 22rpx; }
.photo-cover-label { display: block; color: var(--primary-color, #e64340); font-size: 22rpx; }
.video-cover { width: 100%; height: 160rpx; }
.detail-gallery image { display: block; width: 100%; margin: 12rpx 0; }
.selected-relations { display: flex; flex-direction: column; gap: 10rpx; margin: 20rpx 0; }
.selected-relations button { width: 100%; white-space: normal; overflow-wrap: anywhere; font-size: 24rpx; }
.source-tabs { display: flex; gap: 10rpx; }
.source-tabs button { flex: 1; font-size: 26rpx; }
.relation-panel button { white-space: normal; overflow-wrap: anywhere; margin-bottom: 10rpx; }
.relation-panel .chosen { color: #a32920; background: #fff0eb; }
.related-product { display: flex; align-items: center; gap: 16rpx; padding: 12rpx; width: 100%; text-align: left; font-size: 26rpx; line-height: 1.6; }
.related-product image { flex: 0 0 90rpx; width: 90rpx; height: 90rpx; }
.related-product view { flex: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.related-product text { display: block; color: #a32920; }
.author-heading, .author-stats { display: flex; gap: 20rpx; align-items: center; flex-wrap: wrap; }
.author-heading { justify-content: space-between; }
.author-heading button { margin: 0; font-size: 24rpx; }
.author-profile { background: #fff; padding: 24rpx; border-radius: 16rpx; margin: 20rpx 0; }
.author-profile > text { margin: 0 12rpx; font-size: 24rpx; }
.author-description { margin: 20rpx 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.author-stats { margin: 24rpx 0; font-size: 26rpx; }
.author-profile button, .author-controls button { font-size: 24rpx; margin-top: 12rpx; }
.description-editor textarea { width: 100%; box-sizing: border-box; background: #f7f7f7; padding: 20rpx; }
.author-post { margin: 20rpx 0; }
.post-status { display: block; margin: 14rpx 0; color: #666; font-size: 24rpx; }
.author-controls { margin-top: 20rpx; }
.author-controls text { display: block; overflow-wrap: anywhere; }
.top-actions { flex-wrap: wrap; justify-content: flex-end; }

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

.topic-strip { width: 100%; margin-bottom: 20rpx; }
.topic-row { display: flex; min-width: max-content; gap: 12rpx; }
.topic-chip { padding: 10rpx 18rpx; color: #555; background: #fff; border-radius: 26rpx; font-size: 23rpx; white-space: nowrap; }

.people-btn {
  color: #555;
  font-size: 24rpx;
  padding: 9rpx 10rpx;
}

.publish-btn {
  color: var(--view-theme, #e93323);
  font-size: 26rpx;
  border: 2rpx solid var(--view-theme, #e93323);
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
  background: var(--view-theme, #e93323);
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
  bottom: var(--window-bottom, 0px);
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
  background: var(--view-theme, #e93323);
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
  color: var(--view-theme, #e93323);
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
  color: var(--view-theme, #e93323);
  font-size: 28rpx;
}
</style>
