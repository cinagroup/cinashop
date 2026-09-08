<template>
  <div class="container seckill-detail">
    <router-link to="/seckill">返回秒杀列表</router-link>
    <h2>秒杀商品</h2>
    <p v-if="loading" role="status">正在加载活动规格…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button :disabled="loading || buying" @click="load">刷新活动与规格</el-button>
    <section v-if="detail" class="selection" aria-label="秒杀活动规格">
      <img class="product-image" :src="selectedSku?.image || detail.image || placeholder" :alt="detail.title" />
      <div class="selection-info">
        <h3>{{ detail.title }}</h3>
        <p role="status">{{ open ? detail.schedule.message : detail.schedule.state === 'active' ? '当前场次已变化，请刷新活动' : detail.schedule.message }}</p>
        <p>北京时间 · 每单限购 {{ detail.once_limit }} 件 · 累计限购 {{ detail.total_limit }} 件</p>
        <fieldset :disabled="buying || loading">
          <legend>选择活动规格</legend>
          <button v-for="sku in detail.skus" :key="sku.unique" type="button" class="sku"
            :aria-pressed="selected === sku.unique" :disabled="sku.max_quantity < 1" @click="choose(sku.unique)">
            {{ sku.suk || '默认规格' }} · ¥{{ sku.catalog_price }}{{ sku.max_quantity < 1 ? ' · 已售罄' : '' }}
          </button>
          <p v-if="!detail.skus.length">暂无可购买规格</p>
          <p v-if="selectedSku" class="catalog-price">活动参考价 ¥{{ selectedSku.catalog_price }}</p>
          <label for="seckill-quantity">购买数量</label>
          <input id="seckill-quantity" v-model.number="quantity" type="number" min="1" :max="selectedSku?.max_quantity || 1" step="1" />
        </fieldset>
        <p>仅展示活动规格；库存和限购余量并未预留，最终价格与购买资格由服务端重新校验。</p>
        <el-button type="danger" :loading="buying" :disabled="!canBuy" @click="buy">立即抢购</el-button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiSeckillSelection } from '@/api/activity';
import { apiCartAdd } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { seckillCartInput, seckillId, seckillOpen, type SeckillSelection } from '../../../../common/seckillPurchase';

const route = useRoute(), router = useRouter();
const detail = shallowRef<SeckillSelection | null>(null);
const selected = ref(''), quantity = ref<number | string>(1), error = ref(''), loading = ref(false), buying = ref(false);
const clock = ref(Date.now());
let revision = 0, disposed = false, restoredQueryFor = 0, timer: ReturnType<typeof setInterval> | undefined;
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
const open = computed(() => !!detail.value && seckillOpen(detail.value, clock.value));
const canBuy = computed(() => !loading.value && !buying.value && open.value && !!selectedSku.value &&
  typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity);
function choose(key: string) { selected.value = key; quantity.value = 1; error.value = ''; }
async function load() {
  const current = ++revision;
  detail.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true;
  try {
    const id = seckillId(route.params.id);
    const result = await apiSeckillSelection(id);
    if (disposed || current !== revision) return;
    detail.value = result;
    // Restore a login/deep-link selection once, not on every refresh after a rejection.
    const requested = restoredQueryFor !== id && typeof route.query.sku === 'string' ? route.query.sku : '';
    restoredQueryFor = id;
    const sku = result.skus.find(sku => sku.unique === requested && sku.max_quantity > 0);
    if (sku) {
      selected.value = sku.unique;
      const count = typeof route.query.quantity === 'string' && /^[1-9]\d{0,4}$/.test(route.query.quantity) ? Number(route.query.quantity) : 1;
      quantity.value = count;
      if (count > sku.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
    }
  } catch (e) {
    if (!disposed && current === revision) error.value = (e as Error).message || '秒杀商品加载失败';
  } finally { if (!disposed && current === revision) loading.value = false; }
}
async function buy() {
  if (!canBuy.value || !detail.value) return;
  const current = revision, session = captureAuthSession();
  const selection = detail.value, key = selected.value, count = Number(quantity.value), startingPath = route.fullPath;
  const redirect = router.resolve({ path: route.path, query: { ...route.query, sku: key, quantity: String(count) }, hash: route.hash }).fullPath;
  buying.value = true; error.value = '';
  try {
    // The request layer returns to window.location if an existing token expires.
    // Persist this validated intent before either login or a write, not just for anonymous buyers.
    seckillCartInput(selection, key, count);
    if (route.fullPath !== redirect && await router.replace(redirect)) return;
    if (disposed || current !== revision || route.fullPath !== redirect || !isCurrentAuthSession(session)) return;
    if (!session.token) {
      await router.push({ path: '/login', query: { redirect } }); return;
    }
    // A navigation guard may have waited across the end of the activity window.
    const input = seckillCartInput(selection, key, count);
    const cart = await apiCartAdd(input);
    if (disposed || current !== revision || route.fullPath !== redirect || !isCurrentAuthSession(session)) return;
    if (!Number.isSafeInteger(cart.id) || cart.id < 1) throw new Error('购买记录响应无效，请刷新活动');
    await router.push({ path: '/checkout', query: { mode: 'buy', cartId: String(cart.id), type: '1', seckillId: String(input.activityId) } });
  } catch (e) {
    if (!disposed && current === revision && (route.fullPath === startingPath || route.fullPath === redirect) && isCurrentAuthSession(session)) {
      // Never silently switch SKUs/prices or automatically retry a write.
      detail.value = null; selected.value = '';
      error.value = (e as Error).message || '购买失败，请刷新活动重新确认';
    }
  } finally { buying.value = false; }
}
watch(() => route.params.id, load, { immediate: true });
const unbind = onAuthChange(() => { void load(); });
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => { disposed = true; revision++; unbind(); if (timer) clearInterval(timer); });
</script>

<style scoped>
.seckill-detail { padding-top: 20px; padding-bottom: 32px; }
.seckill-detail h2 { margin: 12px 0; }
.selection-info p { margin: 10px 0; line-height: 1.6; }
.selection { display: flex; gap: 28px; margin-top: 20px; padding: 24px; background: white; border-radius: 8px; }
.product-image { width: 40%; max-width: 400px; align-self: flex-start; aspect-ratio: 1; object-fit: contain; }
.selection-info { min-width: 0; flex: 1; overflow-wrap: anywhere; }
fieldset { border: 1px solid #ddd; padding: 12px; }
.sku { padding: 10px; margin: 4px; background: white; border: 1px solid #aaa; border-radius: 4px; cursor: pointer; }
.sku[aria-pressed='true'] { border: 2px solid #e64340; color: #b32421; }
.sku:disabled { cursor: not-allowed; opacity: .5; }
.catalog-price { font-size: 22px; color: #b32421; }
input { width: 80px; padding: 8px; margin-left: 8px; }
@media (max-width: 680px) { .selection { flex-direction: column; padding: 12px; } .product-image { width: 100%; max-width: 100%; } }
</style>
