<template>
  <div class="container bargain-detail">
    <router-link to="/bargain">返回砍价列表</router-link> · <router-link to="/bargain?my=1">选择我的砍价记录</router-link>
    <h2>砍价商品与参与资格</h2>
    <p v-if="loading" role="status">正在读取活动规格与本人参与…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-button v-if="!prepared && !pendingStart" :disabled="loading || busy" @click="load()">刷新规格与资格</el-button>
    <el-button v-if="!authenticated" :disabled="busy || loading" @click="login">登录查看本人资格</el-button>
    <section v-if="detail" class="selection" aria-label="砍价活动规格">
      <ProductImage class="product-image" :src="selectedSku?.image || detail.image" :alt="detail.title" fit="contain" />
      <div class="selection-info">
        <h3>{{ detail.title }}</h3>
        <p>{{ open ? '活动进行中' : '活动未开始或已结束，请刷新确认' }}</p>
        <p>活动起价 ¥{{ detail.activity_price }} · 活动底价 ¥{{ detail.minimum_price }}</p>
        <p>北京时间：{{ formatDate(detail.start_time) }} 至 {{ formatDate(detail.stop_time) }}</p>
        <section v-if="detail.participation" aria-label="当前砍价参与">
          <h4>参与记录 #{{ detail.participation.id }}</h4>
          <p>{{ stateLabel(detail.participation.state) }} · 已砍 ¥{{ detail.participation.cut_price }} · 还需砍 ¥{{ detail.participation.remaining_cut }}</p>
          <el-progress :percentage="detail.participation.progress_percent" />
          <p>参与当前价 ¥{{ detail.participation.current_price }} · 参与底价 ¥{{ detail.participation.minimum_price }}</p>
          <p class="catalog-price">结算参考单价 ¥{{ detail.participation.catalog_price }}</p>
          <p v-if="detail.participation.activity_price_changed" role="status">活动起价已变化，结算参考价可能高于参与底价；请确认服务端最终报价。</p>
        </section>
        <p v-else>{{ authenticated ? '当前没有可识别的有效参与，请发起或从“我的砍价”选择记录。' : '登录后查看自己的参与；不会自动发起砍价。' }}</p>
        <el-button v-if="authenticated && !detail.participation && open" :disabled="loading || busy" @click="start">{{ pendingStart ? '打开已发起的参与' : '发起砍价' }}</el-button>
        <fieldset :disabled="loading || busy || !!prepared || !!pendingStart">
          <legend>选择活动规格</legend>
          <button v-for="sku in detail.skus" :key="sku.unique" type="button" class="sku" :aria-pressed="selected === sku.unique"
            :disabled="sku.max_quantity < 1" @click="choose(sku.unique)">{{ sku.suk || '默认规格' }} · {{ sku.max_quantity ? `最多 ${sku.max_quantity} 件` : '已售罄' }}</button>
          <p v-if="!detail.skus.length">暂无可购买活动规格</p>
          <label for="bargain-quantity">购买数量</label><input id="bargain-quantity" v-model.number="quantity" type="number" min="1" :max="selectedSku?.max_quantity || 1" step="1" />
        </fieldset>
        <p>目录不预留库存或参与资格。选择将绑定本条参与；库存、金额、活动及资格由服务端在结算时重新校验。</p>
        <el-button type="danger" :loading="busy" :disabled="!canBuy" @click="buy">{{ prepared ? '继续结算' : '用本条参与购买' }}</el-button>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiBargainSelection, apiBargainStart } from '@/api/activity';
import { apiCartAdd } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { bargainId, bargainOpen, bargainCartInput, bargainCheckoutQuery, type BargainSelection, type BargainParticipation } from '../../../../common/bargainPurchase';
const route = useRoute(), router = useRouter();
const detail = shallowRef<BargainSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
const loading = ref(false), busy = ref(false), error = ref(''), clock = ref(Date.now()), authenticated = ref(!!captureAuthSession().token);
const prepared = shallowRef<{ cartId: number; participantId: number } | null>(null), pendingStart = ref(0);
let revision = 0, disposed = false, savingPath: string | null = null, timer: ReturnType<typeof setInterval> | undefined;
const selectedSku = computed(() => detail.value?.skus.find(s => s.unique === selected.value));
const open = computed(() => !!detail.value && bargainOpen(detail.value, clock.value));
const canBuy = computed(() => authenticated.value && !loading.value && !busy.value && !!detail.value && (!!prepared.value ||
  open.value && detail.value.can_select && !!selectedSku.value && typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
const stateLabel = (state: BargainParticipation['state']) => ({ cutting: '砍价中', ready: '已完成砍价', closed: '已关闭', used: '已用于订单' })[state];
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '未设期限'; }
function choose(key: string) {
  if (busy.value || loading.value || prepared.value || pendingStart.value || !detail.value?.skus.some(s => s.unique === key && s.max_quantity > 0)) return;
  selected.value = key; quantity.value = 1; error.value = '';
}
async function load(restore = false) {
  if (disposed || (prepared.value || pendingStart.value) && !restore) return;
  const current = ++revision, path = route.fullPath, session = captureAuthSession();
  detail.value = null; selected.value = ''; quantity.value = 1; prepared.value = null; pendingStart.value = 0;
  error.value = ''; loading.value = true; authenticated.value = !!session.token;
  try {
    const id = bargainId(route.params.id), requested = route.query.bargainUserId === undefined ? 0 : bargainId(route.query.bargainUserId);
    // Keep anonymous deep-link identity in the URL, without reading private data.
    const result = await apiBargainSelection(id, session.token ? requested : 0);
    if (disposed || current !== revision || path !== route.fullPath || !isCurrentAuthSession(session)) return;
    detail.value = result;
    if (restore && route.query.sku !== undefined) {
      const sku = route.query.sku, raw = route.query.quantity;
      if (typeof sku !== 'string' || !result.skus.some(s => s.unique === sku && s.max_quantity > 0)) throw new Error('原规格已失效，请重新选择');
      if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9]\d{0,4}$/.test(raw))) throw new Error('原购买数量无效，请重新输入');
      selected.value = sku; quantity.value = raw === undefined ? 1 : Number(raw);
      if (Number(quantity.value) > selectedSku.value!.max_quantity) error.value = '库存已变化，请重新确认数量；不会自动减少购买件数';
    }
  } catch (e) { if (!disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session)) error.value = e instanceof Error ? e.message : '砍价规格加载失败'; }
  finally { if (!disposed && current === revision) loading.value = false; }
}
function intent(participantId?: number) {
  return router.resolve({ path: route.path, query: { ...route.query, bargainUserId: participantId ? String(participantId) : route.query.bargainUserId,
    sku: selected.value || undefined, quantity: selected.value ? String(quantity.value) : undefined }, hash: route.hash }).fullPath;
}
async function login() {
  if (disposed || busy.value || loading.value) return;
  const current = revision, session = captureAuthSession(), redirect = intent(); busy.value = true; error.value = '';
  try { if (await router.push({ path: '/login', query: { redirect } }) && !disposed && current === revision && isCurrentAuthSession(session)) error.value = '登录页面打开失败，请重试'; }
  catch { if (!disposed && current === revision && isCurrentAuthSession(session)) error.value = '登录页面打开失败，请重试'; }
  finally { busy.value = false; }
}
async function start() {
  if (disposed || busy.value || loading.value || !authenticated.value || !detail.value || detail.value.participation || !bargainOpen(detail.value)) return;
  const current = revision, session = captureAuthSession(), path = route.fullPath, id = detail.value.bargain_id;
  const valid = () => !disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session);
  busy.value = true; error.value = '';
  try {
    if (!pendingStart.value) { const result = await apiBargainStart(id); if (!valid()) return; pendingStart.value = bargainId(String(result.id)); }
    if (await router.push({ path: route.path, query: { bargainUserId: String(pendingStart.value) } }) && valid()) error.value = '参与已发起，页面打开失败；可重试打开，不会再次发起';
  } catch (e) { if (valid()) error.value = pendingStart.value ? '参与已发起，请重试打开或到我的砍价查看' : `${e instanceof Error ? e.message : '发起失败'}；请先刷新我的砍价确认结果，不会自动重试`; }
  finally { busy.value = false; }
}
async function buy() {
  if (!canBuy.value || !detail.value) return;
  const current = revision, session = captureAuthSession(), startingPath = route.fullPath;
  const selection = detail.value, sku = selected.value, count = Number(quantity.value);
  const participantId = prepared.value?.participantId ?? selection.participation!.id, redirect = intent(participantId);
  const valid = () => !disposed && current === revision && route.fullPath === redirect && isCurrentAuthSession(session);
  busy.value = true; error.value = '';
  try {
    if (!prepared.value) bargainCartInput(selection, sku, count);
    if (route.fullPath !== redirect) {
      savingPath = redirect;
      try { if (await router.replace(redirect)) return; }
      finally { if (savingPath === redirect) savingPath = null; }
    }
    if (!valid()) return;
    if (!prepared.value) {
      const input = bargainCartInput(selection, sku, count), result = await apiCartAdd(input);
      if (!valid()) return;
      prepared.value = { cartId: bargainId(String(result.id)), participantId: input.bargainUserId };
    }
    const purchase = prepared.value;
    if (await router.push({ path: '/checkout', query: bargainCheckoutQuery(purchase.cartId, purchase.participantId) }) && valid()) error.value = '结算页面打开失败，可继续结算，无需重新加购';
  } catch (e) {
    if (!disposed && current === revision && [startingPath, redirect].includes(route.fullPath) && isCurrentAuthSession(session)) {
      if (!prepared.value) { detail.value = null; selected.value = ''; }
      error.value = prepared.value ? '结算页面打开失败，可继续结算，无需重新加购' : `${e instanceof Error ? e.message : '加购失败'}；请刷新资格后重新确认`;
    }
  } finally { busy.value = false; }
}
watch(() => route.fullPath, () => { if (route.fullPath !== savingPath) void load(true); }, { immediate: true });
const unbind = onAuthChange(() => { prepared.value = null; pendingStart.value = 0; void load(); });
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => { disposed = true; revision++; unbind(); if (timer) clearInterval(timer); });
</script>
<style scoped>
.bargain-detail { padding-top: 20px; padding-bottom: 32px; } h2 { margin: 16px 0; }
.selection { display: flex; gap: 28px; padding: 24px; margin-top: 20px; background: white; border-radius: 8px; }
.product-image { width: 40%; max-width: 400px; aspect-ratio: 1; align-self: flex-start; }
.selection-info { flex: 1; min-width: 0; overflow-wrap: anywhere; } p { margin: 12px 0; line-height: 1.6; }
fieldset { border: 1px solid #ddd; padding: 12px; margin-top: 16px; }
.sku { background: white; border: 1px solid #aaa; padding: 10px; margin: 4px; border-radius: 4px; cursor: pointer; }
.sku[aria-pressed='true'] { border: 2px solid #b32421; color: #b32421; } button:disabled { opacity: .55; cursor: not-allowed; }
input { width: 80px; padding: 8px; margin-left: 8px; } .catalog-price { font-size: 22px; color: #b32421; }
@media (max-width: 680px) { .selection { flex-direction: column; padding: 12px; } .product-image { width: 100%; max-width: 100%; } }
</style>
