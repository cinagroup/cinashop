<template>
  <div class="coupon-list container">
    <h2 class="title">我的优惠券</h2>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="未使用" name="0" /><el-tab-pane label="已使用" name="1" />
      <el-tab-pane label="已过期/失效" name="2" /><el-tab-pane label="订单占用中" name="3" />
    </el-tabs>
    <p>适用商品、门槛及首单互斥，以结算页的服务端报价为准。</p>
    <el-button :disabled="state.loading" @click="wallet.load(Number(activeTab))">刷新优惠券</el-button>
    <p v-if="state.loading" role="status">正在加载优惠券…</p>
    <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" show-icon />
    <el-button v-if="state.error" :disabled="state.loading" @click="wallet.load(Number(activeTab), state.list.length > 0)">重试加载优惠券</el-button>
    <CouponCards :coupons="state.list" browsable :disabled="state.loading || !!state.error" @browse="browse" />
    <el-empty v-if="!state.loading && !state.error && !state.list.length" description="该状态下暂无优惠券" />
    <el-button v-if="state.nextCursor" :disabled="state.loading" @click="wallet.load(Number(activeTab), true)">加载更多优惠券</el-button>
  </div>
</template>
<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from "vue";
import { apiMyCoupons } from "@/api/user";
import { CouponWalletSession, type CouponWalletState } from "@/api/couponWallet";
import CouponCards from "@/components/CouponCards.vue";
import { useRouter } from "vue-router";
import { isLoggedIn, onAuthChange } from "@/utils/auth";
const router = useRouter();
const activeTab = ref("0");
const state = shallowRef<CouponWalletState>({ list: [], nextCursor: null, loading: false, error: "" });
const wallet = new CouponWalletSession(apiMyCoupons, (next) => { state.value = next; });
watch(activeTab, (status) => { void wallet.load(Number(status)); }, { immediate: true, flush: "sync" });
const unbind = onAuthChange(() => { wallet.reset(); state.value = { ...state.value, error: "登录状态已变化，请刷新后重新加载" }; });
function browse(id: number) {
  if (isLoggedIn() && !state.value.loading && !state.value.error && state.value.list.some(c => c.id === id && c.availability === "available")) void router.push(`/user/coupon/${id}/products`);
}
onUnmounted(() => { unbind(); wallet.reset(); });
</script>
<style scoped>
.title { font-size: 20px; margin: 20px 0; }
.coupon-list > p { color: #666; line-height: 1.6; }
</style>
