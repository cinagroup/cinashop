<template>
  <view class="records-page">
    <view v-if="loading" class="state">记录加载中…</view>
    <view v-else-if="!records.length" class="state"><text class="empty-icon">🎁</text><text>还没有中奖记录</text></view>
    <view v-for="record in records" :key="record.id" class="record-card">
      <image :src="prize(record)?.image || '/static/logo.png'" mode="aspectFill" class="record-image" />
      <view class="record-main">
        <text class="record-name">{{ prize(record)?.name || "奖品" }}</text>
        <text class="record-time">{{ formatTime(record.addTime || record.add_time || 0) }}</text>
        <view class="status-row"><text class="status" :class="{ pending: !(record.isReceive || record.is_receive) }">{{ (record.isReceive || record.is_receive) ? "已领取" : "待领取" }}</text><text v-if="record.type === 6" class="deliver">{{ (record.isDeliver || record.is_deliver) ? "已发货" : "待发货" }}</text></view>
      </view>
      <view v-if="record.type === 6 && !(record.isReceive || record.is_receive)" class="claim-btn" @tap="openClaim(record)">领取</view>
    </view>
    <view v-if="claimRecord" class="mask" @tap.self="claimRecord = null">
      <view class="claim-card"><text class="claim-title">填写收货信息</text><input v-model="claim.name" class="input" placeholder="收货人姓名" /><input v-model="claim.phone" class="input" type="number" maxlength="11" placeholder="手机号" /><textarea v-model="claim.address" class="textarea" placeholder="详细收货地址" /><view class="submit" @tap="submit">确认领取</view></view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { onPullDownRefresh } from "@dcloudio/uni-app";
import { apiLotteryReceive, apiLotteryRecords, type LotteryRecord } from "@/api/lottery";
const loading = ref(true); const records = ref<LotteryRecord[]>([]); const claimRecord = ref<LotteryRecord | null>(null); const claim = reactive({ name: "", phone: "", address: "" });
function prize(record: LotteryRecord) { return record.prize_info || record.prize; }
function formatTime(value: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
async function load() { loading.value = true; try { records.value = await apiLotteryRecords(); } catch (error) { uni.showToast({ title: (error as Error).message || "加载失败", icon: "none" }); } finally { loading.value = false; uni.stopPullDownRefresh(); } }
function openClaim(record: LotteryRecord) { claimRecord.value = record; Object.assign(claim, { name: "", phone: "", address: "" }); }
async function submit() { if (!claimRecord.value || !claim.name || !/^1\d{10}$/.test(claim.phone) || !claim.address) return uni.showToast({ title: "请完整填写正确的收货信息", icon: "none" }); try { await apiLotteryReceive({ id: claimRecord.value.id, ...claim }); uni.showToast({ title: "领取成功", icon: "success" }); claimRecord.value = null; await load(); } catch (error) { uni.showToast({ title: (error as Error).message || "领取失败", icon: "none" }); } }
onMounted(load); onPullDownRefresh(load);
</script>

<style scoped>
.records-page { min-height: 100vh; padding: 24rpx; background: #f5f6f8; box-sizing: border-box; } .state { padding: 120rpx 20rpx; text-align: center; color: #999; } .state text { display: block; } .empty-icon { font-size: 72rpx; margin-bottom: 18rpx; }
.record-card { display: flex; align-items: center; gap: 22rpx; padding: 24rpx; margin-bottom: 18rpx; background: #fff; border-radius: 20rpx; } .record-image { width: 120rpx; height: 120rpx; border-radius: 16rpx; background: #f5f5f5; } .record-main { flex: 1; min-width: 0; } .record-name, .record-time { display: block; } .record-name { font-size: 29rpx; font-weight: 700; color: #333; } .record-time { margin-top: 10rpx; font-size: 22rpx; color: #aaa; } .status-row { display: flex; gap: 12rpx; margin-top: 12rpx; } .status, .deliver { padding: 5rpx 12rpx; border-radius: 999rpx; color: #2c8b57; background: #eaf8f0; font-size: 20rpx; } .status.pending, .deliver { color: #d56a14; background: #fff3e5; } .claim-btn { padding: 14rpx 22rpx; color: #fff; background: #ec4d30; border-radius: 999rpx; font-size: 24rpx; }
.mask { position: fixed; z-index: 10; inset: 0; display: flex; align-items: center; padding: 40rpx; background: rgba(0,0,0,.55); } .claim-card { width: 100%; padding: 36rpx; border-radius: 24rpx; background: #fff; box-sizing: border-box; } .claim-title { display: block; margin-bottom: 24rpx; font-size: 32rpx; font-weight: 700; text-align: center; } .input, .textarea { width: 100%; padding: 20rpx; margin-bottom: 14rpx; border-radius: 14rpx; background: #f5f6f8; box-sizing: border-box; } .textarea { height: 130rpx; } .submit { padding: 22rpx; border-radius: 999rpx; color: #fff; background: #ec4d30; text-align: center; }
</style>
