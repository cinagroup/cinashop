<template>
  <div class="coupon-list container">
    <h2 class="title">我的优惠券</h2>
    <el-tabs :model-value="String(activeType)" @update:model-value="onTabChange">
      <el-tab-pane :label="`未使用（${state.counts?.not_used ?? '—'}）`" name="0" />
      <el-tab-pane :label="`已使用（${state.counts?.used ?? '—'}）`" name="1" />
      <el-tab-pane :label="`已过期/失效（${state.counts?.expired ?? '—'}）`" name="2" />
      <el-tab-pane :label="`订单占用中（${state.counts?.reserved ?? '—'}）`" name="3" />
    </el-tabs>
    <div class="filters" role="group" aria-label="优惠券筛选">
      <button v-for="filter in filters" :key="String(filter.value)" type="button" :aria-pressed="activeFilter === filter.value" @click="switchFilter(filter.value)">{{ filter.name }}</button>
    </div>
    <p>数量按当前筛选统计，未支付订单占用单列；状态可能随订单或时间变化。{{ !state.loading && !state.counts ? '数量暂不可用，可刷新重试。' : '' }}</p>
    <p>适用商品、门槛及首单互斥，以结算页的服务端报价为准。</p>
    <el-button :disabled="state.loading" @click="load(false)">刷新优惠券</el-button>
    <p v-if="state.loading" role="status">正在加载优惠券…</p>
    <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon />
    <el-button v-if="state.error" :disabled="state.loading" @click="load(state.nextCursor !== null)">重试加载优惠券</el-button>
    <CouponCards :coupons="state.list" browsable inspectable :disabled="blocked" @browse="browse" @inspect="openDetail" />
    <el-empty v-if="!state.loading && !state.error && !state.list.length" description="该状态下暂无优惠券" />
    <el-button v-if="state.nextCursor !== null" :disabled="state.loading" @click="load(true)">加载更多优惠券</el-button>
    <p v-else-if="!state.loading && !state.error && state.list.length">已加载全部优惠券</p>
    <el-dialog :model-value="detail !== null" title="优惠券详情与规则" width="min(560px, 92vw)" destroy-on-close @update:model-value="onDialogChange">
      <div v-if="detail" class="coupon-rules">
        <h3>{{ detail.title }} · {{ detail.benefit }}</h3>
        <p>使用门槛：{{ detail.minimum === '0.00' ? '无门槛' : '满' + detail.minimum + '元' }}</p>
        <p>适用范围：{{ detail.scope }}</p><p>有效期：{{ detail.validity }}</p><p>状态：{{ detail.message }}</p>
        <p class="rule">用券规则：{{ detail.rule || '商家未配置具体规则' }}</p>
        <el-alert v-if="detail.ruleTruncated" title="规则过长，仅展示部分内容，请联系商家确认完整规则。" type="warning" :closable="false" />
        <p>是否可用于具体商品、可抵扣金额及叠加规则，以结算页服务端报价为准。浏览商品不会自动使用此券。</p>
        <el-button v-if="detail.availability === 'available'" :disabled="blocked" @click="browse(detail.id)">浏览券范围商品</el-button>
        <el-button @click="closeDetail">关闭详情</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { onUnmounted } from "vue";
import CouponCards from "@/components/CouponCards.vue";
import { useRouter } from "vue-router";
import { createCouponWalletView } from "@/composables/couponWalletView";
import type { WalletFilter } from "@/api/user";
const router = useRouter();
const filters: { value: WalletFilter; name: string }[] = [{ value: null, name: "全部" }, { value: -1, name: "24小时内到期" }, { value: 0, name: "通用券" }, { value: 1, name: "品类券" }, { value: 2, name: "商品券" }, { value: 3, name: "品牌券" }];
const view = createCouponWalletView(path => { void router.push(path); });
const { activeType, activeFilter, state, blocked, detail, load, switchTab, switchFilter, openDetail, closeDetail, browse } = view;
function onTabChange(value: string | number) { void switchTab(Number(value)); }
function onDialogChange(value: boolean) { if (!value) closeDetail(); }
void load(); onUnmounted(view.dispose);
</script>
<style scoped>
.title { font-size: 20px; margin: 20px 0; }
.coupon-list > p,.coupon-rules { color: #666; line-height: 1.6; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.filters button { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; color: #555; background: white; cursor: pointer; }
.filters button[aria-pressed="true"] { background: #b52b21; color: white; border-color: #b52b21; }
.coupon-rules { overflow-wrap: anywhere; max-height: 65vh; overflow-y: auto; }.rule { white-space: pre-wrap; }
</style>
