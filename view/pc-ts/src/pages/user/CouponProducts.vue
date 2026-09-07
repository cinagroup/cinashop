<template>
  <section class="scope-page container">
    <h2>券范围商品</h2><p v-if="state.loaded" class="summary">{{ state.title }} · {{ scopeLabel }}</p>
    <p class="notice">这里只展示券范围内当前可见的商品。目录价不是会员价或用券后价格；库存、门槛和活动互斥以结算页服务端报价为准。进入详情不会自动使用优惠券。</p>
    <el-button :disabled="state.loading" @click="load(false)">刷新范围商品</el-button>
    <p v-if="state.loading" role="status">正在读取券范围商品…</p>
    <div v-if="error" role="alert" class="error"><p>{{ error }}</p><el-button :disabled="state.loading" @click="load(state.nextCursor !== null)">重试加载范围商品</el-button></div>
    <ul class="scope-grid">
      <li v-for="product in state.list" :key="product.id" class="scope-product">
        <img v-if="product.image" :src="product.image" alt="" /><h3>{{ product.title }}</h3><p>目录价 ¥{{ product.catalogPrice }}</p>
        <el-button :disabled="blocked" @click="openProduct(product.id)">查看商品详情</el-button>
      </li>
    </ul>
    <p v-if="!state.loading && !error && state.loaded && !state.list.length">{{ state.nextCursor !== null ? '本批未匹配到范围商品，尚未扫描完，请继续加载。' : '当前券范围内暂无可见商品。' }}</p>
    <el-button v-if="state.nextCursor !== null" :disabled="state.loading" @click="load(true)">继续加载范围商品</el-button>
    <p v-else-if="state.loaded && !state.loading && !error && state.list.length">已读取全部当前范围商品</p>
  </section>
</template>
<script setup lang="ts">
import { onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { createCouponProductsView } from "@/composables/couponProductsView";
const route = useRoute(), router = useRouter();
const view = createCouponProductsView(path => { void router.push(path); });
const { state, error, blocked, scopeLabel, load, openProduct } = view;
watch(() => [route.name, route.params.id] as const, ([name, value]) => { void view.setRoute(name, value); }, { immediate: true, flush: "sync" });
onUnmounted(view.dispose);
</script>
<style scoped>
.scope-page { padding-top: 24px; padding-bottom: 40px; overflow-wrap: anywhere; }.summary { font-weight: 600; }.notice { color: #666; line-height: 1.7; }
.scope-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 20px; list-style: none; padding: 0; margin: 24px 0; }.scope-product { background: white; border: 1px solid #ddd; border-radius: 10px; padding: 20px; min-width: 0; }.scope-product img { width: 100%; height: 180px; object-fit: contain; }.scope-product h3 { font-size: 18px; }.scope-product p,.error { color: #b72a1d; }
</style>
