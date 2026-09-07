<template>
  <section class="scope-page container">
    <h2>券范围商品</h2><p v-if="state.loaded" class="summary">{{ state.title }} · {{ scopeLabel }}</p>
    <p class="notice">这里只展示券范围内当前可见的商品。目录价不是会员价或用券后价格；库存、门槛和活动互斥以结算页服务端报价为准。进入详情不会自动使用优惠券。</p>
    <section v-if="state.loaded && !error" class="scope-definition" aria-label="配置范围总览">
      <h3>配置范围总览</h3>
      <p>以下是商家配置的范围，不是当前可购买商品数量。品类/品牌包含下级，商品包含关联子商品；名称不提供直接购买入口。</p>
      <el-button :disabled="state.loading || scopeState.loading" @click="loadScope(false)">{{ scopeState.loaded ? '刷新配置范围' : '查看配置范围' }}</el-button>
      <p v-if="scopeState.loading" role="status">正在读取范围说明…</p>
      <div v-if="scopeState.error" role="alert"><p>{{ scopeState.error }}</p><el-button :disabled="scopeState.loading || state.loading" @click="loadScope(scopeState.nextCursor !== null)">重试范围说明</el-button></div>
      <template v-if="scopeState.loaded">
        <p v-if="scopeState.scopeType === 0">通用范围，无指定配置集合；能否用券仍以结算为准。</p>
        <p v-else>已读取 {{ scopeState.entries.length }} / {{ scopeState.total }} 个配置项。{{ !scopeState.total ? '未配置范围，不代表全店通用。' : '' }}</p>
        <ul class="scope-names"><li v-for="entry in scopeState.entries" :key="entry.id">
          <span v-for="ancestor in entry.ancestors" :key="ancestor.id">{{ ancestor.name ?? '名称不可见或已移除' }} / </span><strong>{{ entry.name ?? '名称不可见或已移除' }}</strong>
          <span v-if="!entry.hierarchyComplete">（层级不完整或配置不一致，请联系商家确认）</span>
        </li></ul>
        <el-button v-if="scopeState.nextCursor !== null" :disabled="scopeState.loading || state.loading" @click="loadScope(true)">继续读取配置范围</el-button>
      </template>
    </section>
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
const { state, scopeState, error, blocked, scopeLabel, load, loadScope, openProduct } = view;
watch(() => [route.name, route.params.id] as const, ([name, value]) => { void view.setRoute(name, value); }, { immediate: true, flush: "sync" });
onUnmounted(view.dispose);
</script>
<style scoped>
.scope-page { padding-top: 24px; padding-bottom: 40px; overflow-wrap: anywhere; }.summary { font-weight: 600; }.notice { color: #666; line-height: 1.7; }
.scope-definition { background: #fff; border: 1px solid #ddd; border-radius: 10px; margin: 20px 0; padding: 20px; line-height: 1.7; }.scope-names { max-height: 280px; overflow-y: auto; padding-left: 22px; }.scope-names li { margin: 8px 0; }
.scope-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 20px; list-style: none; padding: 0; margin: 24px 0; }.scope-product { background: white; border: 1px solid #ddd; border-radius: 10px; padding: 20px; min-width: 0; }.scope-product img { width: 100%; height: 180px; object-fit: contain; }.scope-product h3 { font-size: 18px; }.scope-product p,.error { color: #b72a1d; }
</style>
