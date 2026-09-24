<template>
  <div class="container presale-detail">
    <router-link to="/goods">返回商品列表</router-link>
    <h1>全款预售</h1>
    <p v-if="loading" role="status">正在加载预售规格与购买规则…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button v-if="!prepared" :disabled="loading || buying" @click="load()">刷新预售商品</el-button>
    <section v-if="detail" class="selection" aria-label="预售商品规格">
      <ProductImage class="product-image" :src="selectedSku?.image || detail.image" :alt="detail.title" fit="contain" />
      <div class="selection-info">
        <h2>{{ detail.title }}</h2>
        <p>{{ detail.subtitle }}</p>
        <p role="status">{{ statusText }}</p>
        <p>北京时间：{{ formatDate(detail.schedule.start_time) }} 至 {{ formatDate(detail.schedule.stop_time) }}</p>
        <p>预售结束后 {{ detail.schedule.shipping_days_after_end }} 天内发货；发货、自提及自动交付均须等待预售结束。</p>
        <p v-if="detail.purchase_limits.mode === 'per_order'">每单限购 {{ detail.purchase_limits.quantity }} 件</p>
        <p v-else-if="detail.purchase_limits.mode === 'cumulative'" role="status">累计限购预售暂未开放，当前不可结算。</p>
        <fieldset :disabled="buying || !!prepared || loading">
          <legend>选择商品规格</legend>
          <button v-for="sku in detail.skus" :key="sku.unique" type="button" class="sku"
            :aria-pressed="selected === sku.unique" :disabled="sku.max_quantity < 1" @click="choose(sku.unique)">
            {{ sku.suk || '默认规格' }} · ¥{{ sku.catalog_price }}{{ sku.stock < 1 ? ' · 已售罄' : sku.max_quantity < 1 ? ' · 暂不可购买' : '' }}
          </button>
          <p v-if="!detail.skus.length">暂无可购买规格</p>
          <p v-if="selectedSku" class="catalog-price">商品参考价 ¥{{ selectedSku.catalog_price }}</p>
          <p v-if="selectedSku">库存 {{ selectedSku.stock }} {{ detail.unit_name }} · 当前最多可选 {{ selectedSku.max_quantity }} {{ detail.unit_name }}</p>
          <label for="presale-quantity">购买数量</label>
          <input id="presale-quantity" v-model.number="quantity" type="number" min="1" :max="selectedSku?.max_quantity || 1" step="1" />
        </fieldset>
        <p>一次支付全款，无定金或尾款。会员价、积分抵扣、运费和最终应付以结算页报价为准；选择规格不预留库存。</p>
        <p v-if="prepared" role="status">购买记录已创建，继续结算不会重复加购。</p>
        <el-button type="danger" :loading="buying" :disabled="!canBuy" @click="buy">{{ prepared ? '继续结算' : '立即预订' }}</el-button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import ProductImage from '@/components/ProductImage.vue';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiPresaleSelection } from '@/api/presale';
import { apiCartAdd } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { presaleProductId, presaleOpen, presaleCartInput, presaleCheckoutQuery, type PresaleSelection } from '../../../../common/presalePurchase';

const route = useRoute(), router = useRouter();
const detail = shallowRef<PresaleSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
const error = ref(''), loading = ref(false), buying = ref(false), clock = ref(Date.now()), prepared = ref<number | null>(null);
let revision = 0, disposed = false, savingPath: string | null = null, timer: ReturnType<typeof setInterval> | undefined;
const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
const open = computed(() => !!detail.value && presaleOpen(detail.value, clock.value));
const statusText = computed(() => detail.value?.purchase_limits.mode === 'cumulative' ? '累计限购模式暂未开放' :
  open.value ? '预售进行中' : detail.value?.schedule.state === 'future' ? '预售尚未开始，请开始后刷新' : '当前不可预订，请刷新确认时间');
const canBuy = computed(() => !loading.value && !buying.value && !!detail.value && (prepared.value !== null ||
  open.value && !!selectedSku.value && typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) &&
  quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
function formatDate(seconds: number) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(seconds * 1000));
}
function choose(key: string) {
  if (buying.value || prepared.value || loading.value || !detail.value?.skus.some(sku => sku.unique === key && sku.max_quantity > 0)) return;
  selected.value = key; quantity.value = 1; error.value = '';
}
async function load(restore = false) {
  if (disposed || prepared.value !== null && !restore) return;
  const current = ++revision, path = route.fullPath, session = captureAuthSession();
  detail.value = null; prepared.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true; buying.value = false;
  try {
    const id = presaleProductId(route.params.id), result = await apiPresaleSelection(id);
    if (disposed || current !== revision || path !== route.fullPath || !isCurrentAuthSession(session)) return;
    detail.value = result;
    if (restore && route.query.sku !== undefined) {
      const requested = route.query.sku, raw = route.query.quantity;
      if (typeof requested !== 'string' || !result.skus.some(sku => sku.unique === requested && sku.max_quantity > 0)) throw new Error('原规格已失效，请重新选择');
      if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9]\d{0,4}$/.test(raw))) throw new Error('原购买数量无效，请重新输入');
      selected.value = requested; quantity.value = raw === undefined ? 1 : Number(raw);
      if (Number(quantity.value) > selectedSku.value!.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
    }
  } catch (e) {
    if (!disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session)) error.value = e instanceof Error ? e.message : '预售规格加载失败';
  } finally { if (!disposed && current === revision) loading.value = false; }
}
async function buy() {
  if (!canBuy.value || !detail.value) return;
  const current = revision, session = captureAuthSession(), startingPath = route.fullPath;
  const selection = detail.value, key = selected.value, count = Number(quantity.value);
  const redirect = router.resolve({ path: route.path, query: { sku: key, quantity: String(count) } }).fullPath;
  buying.value = true; error.value = '';
  const valid = () => !disposed && current === revision && route.fullPath === redirect && isCurrentAuthSession(session);
  try {
    if (prepared.value === null) presaleCartInput(selection, key, count);
    if (route.fullPath !== redirect) {
      savingPath = redirect;
      try { if (await router.replace(redirect)) return; }
      finally { if (savingPath === redirect) savingPath = null; }
    }
    if (!valid()) return;
    if (!session.token) {
      if (await router.push({ path: '/login', query: { redirect } }) && valid()) error.value = '登录页面打开失败，请重试';
      return;
    }
    if (prepared.value === null) {
      // Recheck the actual clock after asynchronous route guards, not the UI timer.
      const cart = await apiCartAdd(presaleCartInput(selection, key, count));
      if (!valid()) return;
      if (!Number.isSafeInteger(cart.id) || cart.id < 1 || cart.id > 2_147_483_647) throw new Error('购买记录响应无效，请刷新商品');
      prepared.value = cart.id;
    }
    if (await router.push({ path: '/checkout', query: presaleCheckoutQuery(prepared.value) }) && valid()) {
      error.value = '结算页面打开失败，可继续结算，无需重新加购';
    }
  } catch (e) {
    if (!disposed && current === revision && (route.fullPath === startingPath || route.fullPath === redirect) && isCurrentAuthSession(session)) {
      if (prepared.value === null) { detail.value = null; selected.value = ''; }
      error.value = prepared.value !== null ? '结算页面打开失败，可继续结算，无需重新加购' : e instanceof Error ? e.message : '购买失败，请刷新商品重新确认';
    }
  } finally { if (current === revision) buying.value = false; }
}
watch(() => route.fullPath, () => { if (route.fullPath !== savingPath) void load(true); }, { immediate: true });
const unbind = onAuthChange(() => { prepared.value = null; void load(); });
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => { disposed = true; revision++; unbind(); if (timer) clearInterval(timer); });
</script>

<style scoped>
.presale-detail { padding-top: 20px; padding-bottom: 32px; }
h1 { margin: 12px 0; font-size: 24px; }
.selection { display: flex; gap: 28px; margin-top: 20px; padding: 24px; background: white; border-radius: 8px; }
.product-image { width: 40%; max-width: 400px; aspect-ratio: 1; object-fit: contain; align-self: flex-start; }
.selection-info { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.selection-info p { margin: 10px 0; line-height: 1.6; }
fieldset { min-width: 0; border: 1px solid #ddd; padding: 12px; margin-bottom: 16px; }
.sku { padding: 10px; margin: 4px; background: white; border: 1px solid #aaa; border-radius: 4px; cursor: pointer; }
button[aria-pressed='true'] { border: 2px solid #e64340; color: #b32421; }
button:disabled { cursor: not-allowed; opacity: .55; }
.catalog-price { font-size: 22px; color: #b32421; }
input { width: 80px; padding: 8px; margin-left: 8px; }
@media (max-width: 680px) { .selection { flex-direction: column; padding: 12px; } .product-image { width: 100%; max-width: 100%; } }
</style>
