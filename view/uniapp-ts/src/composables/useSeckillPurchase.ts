import { computed, ref, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiSeckillSelection } from '@/api/seckill';
import { apiCartAdd } from '@/api/order';
import { RequestError } from '@/utils/request';
import { seckillId as parseId, seckillOpen, seckillCartInput, type SeckillSelection } from '../../../common/seckillPurchase';

export function useSeckillPurchase() {
  const auth = useAuthStore(), seckillId = ref(0), visible = ref(false);
  const detail = shallowRef<SeckillSelection | null>(null), selected = ref(''), quantity = ref<number | string>(1);
  const loading = ref(false), buying = ref(false), navigating = ref(false), error = ref(''), prepared = ref<number | null>(null), clock = ref(Date.now());
  let generation = 0, navigationRevision = 0, disposed = false, timer: ReturnType<typeof setInterval> | undefined;
  let loginSelection: { id: number; unique: string; quantity: number } | null = null;
  const selectedSku = computed(() => detail.value?.skus.find(sku => sku.unique === selected.value));
  const open = computed(() => !!detail.value && seckillOpen(detail.value, clock.value));
  const locked = computed(() => buying.value || navigating.value || prepared.value !== null);
  const canBuy = computed(() => visible.value && !loading.value && !buying.value && !navigating.value && (prepared.value !== null ||
    open.value && !!selectedSku.value && typeof quantity.value === 'number' && Number.isSafeInteger(quantity.value) &&
    quantity.value > 0 && quantity.value <= selectedSku.value.max_quantity));
  function reset() {
    generation++; navigationRevision++; navigating.value = false;
    detail.value = null; selected.value = ''; quantity.value = 1; prepared.value = null; loading.value = false;
  }
  function choose(key: string) {
    if (!visible.value || locked.value || loading.value || !detail.value?.skus.some(sku => sku.unique === key && sku.max_quantity > 0)) return;
    selected.value = key; quantity.value = 1; error.value = '';
  }
  async function load() {
    if (!visible.value || !seckillId.value || disposed || navigating.value || prepared.value !== null) return;
    const current = ++generation;
    detail.value = null; selected.value = ''; quantity.value = 1; error.value = ''; loading.value = true;
    try {
      const result = await apiSeckillSelection(seckillId.value);
      if (current !== generation || !visible.value || disposed) return;
      detail.value = result;
      const resume = loginSelection; loginSelection = null;
      if (resume?.id === result.seckill_id) {
        const sku = result.skus.find(sku => sku.unique === resume.unique && sku.max_quantity > 0);
        if (sku) {
          selected.value = sku.unique; quantity.value = resume.quantity;
          if (resume.quantity > sku.max_quantity) error.value = '返回时库存或限购已变化，请重新确认数量';
        } else error.value = '原规格已失效，请重新选择';
      }
    } catch (e) { if (current === generation && visible.value) error.value = e instanceof Error ? e.message : '秒杀规格加载失败'; }
    finally { if (current === generation && visible.value) loading.value = false; }
  }
  function navigate(url: string, onFailure: () => void) {
    const current = generation, revision = ++navigationRevision;
    navigating.value = true;
    const fail = () => {
      if (current !== generation || revision !== navigationRevision || !visible.value || disposed) return;
      navigating.value = false; onFailure();
    };
    // Native success can precede onHide. Keep the gate until lifecycle reset,
    // not merely until the request Promise settles or a success callback fires.
    try { uni.navigateTo({ url, fail }); } catch { fail(); }
  }
  function goCheckout(id: number) {
    navigate(`/pages/order/confirm?mode=buy&cartId=${id}&type=1&seckillId=${seckillId.value}`,
      () => { error.value = '结算页面打开失败，可继续结算，无需重新加购'; });
  }
  async function purchase() {
    if (!canBuy.value) return;
    if (!auth.isLoggedIn) {
      loginSelection = { id: seckillId.value, unique: selected.value, quantity: Number(quantity.value) };
      navigate('/pages/auth/login', () => { loginSelection = null; error.value = '登录页面打开失败，请重试'; }); return;
    }
    const current = generation;
    if (prepared.value !== null) { goCheckout(prepared.value); return; }
    if (!detail.value) return;
    const identityVersion = auth.sessionVersion;
    const submittedSelection = { id: seckillId.value, unique: selected.value, quantity: Number(quantity.value) };
    buying.value = true; error.value = '';
    try {
      const input = seckillCartInput(detail.value, selected.value, Number(quantity.value));
      const result = await apiCartAdd(input);
      if (current !== generation || !visible.value || disposed) return;
      if (!Number.isSafeInteger(result.id) || result.id < 1) throw new Error('购买记录响应无效，请刷新活动');
      prepared.value = result.id; goCheckout(result.id);
    } catch (e) {
      // The request layer has already cleared THIS expired session and opened login.
      // A stale response from another identity is rejected there without an auth status.
      if (e instanceof RequestError && e.status !== undefined && [410000, 410001, 410002].includes(e.status) &&
        !disposed && !auth.isLoggedIn && auth.sessionVersion === identityVersion + 1 && seckillId.value === submittedSelection.id) {
        loginSelection = submittedSelection;
      }
      if (current === generation && visible.value) {
        detail.value = null; selected.value = '';
        error.value = e instanceof Error ? e.message : '加购失败，请刷新活动重新确认';
      }
    } finally { buying.value = false; }
  }
  function suspend() {
    visible.value = false; reset();
    if (timer) { clearInterval(timer); timer = undefined; }
  }
  watch(() => auth.sessionVersion, () => {
    // Only an explicitly requested login return may restore a public SKU selection.
    if (visible.value) loginSelection = null;
    reset(); error.value = '登录状态已变化，请刷新活动';
  }, { flush: 'sync' });
  onLoad(query => { reset(); loginSelection = null; seckillId.value = 0;
    try { seckillId.value = parseId(query?.id); error.value = ''; }
    catch { error.value = '秒杀商品标识无效，请返回活动列表'; }
  });
  onShow(() => {
    if (disposed) return;
    visible.value = true; clock.value = Date.now();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { clock.value = Date.now(); }, 1000);
    void load();
  });
  onHide(suspend);
  onUnload(() => { disposed = true; loginSelection = null; suspend(); });
  return { seckillId, visible, detail, selected, quantity, loading, buying, navigating, error, prepared, selectedSku, open, locked, canBuy, choose, load, purchase };
}
