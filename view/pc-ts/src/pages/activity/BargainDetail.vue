<template>
  <div class="container bargain-detail">
    <router-link to="/bargain">返回砍价列表</router-link> · <router-link to="/bargain?my=1">选择我的砍价记录</router-link>
    <h2>{{ helpMode ? '朋友的砍价邀请' : '砍价商品与参与资格' }}</h2>
    <p v-if="loading" role="status">正在读取活动与参与资格…</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-button v-if="!prepared && !pendingStart" :disabled="loading || busy" @click="load()">{{ helpMode ? '刷新邀请与资格' : '刷新规格与资格' }}</el-button>
    <el-button v-if="!authenticated" :disabled="busy || loading" @click="login">{{ helpMode ? '登录查看砍价邀请' : '登录查看本人资格' }}</el-button>
    <section v-if="helpMode && friend" class="selection" aria-label="朋友砍价进度">
      <div class="product-gallery"><ProductImage class="product-image" :src="friend.image" :alt="friend.title" fit="contain" /></div>
      <div class="selection-info">
        <p>{{ friend.owner.nickname || '朋友' }}的砍价</p>
        <h3>{{ friend.title }}</h3>
        <p>参与记录 #{{ friend.participant_id }} · {{ stateLabel(friend.participation.state) }}</p>
        <p class="catalog-price">当前价 ¥{{ friend.participation.current_price }}</p>
        <p>底价 ¥{{ friend.participation.minimum_price }} · 已砍 ¥{{ friend.participation.cut_price }} · 还需砍 ¥{{ friend.participation.remaining_cut }}</p>
        <el-progress :percentage="friend.participation.progress_percent" />
        <p>已有 {{ friend.help_count }} 人帮砍 · {{ friendStateLabel(friend.help_state) }}</p>
        <el-button type="danger" :disabled="!canHelpFriend" :loading="busy" @click="helpFriend">帮好友砍一刀</el-button>
        <el-button :disabled="busy || loading" @click="goOwn">{{ friend.is_owner ? '查看本人砍价记录' : '我也要参与' }}</el-button>
      </div>
    </section>
    <section v-else-if="!helpMode && detail" class="selection" aria-label="砍价活动规格">
      <div class="product-gallery">
        <ProductImage class="product-image" :src="galleryImage || selectedSku?.image || detail.image" :alt="detail.title" fit="contain" />
        <div v-if="detail.content?.images.length" class="gallery-thumbs" aria-label="活动轮播图">
          <button v-for="(image,index) in detail.content.images" :key="index" :aria-label="`查看活动图片 ${index+1}`" :aria-pressed="galleryImage === image" @click="galleryImage=image"><ProductImage :src="image" :alt="`活动图片 ${index+1}`" /></button>
        </div>
      </div>
      <div class="selection-info">
        <h3>{{ detail.title }}</h3>
        <p v-if="detail.content?.info">{{ detail.content.info }}</p>
        <p v-if="detail.content?.unit_name">商品单位：{{ detail.content.unit_name }}</p>
        <p>{{ open ? '活动进行中' : '活动未开始或已结束，请刷新确认' }}</p>
        <p>活动起价 ¥{{ detail.activity_price }} · 活动底价 ¥{{ detail.minimum_price }}</p>
        <p>北京时间：{{ formatDate(detail.start_time) }} 至 {{ formatDate(detail.stop_time) }}</p>
        <section v-if="detail.participation" aria-label="当前砍价参与">
          <h4>参与记录 #{{ detail.participation.id }}</h4>
          <p>{{ stateLabel(detail.participation.state) }} · 已砍 ¥{{ detail.participation.cut_price }} · 还需砍 ¥{{ detail.participation.remaining_cut }}</p>
          <el-progress :percentage="detail.participation.progress_percent" />
          <p>参与当前价 ¥{{ detail.participation.current_price }} · 参与底价 ¥{{ detail.participation.minimum_price }}</p>
          <p class="catalog-price">结算参考单价 ¥{{ detail.participation.catalog_price }}</p>
          <p v-if="detail.participation.activity_price_changed" role="status">活动起价已变化；本条参与仍按发起时起价 ¥{{ detail.participation.original_price }} 和底价结算，新价仅影响新参与。</p>
          <el-button v-if="detail.participation.state === 'cutting'" :disabled="!canHelpSelf" :loading="busy" @click="helpSelf">帮自己砍一刀</el-button>
          <p v-if="ownHelp?.already_helped || helpedSelfId === detail.participation.id" role="status">你已帮这条记录砍过价，可以邀请好友继续帮忙。</p>
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
    <section v-if="invitationPath" class="invitation" aria-label="邀请好友帮砍">
      <h3>邀请好友帮砍</h3>
      <label for="bargain-invitation">复制此链接发送给好友</label>
      <input id="bargain-invitation" :value="invitationUrl" readonly @focus="selectInvitation" />
      <router-link :to="invitationPath">查看邀请页</router-link>
    </section>
    <section v-if="safeDescription" class="activity-description" aria-label="活动描述"><h3>活动描述</h3><div v-html="safeDescription" /></section>
  </div>
</template>
<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { sanitizeArticleRichText } from '../../../../common/articleRichText';
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiBargainSelection, apiBargainStart, apiBargainFriendView, apiBargainHelp } from '@/api/activity';
import { apiCartAdd } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { bargainId, bargainOpen, bargainCartInput, bargainCheckoutQuery, type BargainSelection, type BargainParticipation } from '../../../../common/bargainPurchase';
import { bargainFriendOpen, type BargainFriendView } from '../../../../common/bargainInvitation';
const route = useRoute(), router = useRouter();
const detail = shallowRef<BargainSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
const friend = shallowRef<BargainFriendView | null>(null), ownHelp = shallowRef<BargainFriendView | null>(null);
const helpedSelfId = ref(0);
const helpMode = computed(() => route.query.help !== undefined);
const galleryImage=ref('');
const safeDescription=computed(()=>sanitizeArticleRichText(detail.value?.content?.description ?? ''));
const loading = ref(false), busy = ref(false), error = ref(''), clock = ref(Date.now()), authenticated = ref(!!captureAuthSession().token);
const prepared = shallowRef<{ cartId: number; participantId: number } | null>(null), pendingStart = ref(0);
let revision = 0, disposed = false, savingPath: string | null = null, timer: ReturnType<typeof setInterval> | undefined;
const selectedSku = computed(() => detail.value?.skus.find(s => s.unique === selected.value));
const open = computed(() => !!detail.value && bargainOpen(detail.value, clock.value));
const canBuy = computed(() => !helpMode.value && authenticated.value && !loading.value && !busy.value && !!detail.value && (!!prepared.value ||
  open.value && detail.value.can_select && !!selectedSku.value && typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) && quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
const canHelpSelf = computed(() => !helpMode.value && authenticated.value && !loading.value && !busy.value && !prepared.value && !pendingStart.value
  && open.value && detail.value?.participation?.state === 'cutting' && !ownHelp.value?.already_helped
  && helpedSelfId.value !== detail.value.participation.id);
const canHelpFriend = computed(() => helpMode.value && authenticated.value && !loading.value && !busy.value
  && !!friend.value?.can_help && bargainFriendOpen(friend.value, clock.value));
const invitationPath = computed(() => {
  const source = friend.value || detail.value, id = friend.value?.participant_id || detail.value?.participation?.id;
  return source && id ? `/bargain/${source.bargain_id}?bargainUserId=${id}&help=1` : '';
});
const invitationUrl = computed(() => invitationPath.value ? window.location.origin + router.resolve(invitationPath.value).href : '');
const stateLabel = (state: BargainParticipation['state']) => ({ cutting: '砍价中', ready: '已完成砍价', closed: '已关闭', used: '已用于订单' })[state];
const friendStateLabel = (state: string) => ({
  available: '好友正在邀请你帮砍', owner: '这是你发起的砍价', already_helped: '你已帮这条记录砍过价',
  limit_reached: '本活动的帮砍次数已用完', people_full: '这条记录的帮砍人数已满', ready: '已砍至底价，发起人可查看购买资格',
  closed: '砍价记录已关闭', used: '砍价记录已使用', future: '活动尚未开始', ended: '活动已结束', sold_out: '活动商品暂时售罄',
} as Record<string, string>)[state] || '请刷新活动与资格';
function selectInvitation(event: FocusEvent) { (event.target as HTMLInputElement | null)?.select(); }
function formatDate(value: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '未设期限'; }
function choose(key: string) {
  if (busy.value || loading.value || prepared.value || pendingStart.value || !detail.value?.skus.some(s => s.unique === key && s.max_quantity > 0)) return;
  selected.value = key; quantity.value = 1; error.value = ''; galleryImage.value='';
}
async function load(restore = false) {
  if (disposed || (prepared.value || pendingStart.value) && !restore) return;
  const current = ++revision, path = route.fullPath, session = captureAuthSession();
  detail.value = null; friend.value = null; ownHelp.value = null; selected.value = ''; quantity.value = 1; prepared.value = null; pendingStart.value = 0; galleryImage.value='';
  error.value = ''; loading.value = true; authenticated.value = !!session.token;
  try {
    const id = bargainId(route.params.id), requested = route.query.bargainUserId === undefined ? 0 : bargainId(route.query.bargainUserId);
    if (helpMode.value) {
      if (route.query.help !== '1' || !requested || Object.keys(route.query).some(key => !['help', 'bargainUserId'].includes(key)))
        throw new Error('砍价邀请链接无效，请重新打开邀请');
      const result = await apiBargainFriendView(id, requested);
      if (!disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session)) friend.value = result;
      return;
    }
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
  if (helpMode.value) return route.fullPath;
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
  if (disposed || helpMode.value || busy.value || loading.value || !authenticated.value || !detail.value || detail.value.participation || !bargainOpen(detail.value)) return;
  const current = revision, session = captureAuthSession(), path = route.fullPath, id = detail.value.bargain_id;
  const valid = () => !disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session);
  busy.value = true; error.value = '';
  try {
    if (!pendingStart.value) { const result = await apiBargainStart(id); if (!valid()) return; pendingStart.value = bargainId(String(result.id)); }
    if (await router.push({ path: route.path, query: { bargainUserId: String(pendingStart.value) } }) && valid()) error.value = '参与已发起，页面打开失败；可重试打开，不会再次发起';
  } catch (e) { if (valid()) error.value = pendingStart.value ? '参与已发起，请重试打开或到我的砍价查看' : `${e instanceof Error ? e.message : '发起失败'}；请先刷新我的砍价确认结果，不会自动重试`; }
  finally { busy.value = false; }
}
async function goOwn() {
  if (disposed || busy.value || loading.value || !friend.value) return;
  const current = revision, session = captureAuthSession(), source = friend.value;
  busy.value = true; error.value = '';
  try {
    const failed = await router.push({ path: `/bargain/${source.bargain_id}`,
      query: source.is_owner ? { bargainUserId: String(source.participant_id) } : {} });
    if (failed && !disposed && current === revision && isCurrentAuthSession(session)) error.value = '本人砍价页面打开失败，请重试';
  } catch { if (!disposed && current === revision && isCurrentAuthSession(session)) error.value = '本人砍价页面打开失败，请重试'; }
  finally { busy.value = false; }
}
async function help(self: boolean) {
  if (disposed || (self ? !canHelpSelf.value : !canHelpFriend.value)) return;
  const source = self ? detail.value : friend.value;
  if (!source) return;
  const exact = self ? detail.value!.participation!.id : friend.value!.participant_id;
  const current = revision, session = captureAuthSession();
  let path = route.fullPath;
  const valid = () => !disposed && current === revision && path === route.fullPath && isCurrentAuthSession(session);
  busy.value = true; error.value = '';
  try {
    if (self) {
      // Freeze the record before any asynchronous admission read or write.
      const bound = intent(exact);
      if (bound !== path) {
        savingPath = bound;
        try { if (await router.replace(bound)) return; }
        finally { if (savingPath === bound) savingPath = null; }
        path = bound;
      }
      if (!valid()) return;
      const eligibility = await apiBargainFriendView(source.bargain_id, exact);
      if (!valid()) return;
      ownHelp.value = eligibility;
      if (!eligibility.is_owner || eligibility.already_helped || eligibility.participation.state !== 'cutting'
        || !eligibility.in_stock || eligibility.help_count >= eligibility.people || !bargainFriendOpen(eligibility)) {
        error.value = eligibility.already_helped ? '你已帮这条记录砍过价，请邀请好友帮忙' : '本人帮砍资格已变化，请刷新确认';
        return;
      }
    } else if (!bargainFriendOpen(friend.value!)) throw new Error('活动已到期，请刷新确认');
    if (!valid()) return;
    await apiBargainHelp(exact);
    if (!valid()) return;
    if (self) helpedSelfId.value = exact;
    busy.value = false; await load();
  } catch (e) {
    if (valid()) {
      friend.value = null; detail.value = null; ownHelp.value = null; selected.value = '';
      error.value = `${e instanceof Error ? e.message : '帮砍结果未知'}；请刷新确认，勿重复提交`;
    }
  } finally { busy.value = false; }
}
const helpSelf = () => help(true), helpFriend = () => help(false);
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
const unbind = onAuthChange(() => { prepared.value = null; pendingStart.value = 0; helpedSelfId.value = 0; void load(); });
onMounted(() => { timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onUnmounted(() => { disposed = true; revision++; unbind(); if (timer) clearInterval(timer); });
</script>
<style scoped>
.bargain-detail { padding-top: 20px; padding-bottom: 32px; } h2 { margin: 16px 0; }
.invitation { margin-top: 20px; padding: 24px; background: white; border-radius: 8px; }
.invitation label { display: block; margin: 10px 0; }
.invitation input { display: block; width: 100%; box-sizing: border-box; margin: 12px 0; padding: 10px; }
.selection { display: flex; gap: 28px; padding: 24px; margin-top: 20px; background: white; border-radius: 8px; }
.product-gallery { width:40%;max-width:400px;align-self:flex-start;min-width:0; }
.product-image { width:100%;aspect-ratio:1; }
.gallery-thumbs { display:flex;gap:8px;flex-wrap:wrap;margin-top:12px; }.gallery-thumbs button { width:64px;height:64px;background:white;border:1px solid #ddd;padding:2px; }.gallery-thumbs .product-image {width:100%;height:100%;}
.activity-description {padding:24px;background:white;margin-top:20px;overflow-wrap:anywhere;overflow-x:auto;}.activity-description :deep(img) {max-width:100%;height:auto;}.activity-description :deep(table) {max-width:100%;table-layout:fixed;}.activity-description :deep(pre) {white-space:pre-wrap;}
.selection-info { flex: 1; min-width: 0; overflow-wrap: anywhere; } p { margin: 12px 0; line-height: 1.6; }
fieldset { border: 1px solid #ddd; padding: 12px; margin-top: 16px; }
.sku { background: white; border: 1px solid #aaa; padding: 10px; margin: 4px; border-radius: 4px; cursor: pointer; }
.sku[aria-pressed='true'] { border: 2px solid #b32421; color: #b32421; } button:disabled { opacity: .55; cursor: not-allowed; }
input { width: 80px; padding: 8px; margin-left: 8px; } .catalog-price { font-size: 22px; color: #b32421; }
@media (max-width: 680px) { .selection { flex-direction: column; padding: 12px; } .product-gallery { width: 100%; max-width: 100%; } }
</style>
