<template>
  <section class="presale-catalog">
    <h1>预售专区</h1>
    <p class="notice">全款预售 · 时间为北京时间。列表价格仅供参考，购买资格以详情与结算校验为准。</p>
    <div class="filters" aria-label="预售状态">
      <button v-for="filter in PRESALE_FILTERS" :key="filter.id" :aria-pressed="state.type === filter.id"
        :disabled="navigating" @click="session.select(filter.id)">{{ filter.name }}</button>
      <button :disabled="state.loading || navigating" @click="session.load()">刷新列表</button>
    </div>
    <p v-if="state.error" class="error" role="alert">{{ state.error }} <button :disabled="state.loading || navigating" @click="session.load(state.page > 0)">重试加载</button></p>
    <div class="products">
      <article v-for="item in state.list" :key="item.id" class="product">
        <img v-if="item.image" :src="item.image" alt="" class="product-image" />
        <div v-if="item.brand" class="brand">{{ item.brand }}</div>
        <h2>{{ item.name }}</h2>
        <div class="labels"><span v-for="label in item.labels" :key="label.id" class="label"
          :style="{ color: label.color, backgroundColor: label.background, borderColor: label.border }">
          <img v-if="label.icon" :src="label.icon" alt="" />{{ label.name }}</span></div>
        <p class="price">参考价 ¥{{ item.price }}</p>
        <p class="schedule">{{ state.type === 1 ? '开始' : '结束' }}：{{ presaleBeijingTime(state.type === 1 ? item.starts : item.ends) }}</p>
        <p class="schedule">预售结束后 {{ item.shippingDays }} 天内发货</p>
        <button :disabled="state.loading || navigating" @click="openProduct(item.id)">查看规格与购买规则</button>
      </article>
    </div>
    <p v-if="state.loading" role="status">正在加载预售商品…</p>
    <p v-else-if="!state.error && !state.list.length" class="notice">当前状态暂无预售商品</p>
    <button v-if="state.list.length < state.count && !state.error" :disabled="state.loading || navigating" @click="session.load(true)">加载更多</button>
    <p v-else-if="state.list.length && !state.loading && !state.error" class="notice">已加载全部 {{ state.count }} 件商品</p>
  </section>
</template>
<script setup lang="ts">
import { reactive, ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { onAuthChange } from '@/utils/auth';
import { apiPresaleCatalog } from '@/api/presale';
import { createPresaleCatalogSession, newPresaleCatalog, PRESALE_FILTERS, presaleBeijingTime } from '../../../../common/presaleCatalog';
const router = useRouter(), state = reactive(newPresaleCatalog()), navigating = ref(false);
let active = true, navigationRevision = 0;
const session = createPresaleCatalogSession(state, apiPresaleCatalog, () => active);
const unbind = onAuthChange(() => {
  navigationRevision++; navigating.value = false; session.reset(); state.error = '登录状态已变化，请刷新预售列表';
});
async function openProduct(id: number) {
  if (!active || state.loading || navigating.value || !state.list.some(row => row.id === id)) return;
  const revision = ++navigationRevision; navigating.value = true;
  try { if (await router.push(`/presale/${id}`)) throw new Error('navigation failed'); }
  catch { if (active && revision === navigationRevision) state.error = '预售详情打开失败，请重试'; }
  finally { if (active && revision === navigationRevision) navigating.value = false; }
}
onMounted(() => { void session.load(); });
onBeforeUnmount(() => { active = false; navigationRevision++; session.dispose(); unbind(); });
</script>
<style scoped>
.presale-catalog{max-width:1200px;margin:24px auto;padding:0 20px;color:#292534}.notice,.schedule,.brand{color:#686473;line-height:1.6}.filters{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}button{border:1px solid #d8cce9;background:white;border-radius:8px;padding:10px 16px;color:#593481;cursor:pointer}button[aria-pressed=true]{background:#6946a1;color:white}button:disabled{opacity:.5;cursor:default}.products{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:20px;margin:24px 0}.product{padding:20px;border:1px solid #e7e3ed;border-radius:12px;background:white;min-width:0}.product-image{width:100%;height:180px;object-fit:cover}.product h2{font-size:18px;overflow-wrap:anywhere}.labels{display:flex;flex-wrap:wrap;gap:6px}.label{font-size:12px;border:1px solid;border-radius:4px;padding:2px 6px;overflow-wrap:anywhere;max-width:100%}.label img{width:14px;height:14px;margin-right:4px}.price{color:#9b2d52;font-size:18px}.schedule{font-size:13px}.error{color:#a32626;overflow-wrap:anywhere}
</style>
