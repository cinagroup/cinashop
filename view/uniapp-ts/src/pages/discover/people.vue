<template>
  <view class="people-page">
    <scroll-view scroll-x class="tabs" :show-scrollbar="false">
      <view class="tabs-row">
        <view
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          @tap="changeTab(tab.key)"
        >
          {{ tab.label }}
        </view>
      </view>
    </scroll-view>

    <view v-if="users.length" class="people-list">
      <view v-for="item in users" :key="`${activeTab}-${item.relation_id}`" class="person-card">
        <image class="avatar" :src="item.author_image || fallbackAvatar" mode="aspectFill" />
        <view class="person-main">
          <view class="person-name">{{ item.author || "社区用户" }}</view>
          <view class="person-stats">
            内容 {{ item.community_num }} · 粉丝 {{ item.fans_num }}
          </view>
        </view>
        <button
          class="follow-button"
          :class="{ following: item.is_follow === 1 }"
          :loading="busyUid === item.relation_id"
          @tap="toggleFollow(item)"
        >
          {{ followLabel(item) }}
        </button>
      </view>
    </view>
    <view v-else-if="!loading" class="empty">{{ emptyText }}</view>
    <view v-if="loading" class="loading">加载中...</view>
    <view v-else-if="finished && users.length" class="finished">没有更多了</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onReachBottom } from "@dcloudio/uni-app";
import {
  apiCommunityFollowList,
  apiCommunityFriendList,
  apiCommunityRecommendations,
  apiCommunitySetInterest,
  type CommunitySocialUser,
} from "@/api/community";

type SocialTab = "friend" | "follow" | "fans" | "recommend";

const tabs: Array<{ key: SocialTab; label: string }> = [
  { key: "friend", label: "好友" },
  { key: "follow", label: "关注" },
  { key: "fans", label: "粉丝" },
  { key: "recommend", label: "推荐" },
];
const activeTab = ref<SocialTab>("friend");
const users = ref<CommunitySocialUser[]>([]);
const page = ref(1);
const limit = 20;
const loading = ref(false);
const finished = ref(false);
const busyUid = ref(0);
const fallbackAvatar = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect width='96' height='96' rx='48' fill='%23eceff3'/%3E%3Ccircle cx='48' cy='37' r='17' fill='%23c8cdd5'/%3E%3Cpath d='M18 88c3-19 15-29 30-29s27 10 30 29' fill='%23c8cdd5'/%3E%3C/svg%3E";

const emptyText = computed(() => ({
  friend: "还没有好友",
  follow: "还没有关注任何人",
  fans: "还没有粉丝",
  recommend: "暂时没有推荐作者",
})[activeTab.value]);

async function fetchPage(): Promise<CommunitySocialUser[]> {
  if (activeTab.value === "friend") return apiCommunityFriendList(page.value, limit);
  if (activeTab.value === "recommend") return apiCommunityRecommendations(page.value, limit);
  return apiCommunityFollowList(activeTab.value, page.value, limit);
}

async function load(reset = false) {
  if (loading.value || (!reset && finished.value)) return;
  if (reset) {
    page.value = 1;
    users.value = [];
    finished.value = false;
  }
  loading.value = true;
  try {
    const rows = await fetchPage();
    const known = new Set(users.value.map((item) => item.relation_id));
    users.value.push(...rows.filter((item) => !known.has(item.relation_id)));
    finished.value = rows.length < limit;
    if (!finished.value) page.value += 1;
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "加载失败", icon: "none" });
  } finally {
    loading.value = false;
  }
}

function changeTab(tab: SocialTab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  void load(true);
}

function followLabel(item: CommunitySocialUser): string {
  if (item.is_follow === 1 && item.is_fans === 1) return "互相关注";
  if (item.is_follow === 1) return "已关注";
  if (item.is_fans === 1) return "回关";
  return "关注";
}

async function toggleFollow(item: CommunitySocialUser) {
  if (busyUid.value) return;
  const next: 0 | 1 = item.is_follow === 1 ? 0 : 1;
  if (next === 0) {
    const confirmed = await new Promise<boolean>((resolve) => {
      uni.showModal({
        title: "取消关注",
        content: `确认不再关注 ${item.author || "该用户"}？`,
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
  }
  busyUid.value = item.relation_id;
  try {
    const result = await apiCommunitySetInterest(item.relation_id, next);
    item.is_follow = result.is_follow;
    item.is_fans = result.is_fans;
    if (activeTab.value === "follow" && next === 0) {
      users.value = users.value.filter((row) => row.relation_id !== item.relation_id);
    }
    uni.showToast({ title: next === 1 ? "关注成功" : "已取消关注", icon: "success" });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "操作失败", icon: "none" });
  } finally {
    busyUid.value = 0;
  }
}

onLoad((query) => {
  const requested = String(query?.tab ?? "");
  if (tabs.some((tab) => tab.key === requested)) activeTab.value = requested as SocialTab;
  void load(true);
});
onReachBottom(() => void load());
</script>

<style scoped>
.people-page { min-height: 100vh; padding: 20rpx; background: #f5f6f8; box-sizing: border-box; }
.tabs { position: sticky; top: 0; z-index: 2; margin: -20rpx -20rpx 20rpx; width: calc(100% + 40rpx); background: #fff; }
.tabs-row { display: flex; min-width: max-content; padding: 0 20rpx; }
.tab { position: relative; padding: 28rpx 34rpx 24rpx; color: #777; font-size: 28rpx; white-space: nowrap; }
.tab.active { color: #222; font-weight: 700; }
.tab.active::after { content: ""; position: absolute; left: 34rpx; right: 34rpx; bottom: 10rpx; height: 5rpx; border-radius: 3rpx; background: #e93323; }
.people-list { display: flex; flex-direction: column; gap: 16rpx; }
.person-card { display: flex; align-items: center; gap: 20rpx; min-width: 0; padding: 24rpx; border-radius: 18rpx; background: #fff; box-sizing: border-box; }
.avatar { width: 96rpx; height: 96rpx; flex: 0 0 96rpx; border-radius: 50%; background: #eef0f3; }
.person-main { flex: 1; min-width: 0; }
.person-name { overflow: hidden; color: #222; font-size: 29rpx; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.person-stats { margin-top: 12rpx; color: #999; font-size: 23rpx; }
.follow-button { flex: 0 0 auto; min-width: 132rpx; margin: 0; padding: 0 18rpx; height: 58rpx; line-height: 56rpx; border: 0; border-radius: 30rpx; color: #fff; background: #e93323; font-size: 24rpx; }
.follow-button::after { border: 0; }
.follow-button.following { color: #777; background: #f1f2f4; }
.empty, .loading, .finished { padding: 120rpx 20rpx; color: #999; text-align: center; font-size: 25rpx; }
.finished { padding: 36rpx 20rpx; }
</style>
