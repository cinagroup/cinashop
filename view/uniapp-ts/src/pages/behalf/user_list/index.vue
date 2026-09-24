<template>
  <view class="assisted-page">
    <view class="eyebrow">管理员 · 代客下单</view><view class="title">选择买家</view>
    <view class="hint">管理会话与商城会员登录独立，仅在本次应用运行中保留。</view>
    <view v-if="!session.authenticated" class="panel">
      <text class="label">管理员账号</text><input v-model="account" aria-label="管理员账号" :maxlength="64" :disabled="loginBusy" placeholder="请输入管理员账号" />
      <text class="label">密码</text><input v-model="password" aria-label="管理员密码" password :maxlength="256" :disabled="loginBusy" placeholder="请输入密码" @confirm="login" />
      <view v-if="loginError" class="notice" role="alert">{{ loginError }}</view>
      <button class="primary" :loading="loginBusy" :disabled="loginBusy" @tap="login">登录管理会话</button>
    </view>
    <template v-else>
      <view class="session"><text>{{ session.label }}（{{ session.id }}）</text><button size="mini" @tap="logout">退出本机管理会话</button></view>
      <view v-if="session.canAssist && draft.checkoutLock" class="notice">本机有待确认订单，核实前不能更换买家。<button @tap="recoverCheckout">恢复原订单结果</button></view>
      <view v-if="!canSelect" class="notice">需要代客下单及商品查看权限；不会借用商城会员身份。</view>
      <template v-else>
        <view v-if="draft.current" class="panel">
          <view>当前买家：{{ draft.scope?.uid ? `会员 UID ${draft.scope.uid}` : '本次游客' }}</view>
          <view v-if="draft.pending || draft.needsReview" class="notice">原购物车有正在进行或未确认的操作，核对前不能更换买家。</view>
          <button :disabled="selecting" @tap="openCart">继续当前购物车</button>
        </view>
        <view class="panel"><button :disabled="selecting || draft.pending || draft.needsReview || draft.checkoutLock" @tap="select(0)">为新游客选品</button>
          <view class="hint">游客标识随机生成；刷新网页或退出管理会话后，不能从此页面找回本次游客购物车。购物车不代表已下单，也不锁定库存。</view></view>
        <view v-if="!canRead" class="notice">没有会员查看权限，可使用游客流程。</view>
        <template v-else>
          <view class="panel"><text class="label">昵称、手机号或完整 UID</text><input v-model="keyword" aria-label="搜索买家" placeholder="输入关键词" :maxlength="100" @confirm="load()" />
            <button class="primary" :disabled="loading || selecting" @tap="load()">查询会员</button></view>
          <view v-if="error" class="notice" role="alert">{{ error }}<button size="mini" @tap="load()">重新查询</button></view>
          <view v-if="loading" class="empty" role="status">正在读取会员…</view>
          <view v-else-if="loaded && !items.length && !error" class="empty">没有符合条件的会员</view>
          <view v-for="buyer in items" :key="buyer.uid" class="panel">
            <view class="row"><image v-if="buyer.avatar" :src="buyer.avatar" class="thumb" mode="aspectFill" /><view class="grow"><view class="name">{{ buyer.name || '未设置昵称' }}</view><text class="hint">UID {{ buyer.uid }} · {{ buyer.phone || '未设置手机号' }}</text></view></view>
            <view class="hint">余额 ¥{{ buyer.balance }} · 积分 {{ buyer.points }} · {{ buyer.active ? '正常' : '已停用' }}</view>
            <button :disabled="!buyer.active || loading || !!error || selecting || draft.pending || draft.needsReview || draft.checkoutLock" @tap="select(buyer.uid)">为此会员选品</button>
          </view>
          <button v-if="hasMore" :disabled="loading || selecting" @tap="load(true)">{{ error ? '重试本页' : '加载更多会员' }}</button>
        </template>
      </template>
    </template>
    <view v-if="selectionError" class="notice" role="alert">{{ selectionError }}</view>
    <button @tap="goRecords">查看我的代客订单</button>
    <view class="hint footer">当前已接入选客、选品、购物车及确认订单；收银、代客系统表单及旧版高级筛选仍在迁移中。</view>
    <DiySuspendedNavigation />
  </view>
</template>
<script setup lang="ts">
import { useAssistedBuyers } from '@/composables/useAssistedBuyers';
const { session, draft, canRead, canSelect, account, password, loginBusy, loginError, keyword, items, loading, loaded,
  error, selectionError, selecting, hasMore, login, logout, load, select, openCart } = useAssistedBuyers();
function goRecords() { uni.navigateTo({ url: '/pages/behalf/record/index' }); }
function recoverCheckout() { uni.navigateTo({ url: '/pages/behalf/order_confirm/index?resume=1' }); }
</script>
<style src="../selection.css" scoped></style>
