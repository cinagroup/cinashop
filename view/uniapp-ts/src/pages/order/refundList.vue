<template>
  <view class="refund-list">
    <scroll-view scroll-x class="filters"><view class="filter-row">
      <button v-for="item in refundFilters" :key="item.key" size="mini" :class="{ active: state.filter === item.key }"
        :disabled="state.operating" @tap="setFilter(item.key)">{{ item.label }}</button>
    </view></scroll-view>
    <view class="tools"><input v-model="search" placeholder="退款单号或订单编号" :maxlength="80" @confirm="applySearch" />
      <button size="mini" :disabled="busy" @tap="applySearch">搜索</button></view>
    <view class="tools"><button size="mini" :disabled="busy" @tap="load()">刷新列表</button>
      <button v-if="!auth.isLoggedIn" size="mini" :disabled="busy" @tap="login">登录后查看</button></view>
    <view v-if="routeError || state.error || navigationError" class="notice">{{ routeError || state.error || navigationError }}</view>
    <view v-if="state.loading" class="notice">正在读取退款记录…</view>
    <view v-if="state.ready" class="count">已加载 {{ list.length }} 笔记录</view>
    <view v-for="row in list" :key="row.id" class="refund-card">
      <view class="heading"><text>{{ row.refundNo }}</text><text class="status">{{ refundStatus(row) }}</text></view>
      <view>订单编号：{{ row.orderId }}</view><view>{{ row.refundReason }} · {{ row.refundNum }} 件</view>
      <view>退款金额 ¥{{ row.refundPrice }} · 已退金额 ¥{{ row.refundedPrice }}</view>
      <view class="count">{{ refundTime(row.addTime) }}</view>
      <button size="mini" :disabled="busy || !!state.error" @tap="goDetail(row)">查看详情</button>
    </view>
    <view v-if="state.ready && !state.loading && !state.error && !list.length" class="empty">当前筛选下暂无退款记录</view>
    <button v-if="state.error && auth.isLoggedIn" :disabled="busy" @tap="load(list.length > 0)">重试读取</button>
    <button v-else-if="state.cursor" :disabled="busy" @tap="load(true)">加载更多</button>
    <view v-else-if="state.ready && list.length" class="count">已加载全部匹配记录</view>
  </view>
  <DiySuspendedNavigation />
</template>
<script setup lang="ts">
import { useRefundRecords } from '@/composables/useRefundRecords';
import { refundFilters, refundStatus, refundTime } from '../../../../common/refundRecords';
defineOptions({ inheritAttrs: false });
const { auth, state, list, search, busy, routeError, navigationError, load, goDetail, login, setFilter, applySearch } = useRefundRecords('list');
</script>
<style scoped>
.refund-list { padding: 20rpx; overflow-wrap: anywhere; }
.filter-row { display: flex; gap: 12rpx; width: max-content; padding: 12rpx 0; }
.filter-row button { flex: none; margin: 0; } .filter-row .active { color: #e93323; background: #fff0ed; }
.tools { display: flex; gap: 16rpx; margin: 16rpx 0; align-items: center; }
.tools input { flex: 1; min-width: 0; background: white; padding: 16rpx; font-size: 26rpx; }
.tools button { flex: none; margin: 0; }
.refund-card { padding: 24rpx; margin: 20rpx 0; background: white; border-radius: 16rpx; font-size: 26rpx; line-height: 1.7; }
.heading { display: flex; flex-wrap: wrap; gap: 12rpx; justify-content: space-between; margin-bottom: 12rpx; }
.status { color: #c93124; } .count { color: #777; font-size: 24rpx; padding: 12rpx 0; }
.notice { padding: 20rpx; background: #fff4e5; color: #744500; font-size: 26rpx; }
.empty { text-align: center; color: #777; padding: 100rpx 0; }
</style>
