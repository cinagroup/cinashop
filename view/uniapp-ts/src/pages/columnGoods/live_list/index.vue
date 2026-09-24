<template>
  <view class="live-page">
    <view class="heading">
      <view class="title">微信直播</view>
      <view class="subtitle">查看正在直播、预告和回放的房间</view>
    </view>
    <view v-if="!miniProgram" class="message">直播间仅在微信小程序中开放</view>
    <template v-else>
      <button class="refresh" size="mini" :disabled="loading" @tap="refresh">刷新直播间</button>
      <view v-if="error" class="error" role="alert">
        {{ error }}
        <button size="mini" :disabled="loading" @tap="loadMore">重试</button>
      </view>
      <view class="rooms">
        <view v-for="room in rooms" :key="room.id" class="room" @tap="openRoom(room.room_id)">
          <view class="cover">
            <image v-if="roomImage(room)" :src="roomImage(room)" mode="aspectFill" />
            <view class="status" :class="{ upcoming: room.live_status === 102, replay: room.live_status === 103 }">
              {{ statusLabel(room.live_status) }}<text v-if="room.live_status === 102 && room.show_time"> · {{ room.show_time }}</text>
            </view>
          </view>
          <view class="body">
            <view class="name">{{ room.name }}</view>
            <view class="anchor">
              <image v-if="safeDiyImageUrl(room.anchor_img)" :src="safeDiyImageUrl(room.anchor_img)" mode="aspectFill" />
              <text>{{ room.anchor_name || '直播间' }}</text>
            </view>
          </view>
        </view>
      </view>
      <view v-if="loading" class="message" role="status">正在加载直播间…</view>
      <view v-else-if="!error && !rooms.length" class="message">暂无可展示的直播间</view>
      <button v-if="rooms.length && hasMore && !error" class="more" :disabled="loading" @tap="loadMore">加载更多</button>
      <view v-else-if="rooms.length && !hasMore" class="message">已加载全部直播间</view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow, onHide, onUnload, onReachBottom, onPullDownRefresh } from '@dcloudio/uni-app';
import { apiLiveRooms, type LiveRoomListItem } from '@/api/activity';
import { useAuthStore } from '@/stores/auth';
import { safeDiyImageUrl } from '@/utils/diy';

const auth = useAuthStore();
const rooms = ref<LiveRoomListItem[]>([]);
const loading = ref(false);
const error = ref('');
const hasMore = ref(true);
const page = ref(1);
const pageSize = 10;
const maxPage = 1000;
let visible = false;
let revision = 0;
let miniProgram = false;
// #ifdef MP-WEIXIN
miniProgram = true;
// #endif

function statusLabel(status: number): string {
  if (status === 101) return '进行中';
  if (status === 102) return '预告';
  if (status === 103) return '回放';
  return '状态待同步';
}

function roomImage(room: LiveRoomListItem): string {
  return safeDiyImageUrl(room.share_img) || safeDiyImageUrl(room.cover_img);
}

async function loadMore(): Promise<void> {
  if (!miniProgram || !visible || loading.value || !hasMore.value) return;
  const current = revision;
  const nextPage = page.value;
  loading.value = true;
  error.value = '';
  try {
    const list = await apiLiveRooms({ page: nextPage, limit: pageSize });
    if (current !== revision || !visible) return;
    rooms.value = nextPage === 1 ? list : [...rooms.value, ...list];
    page.value = nextPage + 1;
    hasMore.value = list.length === pageSize && nextPage < maxPage;
  } catch (cause) {
    if (current === revision && visible) error.value = cause instanceof Error ? cause.message : '直播列表加载失败';
  } finally {
    if (current === revision && visible) loading.value = false;
  }
}

function refresh(): void {
  if (!miniProgram || !visible) return;
  revision++;
  rooms.value = [];
  page.value = 1;
  hasMore.value = true;
  loading.value = false;
  error.value = '';
  void loadMore();
}

function openRoom(roomId: number): void {
  if (!miniProgram || !Number.isSafeInteger(roomId) || roomId <= 0) return;
  const uid = Number.isSafeInteger(auth.uid) && auth.uid > 0 ? auth.uid : 0;
  const customParams = encodeURIComponent(JSON.stringify({ pid: uid }));
  // #ifdef MP-WEIXIN
  uni.navigateTo({ url: `plugin-private://wx2b03c6e691cd7370/pages/live-player-plugin?room_id=${roomId}&custom_params=${customParams}` });
  // #endif
}

onShow(() => { visible = true; refresh(); });
onHide(() => { visible = false; revision++; loading.value = false; });
onUnload(() => { visible = false; revision++; loading.value = false; });
onReachBottom(() => { void loadMore(); });
onPullDownRefresh(() => { refresh(); uni.stopPullDownRefresh(); });
</script>

<style scoped>
.live-page { max-width: 1000px; margin: auto; min-height: 100vh; box-sizing: border-box; padding: 24rpx 20rpx calc(48rpx + env(safe-area-inset-bottom)); background: #f7f5f3; color: #282521; }
.heading { padding: 20rpx 8rpx 24rpx; }.title { font-size: 42rpx; font-weight: 700; }.subtitle { margin-top: 8rpx; color: #777; font-size: 24rpx; }
.refresh { margin: 0 8rpx 20rpx auto; }.rooms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20rpx; }
.room { min-width: 0; overflow: hidden; border-radius: 16rpx; background: #fff; }.cover { position: relative; height: 275rpx; background: #ddd; }.cover image { width: 100%; height: 100%; }
.status { position: absolute; top: 14rpx; left: 14rpx; padding: 6rpx 12rpx; border-radius: 30rpx; background: #cf3227; color: #fff; font-size: 21rpx; }.status.upcoming { background: #176ab7; }.status.replay { background: #666; }
.body { padding: 17rpx; }.name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 27rpx; font-weight: 650; }.anchor { display: flex; align-items: center; gap: 8rpx; margin-top: 12rpx; color: #777; font-size: 22rpx; }.anchor image { width: 34rpx; height: 34rpx; border-radius: 50%; }
.message { padding: 40rpx 12rpx; color: #777; text-align: center; font-size: 24rpx; }.error { margin: 18rpx 8rpx; color: #ad2820; font-size: 24rpx; }.more { margin-top: 20rpx; }
</style>
