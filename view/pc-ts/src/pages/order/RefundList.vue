<template>
  <div class="refund-history container">
    <h2>售后退款记录</h2>
    <el-tabs :model-value="state.filter" @tab-change="setFilter">
      <el-tab-pane v-for="item in refundFilters" :key="item.key" :name="item.key" :label="item.label" />
    </el-tabs>
    <div class="history-tools">
      <el-input v-model="search" :maxlength="80" placeholder="退款单号或订单编号" aria-label="退款记录搜索" @keyup.enter="applySearch" />
      <el-button :disabled="busy" @click="applySearch">搜索</el-button>
      <el-button :disabled="busy" @click="load()">刷新列表</el-button>
      <router-link to="/order">我的订单</router-link>
    </div>
    <el-alert v-if="state.error || routeError || navigationError" :title="routeError || state.error || navigationError" type="warning" :closable="false" />
    <p v-if="state.loading" role="status">正在读取退款记录…</p>
    <p v-if="state.ready">已加载 {{ list.length }} 笔记录</p>
    <div v-for="row in list" :key="row.id" class="history-card">
      <div class="history-heading"><strong>{{ row.refundNo }}</strong><span>{{ refundStatus(row) }}</span></div>
      <p>订单编号：{{ row.orderId }}</p>
      <p>{{ row.refundReason }} · {{ row.refundNum }} 件</p>
      <p>退款金额 ¥{{ row.refundPrice }} · 已退金额 ¥{{ row.refundedPrice }}</p>
      <div class="history-heading"><span>{{ refundTime(row.addTime) }}</span><el-button :disabled="busy || !!state.error" @click="goDetail(row)">查看详情</el-button></div>
    </div>
    <p v-if="state.ready && !state.loading && !state.error && !list.length">当前筛选下暂无退款记录</p>
    <el-button v-if="state.error" :disabled="busy" @click="load(list.length > 0)">重试读取</el-button>
    <el-button v-else-if="state.cursor" :disabled="busy" @click="load(true)">加载更多</el-button>
    <p v-else-if="state.ready && list.length">已加载全部匹配记录</p>
  </div>
</template>
<script setup lang="ts">
import { useRefundRecords } from '@/composables/useRefundRecords';
import { refundFilters, refundStatus, refundTime } from '../../../../common/refundRecords';
const { state, list, search, busy, navigationError, routeError, load, goDetail, setFilter, applySearch } = useRefundRecords('list');
</script>
<style scoped>
.refund-history { max-width: 1000px; padding-bottom: 32px; }
h2 { margin: 24px 0; }
.history-tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
.history-tools .el-input { width: 300px; max-width: 100%; }
.history-card { padding: 20px; border: 1px solid #eee; background: white; border-radius: 8px; margin: 16px 0; }
.history-heading { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: center; }
p, strong { overflow-wrap: anywhere; line-height: 1.6; }
.history-card p { color: #666; margin: 8px 0; }
</style>
