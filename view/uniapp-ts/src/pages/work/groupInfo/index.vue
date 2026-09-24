<template>
  <view class="work-page">
    <!-- #ifdef H5 -->
    <view v-if="access.error.value || error" class="notice error" role="alert">{{ access.error.value || error }}<button @tap="refresh">重新授权或重试</button></view>
    <view v-if="!group && loading" class="notice">正在读取群资料…</view>
    <template v-if="group">
      <view class="card identity"><text class="title">{{ group.name || "企业微信群" }}</text><text class="muted">创建于 {{ group.group_create_time || "未知" }}</text><text v-if="group.notice" class="notice-text">{{ group.notice }}</text></view>
      <view class="stats card"><view><text class="number">{{ group.member_num }}</text><text>当前群成员</text></view><view><text class="number">{{ group.todaySum }}</text><text>今日入群</text></view><view><text class="number">{{ group.retreat_group_num }}</text><text>累计退群</text></view></view>
      <view class="search"><input v-model="searchInput" maxlength="100" placeholder="搜索客户名称" @confirm="search" /><button @tap="search">搜索</button></view>
      <view v-if="!members.length && !loading && !error" class="notice">暂无群成员</view>
      <view v-for="member in members" :key="member.id" class="card member" @tap="openClient(member)">
        <image v-if="member.type === 1 ? member.member?.avatar : member.client?.avatar" :src="member.type === 1 ? member.member?.avatar : member.client?.avatar" class="avatar" mode="aspectFill" />
        <view class="member-info"><text class="member-name">{{ member.type === 1 ? member.member?.name : member.client?.name }}</text><text class="muted">{{ member.type === 1 ? (member.userid === group.owner ? "群主" : "内部成员") : "客户" }} · 加入 {{ member.join_time }}</text><text v-if="member.type === 2" class="muted">其他所在群 {{ member.group_chat_num }} 个</text><text class="tags">{{ member.tags.length ? member.tags.join("、") : "暂无标签" }}</text></view>
      </view>
      <button v-if="hasMore && !loading" class="more" @tap="loadMore">加载更多</button>
      <view v-else-if="loading && members.length" class="end">正在加载…</view>
      <view v-else-if="members.length" class="end">已显示全部成员</view>
    </template>
    <!-- #endif -->
    <!-- #ifndef H5 --><view class="notice">企业微信工作台仅支持 H5 侧边栏。</view><!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onLoad, onReachBottom, onUnload } from "@dcloudio/uni-app";
import { getWorkGroupInfo, getWorkGroupMembers, type WorkGroupInfo, type WorkGroupMember } from "@/api/work";
import { useWorkAccess } from "@/composables/useWorkAccess";

const access = useWorkAccess("group");
const group = ref<WorkGroupInfo | null>(null);
const members = ref<WorkGroupMember[]>([]);
const searchInput = ref("");
const searchTerm = ref("");
const error = ref("");
const loading = ref(false);
const hasMore = ref(false);
watch(access.token, (value) => { if (!value) { group.value = null; members.value = []; hasMore.value = false; } }, { flush: "sync" });
let page = 1;
let epoch = 0;
let hint: string | undefined;

onLoad((query) => { hint = typeof query?.chat_id === "string" ? query.chat_id : undefined; void refresh(); });
onReachBottom(() => { void loadMore(); });
onUnload(() => { epoch++; group.value = null; members.value = []; access.dispose(); });

async function refresh() {
  const current = ++epoch;
  group.value = null;
  members.value = [];
  page = 1;
  hasMore.value = false;
  error.value = "";
  loading.value = true;
  try {
    const route = `/pages/work/groupInfo/index${hint ? `?chat_id=${encodeURIComponent(hint)}` : ""}`;
    const token = await access.connect(route, hint);
    if (!token || current !== epoch) return;
    const data = await getWorkGroupInfo(token);
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    group.value = data;
    const result = await getWorkGroupMembers(token, data.id, { page, limit: 20, name: searchTerm.value });
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    members.value = result.list;
    hasMore.value = result.count > result.list.length;
    page++;
  } catch (cause) {
    if (current === epoch) { group.value = null; members.value = []; access.readFailure(cause); }
  } finally { if (current === epoch) loading.value = false; }
}

async function loadMore() {
  if (loading.value || !hasMore.value || !group.value) return;
  const current = epoch;
  loading.value = true;
  error.value = "";
  try {
    const token = await access.verifiedToken(hint);
    if (!token) { group.value = null; members.value = []; hasMore.value = false; return; }
    if (current !== epoch || !group.value) return;
    const result = await getWorkGroupMembers(token, group.value.id, { page, limit: 20, name: searchTerm.value });
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    members.value = [...members.value, ...result.list];
    hasMore.value = result.count > members.value.length;
    page++;
  } catch (cause) {
    if (current === epoch) { access.readFailure(cause); error.value = access.error.value; }
  } finally { if (current === epoch) loading.value = false; }
}

function search() { searchTerm.value = searchInput.value.trim().slice(0, 100); void refresh(); }
async function openClient(item: WorkGroupMember) {
  if (item.type !== 2 || !item.client) return;
  const current = epoch;
  try {
    const token = await access.verifiedToken(hint);
    if (!token || current !== epoch || !members.value.some((member) => member.id === item.id)) return;
    uni.navigateTo({ url: `/pages/work/userInfo/index?userid=${encodeURIComponent(item.userid)}` });
  } catch (cause) {
    if (current === epoch) access.readFailure(cause);
  }
}
</script>

<style scoped>
.work-page { min-height: 100vh; background: #f3f6f9; padding: 20rpx 20rpx 80rpx; box-sizing: border-box; }
.card, .notice { background: #fff; border-radius: 16rpx; padding: 24rpx; margin-bottom: 18rpx; }.notice { overflow-wrap: anywhere; }.notice button { margin-top: 16rpx; }.error { color: #a72d2d; }
.identity { display: flex; flex-direction: column; gap: 10rpx; }.title { font-size: 34rpx; font-weight: 700; overflow-wrap: anywhere; }.muted { color: #718094; font-size: 23rpx; }.notice-text { color: #44566c; overflow-wrap: anywhere; font-size: 25rpx; }
.stats { display: flex; justify-content: space-around; gap: 12rpx; }.stats view { display: flex; flex-direction: column; align-items: center; font-size: 22rpx; color: #6c7787; text-align: center; }.number { color: #1768c8; font-size: 36rpx; font-weight: 700; }
.search { display: flex; gap: 12rpx; margin-bottom: 18rpx; }.search input { flex: 1; min-width: 0; background: #fff; border-radius: 9rpx; padding: 10rpx 18rpx; }.search button { margin: 0; font-size: 24rpx; }
.member { display: flex; gap: 16rpx; align-items: flex-start; }.avatar { width: 72rpx; height: 72rpx; border-radius: 50%; flex-shrink: 0; }.member-info { min-width: 0; display: flex; flex-direction: column; gap: 7rpx; overflow-wrap: anywhere; }.member-name { font-size: 27rpx; font-weight: 600; }.tags { color: #1768c8; font-size: 23rpx; }.more, .end { display: block; text-align: center; margin: 22rpx auto; color: #526071; font-size: 25rpx; }
</style>
