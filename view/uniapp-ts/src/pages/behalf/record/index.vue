<template>
  <view class="records-page">
    <view class="heading"><text class="eyebrow">管理员 · 代客下单</text><view class="title">下单记录</view>
      <text class="hint">仅查看当前管理员创建的订单；商城会员登录与此独立。</text></view>
    <view v-if="!session.authenticated" class="panel login-panel">
      <view class="section-title">管理员登录</view>
      <text class="hint">会话仅保留在本次应用运行中，刷新网页后需重新登录。</text>
      <text class="label">管理员账号</text><input v-model="account" aria-label="管理员账号" placeholder="请输入管理员账号" :maxlength="64" :disabled="loginBusy" />
      <text class="label">密码</text><input v-model="password" aria-label="管理员密码" placeholder="请输入密码" password :maxlength="256" :disabled="loginBusy" @confirm="login" />
      <view v-if="loginError" class="notice" role="alert">{{ loginError }}</view>
      <button class="primary" :loading="loginBusy" :disabled="loginBusy" @tap="login">登录管理会话</button>
    </view>
    <template v-else>
      <view class="session"><text>当前管理员：{{ session.label }}（{{ session.id }}）</text><button size="mini" @tap="logout">退出本机管理会话</button></view>
      <view v-if="!canRead" class="panel notice">当前管理员没有代客下单权限，请联系平台管理员。不会借用商城用户身份。</view>
      <template v-else>
        <view class="panel filters">
          <text class="label">订单号、收货人或手机号</text><input v-model="keyword" aria-label="搜索代客订单" placeholder="输入关键词" :maxlength="100" @confirm="load()" />
          <view class="filter-status"><text class="label">订单状态</text><picker :range="filters" range-key="label" :value="filterIndex" @change="changeFilter"><view class="picker">{{ filters[filterIndex].label }} ▾</view></picker></view>
          <button class="primary" :disabled="loading || !!checking" @tap="load()">查询 / 刷新</button>
        </view>
        <view v-if="error" class="notice" role="alert">{{ error }}<button size="mini" :disabled="loading" @tap="load()">重新查询</button></view>
        <view v-if="paymentNote" class="notice" role="status">{{ paymentNote }}</view>
        <view v-if="filtersDirty" class="notice" role="status">筛选条件已更改，点击“查询 / 刷新”应用新条件。</view>
        <view v-if="loading" class="empty" role="status">正在读取服务器记录…</view>
        <view v-else-if="loaded && !items.length && !error" class="panel empty">没有符合条件的代客订单</view>
        <view v-for="order in items" :key="order.id" class="panel order-card">
          <view class="order-top"><text class="order-no">{{ order.orderNo }}</text><text class="badge">{{ order.statusTitle }}</text></view>
          <view class="buyer">{{ order.uid ? `会员 UID ${order.uid}` : '游客订单' }}</view>
          <view class="order-total"><text>{{ order.quantity }} 件商品 · {{ formatTime(order.createdAt) }}</text><text class="amount">¥{{ order.amount }}</text></view>
          <view class="order-bottom"><text>{{ order.paid ? '列表记录：已付款' : '列表记录：未付款' }}</text><button size="mini" :loading="checking === order.orderNo" :disabled="loading || !!checking || !!error" @tap="checkPayment(order.orderNo)">核对付款状态</button><button v-if="order.root" size="mini" :disabled="loading || !!checking || !!error" @tap="goDetail(order.orderNo)">查看详情</button><button v-if="order.root && !order.paid" size="mini" :disabled="loading || !!checking || !!error" @tap="goCashier(order.orderNo)">去收银</button></view>
        </view>
        <button v-if="hasMore" :disabled="loading || !!checking || filtersDirty" @tap="load(true)">{{ error ? '重试本页' : '加载更多' }}</button>
        <button @tap="goBuyers">前往代客选客与选品</button>
        <view class="hint footer">此页只查询记录与付款状态；点击“去收银”会进入独立页面，仍需管理员明确确认支付。此流程不提供退款。</view>
      </template>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useAssistedRecords } from '@/composables/useAssistedRecords';
const { session, canRead, account, password, loginBusy, loginError, keyword, status, items,
  loading, loaded, error, hasMore, filtersDirty, checking, paymentNote, login, logout, load, checkPayment, goDetail, goCashier } = useAssistedRecords();
const filters = [{ label: '全部状态', value: '' }, { label: '待付款', value: '0' }, { label: '待发货', value: '1' },
  { label: '待收货', value: '2' }, { label: '待评价', value: '3' }, { label: '已完成', value: '4' }];
const filterIndex = computed(() => Math.max(0, filters.findIndex(item => item.value === status.value)));
function changeFilter(event: { detail: { value: string | number } }) { const filter = filters[Number(event.detail.value)]; if (filter) status.value = filter.value; }
function formatTime(seconds: number) { return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'; }
function goBuyers() { uni.navigateTo({ url: '/pages/behalf/user_list/index' }); }
</script>
<style scoped>
.records-page{max-width:860px;margin:auto;padding:36rpx 28rpx 140rpx;background:#f5f6f8;min-height:100vh;box-sizing:border-box;color:#202b3c}.heading{margin:14rpx 0 30rpx}.eyebrow{font-size:24rpx;color:#506883}.title{font-size:44rpx;font-weight:700;margin:10rpx 0 16rpx}.hint{font-size:25rpx;line-height:1.7;color:#607087}.panel{background:white;border:1px solid #e5e9ef;border-radius:18rpx;padding:28rpx;margin-bottom:24rpx}.section-title{font-size:34rpx;font-weight:600;margin-bottom:12rpx}.label{display:block;font-size:26rpx;margin:22rpx 0 10rpx;color:#43506a}input{height:82rpx;border:1px solid #bac6d5;border-radius:10rpx;padding:0 20rpx;font-size:29rpx;background:#fff;box-sizing:border-box}.primary{background:#244e78;color:white;margin-top:28rpx;font-size:29rpx}.session{display:flex;flex-wrap:wrap;gap:18rpx;align-items:center;justify-content:space-between;font-size:26rpx;margin-bottom:24rpx}.session button{margin:0;font-size:24rpx}.filter-status{display:flex;align-items:center;justify-content:space-between;margin-top:16rpx}.filter-status .label{margin:0}.picker{padding:14rpx 20rpx;border:1px solid #d5dde8;border-radius:8rpx;font-size:27rpx}.notice{background:#eef4fb;color:#23496b;padding:24rpx;border-radius:12rpx;margin:18rpx 0;font-size:27rpx;line-height:1.6;overflow-wrap:anywhere}.notice button{margin:12rpx 0 0}.empty{text-align:center;padding:42rpx 16rpx;color:#617287;font-size:28rpx}.order-top,.order-total,.order-bottom{display:flex;gap:16rpx;justify-content:space-between;align-items:center;flex-wrap:wrap}.order-no{font-size:28rpx;font-weight:600;overflow-wrap:anywhere;min-width:0}.badge{color:#295272;background:#eef4fa;padding:7rpx 16rpx;border-radius:8rpx;font-size:23rpx}.buyer{font-size:27rpx;margin:20rpx 0;color:#46546a}.order-total{font-size:24rpx;color:#657184}.amount{font-size:36rpx;color:#182b47;font-weight:600}.order-bottom{border-top:1px solid #edf0f4;margin-top:22rpx;padding-top:20rpx;font-size:25rpx}.order-bottom button{margin:0;font-size:25rpx}.footer{margin:30rpx 8rpx}button[disabled]{opacity:.65}
</style>
