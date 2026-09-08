<template>
  <div class="container combination-detail">
    <router-link to="/combination">返回拼团列表</router-link>
    <h2>拼团商品</h2>
    <p v-if="loading" role="status">正在加载活动规格与参团资格…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-button v-if="!prepared" :disabled="loading || buying" @click="load()">刷新活动与拼团</el-button>
    <el-button v-if="!detail && !loading && error && selectedGroup" :disabled="buying" @click="discardGroup">放弃指定团并重新选择</el-button>
    <section v-if="detail" class="selection" aria-label="拼团活动规格">
      <img class="product-image" :src="selectedSku?.image || detail.image || placeholder" :alt="detail.title" />
      <div class="selection-info">
        <h3>{{ detail.title }}</h3>
        <p role="status">{{ open ? '拼团活动进行中' : '活动未开始或已结束，请刷新确认' }}</p>
        <p>{{ detail.people }} 人成团 · 每单限购 {{ detail.once_limit }} 件 · 累计限购 {{ detail.total_limit }} 件</p>
        <p>北京时间：{{ formatDate(detail.start_time) }} 至 {{ formatDate(detail.stop_time) }}</p>
        <fieldset :disabled="buying || !!prepared || loading">
          <legend>选择活动规格</legend>
          <button v-for="sku in detail.skus" :key="sku.unique" type="button" class="sku"
            :aria-pressed="selected === sku.unique" :disabled="sku.max_quantity < 1" @click="choose(sku.unique)">
            {{ sku.suk || '默认规格' }} · ¥{{ sku.catalog_price }}{{ sku.max_quantity < 1 ? ' · 已售罄' : '' }}
          </button>
          <p v-if="!detail.skus.length">暂无可购买规格</p>
          <p v-if="selectedSku" class="catalog-price">活动参考价 ¥{{ selectedSku.catalog_price }}</p>
          <label for="combination-quantity">购买数量</label>
          <input id="combination-quantity" v-model.number="quantity" type="number" min="1" :max="selectedSku?.max_quantity || 1" step="1" />
        </fieldset>
        <fieldset :disabled="buying || !!prepared || loading" class="group-selection">
          <legend>开团或参加指定团</legend>
          <button type="button" class="group" :aria-pressed="selectedGroup === 0" @click="chooseGroup(0)">发起新团</button>
          <button v-for="group in groups" :key="group.id" type="button" class="group" :aria-pressed="selectedGroup === group.id"
            :disabled="!groupAvailable(group)" @click="chooseGroup(group.id)">
            <strong>参加团 #{{ group.id }}</strong>
            <span>已参与 {{ group.active_people }} / {{ group.required_people }} 人 · 待支付预占 {{ group.reserved_people }} 人</span>
            <span>{{ group.already_joined ? '您已参加该团' : group.has_pending_order ? '您有该团待支付订单' : groupAvailable(group) ? `可用席位 ${group.available_places}` : '该团已不可参加' }}</span>
            <span>截止：{{ formatDate(group.stop_time) }}</span>
          </button>
          <p v-if="!groups.length">暂无可展示的进行中拼团</p>
          <p v-if="selectedGroup > 0 && !selectedGroupAvailable" role="status">原指定团已不可参加；不会自动改为开团，请明确重新选择。</p>
        </fieldset>
        <p>每笔订单占 1 个团员席位，与购买件数不同。目录不预留库存或席位，支付后才参与拼团；价格和资格由服务端重新校验。</p>
        <el-button type="danger" :loading="buying" :disabled="!canBuy" @click="buy">{{ prepared ? '继续结算' : selectedGroup ? '参加所选团' : '立即开团' }}</el-button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiCombinationSelection } from '@/api/activity';
import { apiCartAdd } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { combinationId, combinationOpen, combinationGroup, combinationGroupOpen, combinationCartInput, combinationCheckoutQuery,
  type CombinationSelection, type CombinationGroup } from '../../../../common/combinationPurchase';

const route = useRoute(), router = useRouter();
const detail = shallowRef<CombinationSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1), selectedGroup = ref(0);
const error = ref(''), loading = ref(false), buying = ref(false), clock = ref(Date.now());
const prepared = shallowRef<{ cartId: number; activityId: number; pinkId: number } | null>(null);
let revision = 0, disposed = false, savingPath: string | null = null, timer: ReturnType<typeof setInterval> | undefined;
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";
const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
const open = computed(() => !!detail.value && combinationOpen(detail.value, clock.value));
const groups = computed(() => {
  const data = detail.value;
  return data ? [...data.groups, ...(data.requested_group && !data.groups.some(group => group.id === data.requested_group!.id) ? [data.requested_group] : [])] : [];
});
function groupAvailable(group: CombinationGroup) { return combinationGroupOpen(group, clock.value); }
const selectedGroupAvailable = computed(() => {
  if (!selectedGroup.value) return true;
  const group = detail.value && combinationGroup(detail.value, selectedGroup.value);
  return !!group && groupAvailable(group);
});
const canBuy = computed(() => !loading.value && !buying.value && !!detail.value && (prepared.value !== null ||
  open.value && selectedGroupAvailable.value && !!selectedSku.value && typeof quantity.value === 'number' &&
  Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '未设期限'; }
function choose(key: string) {
  if (buying.value || prepared.value || loading.value || !detail.value?.skus.some(sku => sku.unique === key && sku.max_quantity > 0)) return;
  selected.value = key; quantity.value = 1; error.value = '';
}
function chooseGroup(id: number) {
  if (buying.value || prepared.value || loading.value || !detail.value || (id !== 0 && !groups.value.some(group => group.id === id && groupAvailable(group)))) return;
  selectedGroup.value = id; error.value = '';
}
function discardGroup() {
  if (buying.value || prepared.value || loading.value) return;
  selectedGroup.value = 0; void load();
}
async function load(restore = false) {
  if (disposed || prepared.value && !restore) return;
  const current = ++revision, path = route.fullPath, session = captureAuthSession();
  detail.value = null; prepared.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true;
  try {
    const id = combinationId(route.params.id);
    if (restore) selectedGroup.value = route.query.pinkId === undefined ? 0 : combinationId(route.query.pinkId);
    const result = await apiCombinationSelection(id, selectedGroup.value);
    if (disposed || current !== revision || path !== route.fullPath || !isCurrentAuthSession(session)) return;
    detail.value = result;
    if (restore && route.query.sku !== undefined) {
      const requested = route.query.sku;
      if (typeof requested !== 'string' || !result.skus.some(sku => sku.unique === requested && sku.max_quantity > 0)) throw new Error('原规格已失效，请重新选择');
      const raw = route.query.quantity;
      if (raw !== undefined && (typeof raw !== 'string' || !/^[1-9]\d{0,4}$/.test(raw))) throw new Error('原购买数量无效，请重新输入');
      selected.value = requested; quantity.value = raw === undefined ? 1 : Number(raw);
      if (Number(quantity.value) > selectedSku.value!.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
    }
    if (selectedGroup.value && !selectedGroupAvailable.value) error.value = '所选团不可参加，请刷新或明确重新选择';
  } catch (e) { if (!disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session)) error.value = e instanceof Error ? e.message : '拼团规格加载失败'; }
  finally { if (!disposed && current === revision) loading.value = false; }
}
async function buy() {
  if (!canBuy.value || !detail.value) return;
  const current = revision, session = captureAuthSession(), startingPath = route.fullPath;
  const selection = detail.value, key = selected.value, count = Number(quantity.value), pinkId = selectedGroup.value;
  const redirect = router.resolve({ path: route.path, query: { ...route.query, sku: key, quantity: String(count), pinkId: pinkId ? String(pinkId) : undefined }, hash: route.hash }).fullPath;
  buying.value = true; error.value = '';
  const valid = () => !disposed && current === revision && route.fullPath === redirect && isCurrentAuthSession(session);
  try {
    if (!prepared.value) combinationCartInput(selection, key, count, pinkId);
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
    if (!prepared.value) {
      const input = combinationCartInput(selection, key, count, pinkId);
      const cart = await apiCartAdd(input);
      if (!valid()) return;
      if (!Number.isSafeInteger(cart.id) || cart.id < 1) throw new Error('购买记录响应无效，请刷新活动');
      prepared.value = { cartId: cart.id, activityId: input.activityId, pinkId };
    }
    const purchase = prepared.value;
    if (await router.push({ path: '/checkout', query: combinationCheckoutQuery(purchase.cartId, purchase.activityId, purchase.pinkId) }) && valid()) {
      error.value = '结算页面打开失败，可继续结算，无需重新加购';
    }
  } catch (e) {
    if (!disposed && current === revision && (route.fullPath === startingPath || route.fullPath === redirect) && isCurrentAuthSession(session)) {
      if (!prepared.value) { detail.value = null; selected.value = ''; }
      error.value = prepared.value ? '结算页面打开失败，可继续结算，无需重新加购' : e instanceof Error ? e.message : '购买失败，请刷新活动重新确认';
    }
  } finally { buying.value = false; }
}
watch(() => route.fullPath, () => { if (route.fullPath !== savingPath) void load(true); }, { immediate: true });
const unbind = onAuthChange(() => { prepared.value = null; void load(); });
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => { disposed = true; revision++; unbind(); if (timer) clearInterval(timer); });
</script>

<style scoped>
.combination-detail { padding-top: 20px; padding-bottom: 32px; }
.combination-detail h2 { margin: 12px 0; }
.selection { display: flex; gap: 28px; margin-top: 20px; padding: 24px; background: white; border-radius: 8px; }
.product-image { width: 40%; max-width: 400px; aspect-ratio: 1; object-fit: contain; align-self: flex-start; }
.selection-info { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.selection-info p { margin: 10px 0; line-height: 1.6; }
fieldset { border: 1px solid #ddd; padding: 12px; }
.group-selection { margin-top: 16px; }
.sku, .group { padding: 10px; margin: 4px; background: white; border: 1px solid #aaa; border-radius: 4px; cursor: pointer; }
.group { display: block; width: calc(100% - 8px); text-align: left; }
.group span { display: block; margin-top: 6px; }
button[aria-pressed='true'] { border: 2px solid #e64340; color: #b32421; }
button:disabled { cursor: not-allowed; opacity: .55; }
.catalog-price { font-size: 22px; color: #b32421; }
input { width: 80px; padding: 8px; margin-left: 8px; }
@media (max-width: 680px) { .selection { flex-direction: column; padding: 12px; } .product-image { width: 100%; max-width: 100%; } }
</style>
