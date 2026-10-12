import { computed, ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiNewcomerProductDetail, type NewcomerProductDetail } from '@/api/newcomer';
import { apiNewcomerCartAdd, apiNewcomerCartKey } from '@/api/order';
import { http, RequestError } from '@/utils/request';
import { validateCheckoutItems } from '../../../common/checkoutSelection';
import { newcomerRecoveryKey, parseNewcomerRecovery, sameNewcomerIntent, type NewcomerPurchaseRecovery as Recovery } from '../../../common/newcomerPurchaseRecovery';

interface Candidate { id: number; sku: string; valid: boolean }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function useNewcomerProduct() {
  const auth = useAuthStore();
  const detail = ref<NewcomerProductDetail | null>(null), loading = ref(false), error = ref(''), visible = ref(false);
  const routeActivityId = ref(0);
  const selected = ref(''), preparing = ref(false), buying = ref(false), navigating = ref(false), prepared = ref<number | null>(null);
  const recovery = ref<Recovery | null>(null), recoveryInvalid = ref(false), checking = ref(false), candidates = ref<Candidate[]>([]);
  const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
  const canBuy = computed(() => visible.value && auth.isLoggedIn && !loading.value && !preparing.value && !buying.value && !navigating.value && !checking.value &&
    (prepared.value !== null || !recovery.value && !recoveryInvalid.value && !!detail.value && !!selectedSku.value && detail.value.stock > 0 && selectedSku.value.stock > 0));
  let productId = 0, generation = 0, navigationRevision = 0, disposed = false, loginPending = false, loginAttempted = false;
  const routeId = (raw: unknown) => typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2_147_483_647 ? Number(raw) : 0;
  const current = (life: number, owner: number, uid: number) => life === generation && visible.value && !disposed && owner === auth.sessionVersion && uid === auth.uid;
  function clear() { generation++; navigationRevision++; detail.value = null; selected.value = ''; prepared.value = null; loading.value = false; preparing.value = false; buying.value = false; navigating.value = false; checking.value = false; recovery.value = null; recoveryInvalid.value = false; candidates.value = []; }
  function setRoute(raw: unknown) { clear(); productId = routeId(raw); routeActivityId.value = productId; error.value = productId ? '' : '新人商品链接无效'; }
  function readHashRoute() {
    // #ifdef H5
    if (typeof window !== 'undefined') {
      const hash = window.location.hash;
      const [path, query = ''] = hash.replace(/^#/, '').split('?');
      if (path !== '/pages/activity/newcomerDetail') return false;
      const ids = new URLSearchParams(query).getAll('id');
      const nextId = hash.length <= 8192 && ids.length === 1 ? routeId(ids[0]) : 0;
      if (nextId !== productId) setRoute(ids.length === 1 && nextId ? ids[0] : undefined);
      return true;
    }
    // #endif
    return false;
  }
  function hashChanged() { if (visible.value && !disposed && readHashRoute()) { void load(); restore(); } }
  function login() {
    if (auth.isLoggedIn || loginPending || !visible.value) return;
    loginPending = true; loginAttempted = true;
    uni.navigateTo({ url: '/pages/auth/login', fail: () => { loginPending = false; error.value = '登录页面打开失败，请重试'; } });
  }
  function choose(unique: string) {
    if (!visible.value || loading.value || preparing.value || buying.value || navigating.value || recovery.value || recoveryInvalid.value ||
      !detail.value?.skus.some(sku => sku.unique === unique)) return;
    selected.value = unique; error.value = '';
  }
  async function load() {
    if (!visible.value || disposed || loading.value || preparing.value || buying.value || navigating.value || checking.value || prepared.value !== null) return;
    generation++; detail.value = null; selected.value = '';
    if (!productId) { error.value = '新人商品链接无效'; return; }
    if (!auth.isLoggedIn) { error.value = '登录后查看新人商品'; if (!loginAttempted) login(); return; }
    const life = generation, owner = auth.sessionVersion, uid = auth.uid;
    error.value = ''; loading.value = true;
    try {
      const row = await apiNewcomerProductDetail(productId);
      if (current(life, owner, uid)) {
        detail.value = row;
        if (recovery.value?.activityId === row.id && row.skus.some(sku => sku.unique === recovery.value?.activityUnique)) selected.value = recovery.value.activityUnique;
      }
    } catch (cause) {
      if (current(life, owner, uid)) error.value = cause instanceof Error ? cause.message : '新人商品加载失败';
    } finally { if (life === generation) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; onFailure();
    };
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function goCheckout(id: number, activityId: number) {
    navigate(`/pages/order/confirm?mode=buy&cartId=${id}&type=7&newcomerId=${activityId}`,
      () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  function saved(row: Recovery): Recovery | null {
    try { return parseNewcomerRecovery(uni.getStorageSync(newcomerRecoveryKey(row.actor)), row.actor); }
    catch { return null; }
  }
  function write(row: Recovery) {
    uni.setStorageSync(newcomerRecoveryKey(row.actor), JSON.stringify(row));
    const check = saved(row);
    if (!check || !sameNewcomerIntent(check, row) || check.state !== row.state || check.cartId !== row.cartId)
      throw new Error('新人购买恢复资料未保存');
  }
  async function exactCart(row: Recovery, id: number) {
    const raw = await http.get<unknown>('/cart/list', { scope: 'buy', ids: id });
    const item = validateCheckoutItems(raw, [id], 1)[0];
    if (item.type !== 7 || item.activityId !== row.activityId || item.productId !== row.productId || item.cartNum !== 1)
      throw new Error('购物行与新人活动不匹配');
    return item;
  }
  async function verify() {
    const row = recovery.value;
    if (!row || row.state !== 'acknowledged' || !row.cartId || !visible.value || !auth.isLoggedIn || checking.value) return;
    const life = generation, owner = auth.sessionVersion, uid = auth.uid;
    checking.value = true; prepared.value = null;
    try {
      await exactCart(row, row.cartId);
      if (!current(life, owner, uid)) return;
      if (row.activityId === productId) { prepared.value = row.cartId; error.value = '已核对原购物行，可继续结算'; }
      else error.value = '另一新人活动有待结算购物行，请返回原活动';
    } catch {
      if (current(life, owner, uid)) error.value = '原购物行暂无法核对或已失效，请查看订单后人工处理；不会重新加购';
    } finally { if (current(life, owner, uid)) checking.value = false; }
  }
  function restore() {
    if (!visible.value || !auth.isLoggedIn || auth.uid < 1) return;
    const raw = uni.getStorageSync(newcomerRecoveryKey(auth.uid));
    if (raw === undefined || raw === null || raw === '') return;
    try {
      const row = parseNewcomerRecovery(raw, auth.uid);
      recovery.value = row; candidates.value = [];
      if (row.state === 'acknowledged') { error.value = '正在核对原购物行…'; void verify(); }
      else error.value = '上次加购结果未知，请先核对购物行与订单；不会自动再次加购';
    } catch { recoveryInvalid.value = true; error.value = '本账号新人购买恢复资料异常，请核对购物行与订单后人工处理'; }
  }
  async function submit(intent: Recovery) {
    if (!visible.value || buying.value || !auth.isLoggedIn || auth.uid !== intent.actor || recoveryInvalid.value) return;
    const life = generation, owner = auth.sessionVersion, uid = auth.uid;
    buying.value = true; error.value = '';
    try {
      const cart = await apiNewcomerCartAdd({ productId: intent.productId, unique: intent.activityUnique, cartNum: 1,
        type: 7, activityId: intent.activityId, new: 1, requestKey: intent.requestKey });
      if (!Number.isSafeInteger(cart.id) || cart.id <= 0 || cart.cartNum !== 1 || cart.cartId !== cart.id || typeof cart.replayed !== 'boolean')
        throw new Error('新人专享加购响应无效');
      // A hidden page may still receive a successful response. Preserve it for the original uid first.
      const stored = saved(intent);
      if (!stored || stored.state !== 'unknown' || !sameNewcomerIntent(stored, intent)) return;
      const acknowledged: Recovery = { ...intent, state: 'acknowledged', cartId: cart.id };
      write(acknowledged);
      if (!current(life, owner, uid)) return;
      recovery.value = acknowledged; prepared.value = cart.id; candidates.value = [];
      goCheckout(cart.id, intent.activityId);
    } catch (cause) {
      if (current(life, owner, uid)) {
        detail.value = null; selected.value = '';
        const code = cause instanceof RequestError && cause.data && typeof cause.data === 'object' && !Array.isArray(cause.data)
          ? (cause.data as Record<string, unknown>).code : null;
        error.value = code === 'cart_terminal' ? '原购物行已成单、删除或失效；请查看订单并人工处理，不会新建行'
          : code === 'request_key_conflict' ? '原请求编号与购买意图冲突，已暂停加购；请人工核对'
            : `${cause instanceof Error ? cause.message : '加购结果未知'}；请核对原购买记录，勿换键重复提交`;
      }
    } finally { if (life === generation) buying.value = false; }
  }
  async function purchase() {
    if (!canBuy.value) return;
    if (prepared.value !== null && recovery.value?.state === 'acknowledged') {
      goCheckout(prepared.value, recovery.value.activityId); return;
    }
    const row = detail.value, sku = selectedSku.value;
    if (!row || !sku || row.id !== productId || auth.uid < 1) return;
    const life = generation, owner = auth.sessionVersion, uid = auth.uid, token = auth.token;
    preparing.value = true; error.value = '';
    try {
      if (uni.getStorageSync(newcomerRecoveryKey(uid))) { restore(); return; }
      const key = await apiNewcomerCartKey();
      if (!current(life, owner, uid) || auth.token !== token || !auth.isLoggedIn || buying.value || recovery.value
        || productId !== row.id || detail.value !== row || selected.value !== sku.unique || selectedSku.value?.unique !== sku.unique) return;
      if (uni.getStorageSync(newcomerRecoveryKey(uid))) { restore(); return; }
      const intent: Recovery = { version: 1, actor: uid, activityId: row.id, productId: row.productId,
        activityUnique: sku.unique, requestKey: key, state: 'unknown', cartId: null };
      write(intent); recovery.value = intent;
      await submit(intent);
    } catch (cause) {
      if (current(life, owner, uid)) error.value = cause instanceof Error ? cause.message : '无法保存购买恢复资料，本次尚未提交';
    } finally { if (life === generation) preparing.value = false; }
  }
  async function retryOriginal() {
    const row = recovery.value;
    if (!row || row.state !== 'unknown' || !visible.value || preparing.value || buying.value || checking.value || !auth.isLoggedIn) return;
    if (row.activityId !== productId) { error.value = '请先返回原活动，再核对原请求'; return; }
    if (!await confirm('核对原请求', '将携带原请求编号再次查询并提交同一购买意图。服务器若不支持安全重放将拒绝，页面不会换编号创建新购物行。')) return;
    const stored = saved(row);
    if (!stored || stored.state !== 'unknown' || !sameNewcomerIntent(stored, row) || auth.uid !== row.actor) return;
    await submit(row);
  }
  function confirm(title: string, content: string): Promise<boolean> {
    return new Promise(resolve => { try { uni.showModal({ title, content, success: answer => resolve(!!answer.confirm), fail: () => resolve(false) }); } catch { resolve(false); } });
  }
  async function inspect() {
    if (!visible.value || !auth.isLoggedIn || checking.value || preparing.value || buying.value) return;
    const life = generation, owner = auth.sessionVersion, uid = auth.uid;
    checking.value = true; candidates.value = [];
    try {
      const raw = await http.get<unknown>('/cart/list');
      if (!Array.isArray(raw)) throw new Error('购物行列表无效');
      if (!current(life, owner, uid)) return;
      const row = recovery.value;
      candidates.value = raw.filter((item): item is Record<string, unknown> => record(item)
        && item.type === 7 && item.isNew === 1 && (!row || item.activityId === row.activityId && item.productId === row.productId)
        && Number.isSafeInteger(item.id) && Number(item.id) > 0 && item.cartNum === 1).map(item => ({
        id: item.id as number, sku: record(item.productInfo) && typeof item.productInfo.suk === 'string' ? item.productInfo.suk.slice(0, 80) : '规格待核对', valid: item.isValid === true,
      }));
      error.value = !row ? '恢复资料异常，以下仅是本账号新人购物行；请逐项核对订单后人工处理'
        : candidates.value.length
        ? '以下为同活动候选购物行，不能证明哪一行属于上次请求；请核对规格和订单'
        : '未查到当前未结算购物行，仍不能证明上次请求未提交；请核对订单';
    } catch { if (current(life, owner, uid)) error.value = '购物行读取失败，原购买保护仍保留'; }
    finally { if (current(life, owner, uid)) checking.value = false; }
  }
  async function abandon() {
    if (!visible.value || !auth.isLoggedIn || preparing.value || buying.value || checking.value || navigating.value || (!recovery.value && !recoveryInvalid.value)) return;
    const life = generation, owner = auth.sessionVersion, uid = auth.uid;
    if (!await confirm('放弃原加购意图', '请先核对购物行和订单。原请求可能稍后提交；放弃后再购买可能留下多条未结算购物行。确认已核对并放弃？')
      || !current(life, owner, uid)) return;
    try {
      uni.removeStorageSync(newcomerRecoveryKey(uid));
      if (uni.getStorageSync(newcomerRecoveryKey(uid))) throw new Error('恢复资料未清除');
      recovery.value = null; recoveryInvalid.value = false; prepared.value = null; candidates.value = [];
      error.value = '已放弃原加购意图；若稍后出现额外购物行，请在订单或客服处核对';
    } catch { error.value = '恢复资料未能清除，请稍后重试'; }
  }
  function openOrders() { if (visible.value && !navigating.value) navigate('/pages/order/list', () => { error.value = '订单页面打开失败，请重试'; }); }
  function openRecoveryActivity() {
    const row = recovery.value;
    if (row && row.activityId !== productId) navigate(`/pages/activity/newcomerDetail?id=${row.activityId}`, () => { error.value = '原活动页面打开失败，请重试'; });
  }
  watch(() => auth.sessionVersion, () => {
    // A session expiry already opens login in the request layer. Do not open it again on return.
    if (visible.value) loginAttempted = true;
    clear();
    // Pinia increments sessionVersion before updating token/uid. Read the final identity after the action completes.
    const version = auth.sessionVersion;
    void Promise.resolve().then(() => {
      if (!visible.value || disposed || version !== auth.sessionVersion) return;
      if (auth.isLoggedIn) { loginPending = false; void load(); restore(); }
      else { loginAttempted = true; error.value = '登录后查看新人商品'; }
    });
  }, { flush: 'sync' });
  onLoad(query => { setRoute(query?.id); });
  onShow(() => { if (!disposed) { visible.value = true; loginPending = false; readHashRoute(); void load(); restore(); } });
  onHide(() => { visible.value = false; loginPending = false; clear(); });
  // #ifdef H5
  if (typeof window !== 'undefined') window.addEventListener('hashchange', hashChanged);
  // #endif
  onUnload(() => {
    disposed = true; visible.value = false; clear();
    // #ifdef H5
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', hashChanged);
    // #endif
  });
  return { auth, detail, routeActivityId, selected, selectedSku, loading, preparing, buying, navigating, prepared, canBuy, error, visible,
    recovery, recoveryInvalid, checking, candidates, choose, load, login, purchase, retryOriginal, verify, inspect, abandon, openOrders, openRecoveryActivity };
}
