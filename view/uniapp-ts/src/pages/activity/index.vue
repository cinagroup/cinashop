<template>
  <view class="activity-page">
    <!-- Tab 切换 -->
    <view class="tabs">
      <view
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: active === t.key }"
        @tap="switchTab(t.key)"
      >
        {{ t.name }}
      </view>
    </view>

    <!-- 秒杀 -->
    <view v-if="active === 'seckill'" class="body">
      <view class="time-slots">
        <view
          v-for="s in slots"
          :key="s.id"
          class="slot"
          :class="{ active: s.status === 1 }"
          @tap="loadSeckill(s.id)"
        >
          <text class="slot-time">{{ s.start_time }}</text>
          <text class="slot-status">{{ s.state }}</text>
        </view>
      </view>
      <view v-if="seckillList.length" class="goods-list">
        <view v-for="g in seckillList" :key="g.id" class="goods-item" @tap="goSeckill(g.id)">
          <view class="goods-info">
            <view class="goods-name">{{ g.title }}</view>
            <view class="goods-price">
              <text class="price">¥{{ g.price }}</text>
              <text class="ot-price">¥{{ g.ot_price }}</text>
            </view>
          </view>
        </view>
      </view>
      <view v-else class="empty">当前时段暂无秒杀商品</view>
    </view>

    <!-- 砍价 -->
    <view v-if="active === 'bargain'" class="body">
      <view v-if="bargainList.length" class="goods-list">
        <view v-for="g in bargainList" :key="g.id" class="goods-item" @tap="goBargain(g.id)">
          <view class="goods-info">
            <view class="goods-name">{{ g.title }}</view>
            <view class="goods-price">
              <text class="price">¥{{ g.price }}</text>
              <text class="ot-price">可砍至 ¥{{ g.min_price }}</text>
            </view>
          </view>
          <view class="go-btn" @tap.stop="goBargain(g.id)">去砍价</view>
        </view>
      </view>
      <view v-else class="empty">暂无砍价商品</view>
      <view class="my-link" @tap="goMyBargain">我的砍价 ›</view>
    </view>

    <!-- 拼团 -->
    <view v-if="active === 'combination'" class="body">
      <view v-if="combinationList.length" class="goods-list">
        <view v-for="g in combinationList" :key="g.id" class="goods-item" @tap="goCombination(g.id)">
          <view class="goods-info">
            <view class="goods-name">{{ g.title }}</view>
            <view class="goods-price">
              <text class="price">¥{{ g.price }}</text>
              <text class="ot-price">{{ g.people }}人团</text>
            </view>
          </view>
          <view class="go-btn">去拼团</view>
        </view>
      </view>
      <view v-else class="empty">暂无拼团活动</view>
    </view>
    <view v-if="active === 'lottery'" class="body">
      <view class="lottery-entry" @tap="goLottery">
        <text class="lottery-kicker">LUCKY DRAW</text>
        <text class="lottery-title">幸运抽奖</text>
        <text class="lottery-copy">积分、余额、支付、评价与邀请都能参与</text>
        <view class="lottery-button">立即参与 ›</view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  apiSeckillIndex,
  apiSeckillList,
  apiBargainList,
  apiCombinationList,
  type BargainListItem,
  type CombinationListItem,
  type SeckillListItem,
  type SeckillTimeItem,
} from "@/api/activity";

const tabs = [
  { key: "seckill", name: "限时秒杀" },
  { key: "bargain", name: "砍价" },
  { key: "combination", name: "拼团" },
  { key: "lottery", name: "抽奖" },
];
const active = ref("seckill");
const slots = ref<SeckillTimeItem[]>([]);
const seckillList = ref<SeckillListItem[]>([]);
const bargainList = ref<BargainListItem[]>([]);
const combinationList = ref<CombinationListItem[]>([]);

async function loadSeckill(time?: string | number) {
  try {
    if (time) {
      seckillList.value = await apiSeckillList(time);
    } else {
      const idx = await apiSeckillIndex();
      slots.value = idx.seckillTime;
      const act = idx.seckillTime[idx.seckillTimeIndex];
      if (act) seckillList.value = await apiSeckillList(act.id);
    }
  } catch {
    seckillList.value = [];
  }
}

async function loadBargain() {
  try {
    bargainList.value = await apiBargainList();
  } catch {
    bargainList.value = [];
  }
}

async function loadCombination() {
  try {
    combinationList.value = await apiCombinationList();
  } catch {
    combinationList.value = [];
  }
}

function switchTab(key: string) {
  active.value = key;
  if (key === "seckill") loadSeckill();
  if (key === "bargain") loadBargain();
  if (key === "combination") loadCombination();
}

function goSeckill(id: number) {
  uni.navigateTo({ url: `/pages/activity/seckillDetail?id=${id}` });
}

function goBargain(id: number) {
  uni.navigateTo({ url: `/pages/activity/bargainDetail?id=${id}` });
}

function goCombination(id: number) {
  uni.navigateTo({ url: `/pages/activity/detail?id=${id}` });
}

function goMyBargain() {
  uni.navigateTo({ url: `/pages/activity/bargainDetail?mine=1` });
}

function goLottery() {
  uni.navigateTo({ url: "/pages/activity/lottery" });
}

onMounted(() => {
  loadSeckill();
});
</script>

<style scoped>
.activity-page {
  padding: 20rpx;
}

.tabs {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 18rpx 0;
  font-size: 28rpx;
  color: #666;
  border-radius: 12rpx;
}

.tab.active {
  background: #e93323;
  color: #fff;
  font-weight: 600;
}

.time-slots {
  display: flex;
  gap: 12rpx;
  margin-bottom: 20rpx;
  overflow-x: auto;
}

.slot {
  flex-shrink: 0;
  background: #fff;
  border-radius: 12rpx;
  padding: 14rpx 24rpx;
  text-align: center;
  border: 2rpx solid transparent;
}

.slot.active {
  border-color: #e93323;
}

.slot-time {
  display: block;
  font-size: 24rpx;
  font-weight: 600;
}

.slot-status {
  display: block;
  font-size: 20rpx;
  color: #999;
  margin-top: 4rpx;
}

.slot.active .slot-status {
  color: #e93323;
}

.goods-list {
  background: #fff;
  border-radius: 16rpx;
  padding: 0 24rpx;
}

.goods-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.goods-info {
  flex: 1;
}

.goods-name {
  font-size: 28rpx;
  color: #333;
  margin-bottom: 10rpx;
}

.goods-price {
  display: flex;
  align-items: baseline;
  gap: 16rpx;
}

.price {
  font-size: 32rpx;
  color: #e93323;
  font-weight: 700;
}

.ot-price {
  font-size: 22rpx;
  color: #999;
  text-decoration: line-through;
}

.go-btn {
  background: #e93323;
  color: #fff;
  font-size: 24rpx;
  padding: 12rpx 28rpx;
  border-radius: 32rpx;
  flex-shrink: 0;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 80rpx 0;
}

.my-link {
  text-align: center;
  color: #e93323;
  font-size: 26rpx;
  margin-top: 20rpx;
  padding: 20rpx;
}

.lottery-entry {
  min-height: 300rpx;
  padding: 44rpx 36rpx;
  border-radius: 24rpx;
  color: #fff;
  background: linear-gradient(135deg, #6d2214, #ed5130 68%, #ffad56);
  box-shadow: 0 16rpx 40rpx rgba(170, 58, 32, 0.22);
  box-sizing: border-box;
}

.lottery-kicker, .lottery-title, .lottery-copy {
  display: block;
}

.lottery-kicker { font-size: 20rpx; letter-spacing: 4rpx; opacity: 0.72; }
.lottery-title { margin-top: 20rpx; font-size: 46rpx; font-weight: 800; }
.lottery-copy { margin-top: 12rpx; font-size: 24rpx; opacity: 0.86; }
.lottery-button { display: inline-block; margin-top: 34rpx; padding: 14rpx 24rpx; border: 1rpx solid rgba(255,255,255,.45); border-radius: 999rpx; background: rgba(255,255,255,.14); font-size: 24rpx; }
</style>
