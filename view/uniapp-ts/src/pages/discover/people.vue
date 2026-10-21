<template>
  <ThemePage>
    <view class="people-page">
      <view v-if="availability.closed.value && error" class="community-route-error" role="alert">{{ error }}</view>
      <CommunityAvailability :closed="availability.closed.value" :checking="availability.checking.value" :message="availability.message.value" @retry="recoverCommunity" />
      <view v-show="availability.allowed.value">
      <view class="people-toolbar">
        <text class="people-heading">好友与关注</text>
        <button :disabled="busy" @tap="openSelf">我的主页</button>
        <button :disabled="loading || busy" @tap="refresh">刷新列表</button>
      </view>
      <scroll-view scroll-x class="tabs" :show-scrollbar="false">
        <view class="tabs-row">
          <button v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: activeTab === tab.key }"
            :disabled="busy || unknown" @tap="changeTab(tab.key)">{{ tab.label }}</button>
        </view>
      </scroll-view>
      <view v-if="unknown" class="people-warning" role="alert">操作结果未确认，请刷新列表核实，请勿重复提交。</view>
      <view v-if="message" class="people-message" role="status">{{ message }}</view>
      <view v-if="error" class="people-error" role="alert">
        <text>{{ error }}</text>
        <button v-if="isLoggedIn" :disabled="loading || busy" @tap="retry">重试加载</button>
        <button v-else @tap="openSelf">去登录</button>
      </view>
      <view v-if="users.length" class="people-list">
        <view v-for="item in users" :key="`${item.type}-${item.relation_id}`" class="person-entry">
          <view class="person-card">
            <image class="avatar" :src="item.author_image || fallbackAvatar" mode="aspectFill" @tap="openAuthor(item)" />
            <view class="person-main" @tap="openAuthor(item)">
              <view class="person-name">{{ item.author || '社区用户' }}</view>
              <view class="person-stats">内容 {{ item.community_num }} · 粉丝 {{ item.fans_num }}</view>
            </view>
            <text v-if="isSelf(item)" class="self-label">你自己</text>
            <button v-else class="follow-button" :class="{ following: item.is_follow === 1 }"
              :loading="busyUid === item.relation_id" :disabled="loading || busy || unknown"
              @tap="toggleFollow(item)">{{ followLabel(item) }}</button>
          </view>
          <view v-if="confirmUid === item.relation_id" class="unfollow-confirm" role="alert">
            <text>确认不再关注 {{ item.author || '该用户' }}？</text>
            <view class="unfollow-actions">
              <button @tap="cancelUnfollow">保留关注</button>
              <button :disabled="loading || busy || unknown" @tap="confirmUnfollow">确认取消关注</button>
            </view>
          </view>
        </view>
      </view>
      <view v-else-if="!loading && !error && !unknown" class="empty">{{ emptyText }}</view>
      <view v-if="loading" class="loading" role="status">加载中...</view>
      <button v-else-if="users.length && !finished && !error" class="load-more"
        :disabled="busy || unknown" @tap="loadMore">加载更多作者</button>
      <view v-else-if="finished && users.length" class="finished">没有更多了</view>
      </view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import CommunityAvailability from '@/components/community/CommunityAvailability.vue';
import { useCommunityAvailability } from '@/utils/communityAvailability';
import ThemePage from '@/components/ThemePage.vue';
import { onLoad, onReachBottom } from '@dcloudio/uni-app';
import { communityPreviewMode } from '@/api/community';
import { useCommunityPeople } from '@/composables/useCommunityPeople';

const availability = useCommunityAvailability();
const { tabs, activeTab, users, loading, finished, error, message, unknown, confirmUid, busyUid, busy,
  isLoggedIn, emptyText, initialize, refresh, loadMore, retry, changeTab, isSelf, followLabel,
  toggleFollow, confirmUnfollow, cancelUnfollow, openAuthor, openSelf, validRoute } = useCommunityPeople();
const fallbackAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' rx='48' fill='%23eceff3'/%3E%3Ccircle cx='48' cy='37' r='17' fill='%23c8cdd5'/%3E%3Cpath d='M18 88c3-19 15-29 30-29s27 10 30 29' fill='%23c8cdd5'/%3E%3C/svg%3E";
async function recoverCommunity() {
  if (!validRoute()) return;
  const owner = availability.owner();
  if (await availability.refresh(communityPreviewMode) && owner === availability.owner() && validRoute()) await refresh();
}
onLoad(query => initialize(query ?? {}));
onReachBottom(() => void loadMore());
</script>

<style scoped>

.people-page { min-height: 100vh; padding: 20rpx; background: #f5f6f8; box-sizing: border-box; }
.tabs { position: sticky; top: 0; z-index: 2; margin: 0 -20rpx 20rpx; width: calc(100% + 40rpx); background: #fff; }
.tabs-row { display: flex; min-width: max-content; padding: 0 20rpx; }
.tab { margin: 0; border: 0; border-radius: 0; background: transparent; line-height: 1.5; position: relative; padding: 28rpx 34rpx 24rpx; color: #777; font-size: 28rpx; white-space: nowrap; }
.tab.active { color: #222; font-weight: 700; }
.tab.active::after { content: ""; position: absolute; top: auto; left: 34rpx; right: 34rpx; bottom: 10rpx; width: auto; height: 5rpx; transform: none; border-radius: 3rpx; background: var(--view-theme, #e93323); }
.people-list { display: flex; flex-direction: column; gap: 16rpx; }
.person-card { display: flex; align-items: center; gap: 20rpx; min-width: 0; padding: 24rpx; border-radius: 18rpx; background: #fff; box-sizing: border-box; }
.avatar { width: 96rpx; height: 96rpx; flex: 0 0 96rpx; border-radius: 50%; background: #eef0f3; }
.person-main { flex: 1; min-width: 0; }
.person-name { overflow: hidden; color: #222; font-size: 29rpx; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.person-stats { margin-top: 12rpx; color: #999; font-size: 23rpx; }
.follow-button { flex: 0 0 auto; min-width: 132rpx; margin: 0; padding: 0 18rpx; height: 58rpx; line-height: 56rpx; border: 0; border-radius: 30rpx; color: #fff; background: var(--view-theme, #e93323); font-size: 24rpx; }
.follow-button::after { border: 0; }
.follow-button.following { color: #777; background: #f1f2f4; }
.empty, .loading, .finished { padding: 120rpx 20rpx; color: #999; text-align: center; font-size: 25rpx; }
.finished { padding: 36rpx 20rpx; }

.people-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12rpx; margin-bottom: 20rpx; }
.people-heading { flex: 1; font-size: 34rpx; font-weight: 700; }
.people-toolbar button { margin: 0; font-size: 24rpx; }
.tab::after { border: 0; }
.person-entry { overflow: hidden; border-radius: 18rpx; background: #fff; }
.self-label { color: #777; font-size: 24rpx; }
.people-error, .people-warning { margin: 20rpx 0; padding: 20rpx; border-radius: 12rpx; color: #a32920; background: #fff2ee; font-size: 26rpx; overflow-wrap: anywhere; }
.people-message { margin: 20rpx 0; color: #35733e; font-size: 26rpx; }
.people-error button, .load-more { font-size: 26rpx; }
.unfollow-confirm { padding: 0 24rpx 24rpx; font-size: 26rpx; }
.unfollow-actions { display: flex; gap: 16rpx; margin-top: 16rpx; }
.unfollow-actions button { flex: 1; margin: 0; font-size: 24rpx; }
</style>
