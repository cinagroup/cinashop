import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { apiDiyCommerceCards, apiDiyCommerceCoupons, apiDiyCommerceIndex, apiDiyCommercePink, apiDiyCommercePromotion, apiDiyCommerceRooms, apiDiyCommerceSeckill } from '@/api/diyCommerce';
import { normalizeDiyCommerce } from '@/utils/diyCommerceConfig';
import type { CommerceCard, CommerceCoupon, CommerceRoom, CommerceSlot, PromotionProduct } from '@/utils/diyCommerceData';
import { claimDiyCoupon, diyCouponClaimState, reconcileDiyCouponClaims } from '@/utils/diyCouponClaim';
import { openDiyLink } from '@/utils/diy';
import { useCategoryPurchase } from './useCategoryPurchase';

export function useDiyCommerceWidget(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyCommerce(block(), theme.preset)), fingerprint = computed(() => JSON.stringify(config.value));
  const actor = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const cards = ref<CommerceCard[]>([]), coupons = ref<CommerceCoupon[]>([]), rooms = ref<CommerceRoom[]>([]), products = ref<PromotionProduct[]>([]);
  const slots = ref<CommerceSlot[]>([]), selectedSlot = ref(0), selectedTab = ref(0);
  const pink = ref<{ pink_count: number; avatars: string[] } | null>(null);
  const loading = ref(false), loaded = ref(false), error = ref(''), claimNotice = ref(''), navigationNotice = ref(''), claiming = ref(0);
  let generation = 0, disposed = false, clockTimer: ReturnType<typeof setInterval> | undefined;
  const now = ref(Date.now());
  let miniProgram = false;
  // #ifdef MP-WEIXIN
  miniProgram = true;
  // #endif
  const ready = () => !disposed && active() && config.value.enabled && (config.value.kind !== 'liveBroadcast' || miniProgram);
  const current = (revision: number, owner: string, key: string) => ready() && generation === revision && actor() === owner && fingerprint.value === key;
  const navigable = () => ready() && loaded.value && !loading.value && !error.value;
  const purchaseVisible = computed(() => navigable() && config.value.kind === 'promotionList');
  const purchase = useCategoryPurchase(purchaseVisible);
  function clearClock() { if (clockTimer !== undefined) clearInterval(clockTimer); clockTimer = undefined; }
  function clear() { clearClock(); cards.value = []; coupons.value = []; rooms.value = []; products.value = []; slots.value = []; pink.value = null; loaded.value = false; loading.value = false; error.value = ''; claimNotice.value = ''; navigationNotice.value = ''; claiming.value = 0; }
  function invalidate() { generation++; clear(); selectedSlot.value = 0; selectedTab.value = 0; }
  async function load(tab = selectedTab.value, slot = 0) {
    if (!ready() || loading.value) return;
    const revision = ++generation, owner = actor(), key = fingerprint.value, cfg = config.value, uid = auth.uid;
    clear(); loading.value = true;
    try {
      if (cfg.kind === 'promotionList') {
        const chosen = cfg.tabs[tab];
        const value = chosen?.query ? await apiDiyCommercePromotion(chosen.query) : [];
        if (!current(revision, owner, key)) return;
        products.value = value; selectedTab.value = tab;
      } else if (cfg.kind === 'seckill') {
        const schedule = await apiDiyCommerceIndex();
        if (!current(revision, owner, key)) return;
        const choice = slot ? schedule.slots.find(item => item.id === slot && item.start_time && item.end_time) : schedule.index < 0 ? undefined : schedule.slots[schedule.index];
        const value = choice && cfg.limit > 0 ? await apiDiyCommerceSeckill(choice.id, cfg.limit) : [];
        if (!current(revision, owner, key)) return;
        slots.value = schedule.slots; selectedSlot.value = choice?.id ?? 0; cards.value = value;
        now.value = Date.now();
        if (choice?.stop) clockTimer = setInterval(() => { if (current(revision, owner, key)) now.value = Date.now(); }, 1000);
      } else if (cfg.kind === 'coupon') {
        const value = cfg.limit > 0 ? await apiDiyCommerceCoupons(cfg.limit, uid) : [];
        if (!current(revision, owner, key)) return;
        coupons.value = value; reconcileDiyCouponClaims(uid, value);
      } else if (cfg.kind === 'liveBroadcast') {
        const value = cfg.limit > 0 ? await apiDiyCommerceRooms(cfg.limit) : [];
        if (!current(revision, owner, key)) return;
        rooms.value = value;
      } else if (cfg.kind) {
        const [value, summary] = await Promise.all([cfg.limit > 0 ? apiDiyCommerceCards(cfg.kind, cfg.limit) : Promise.resolve([]), cfg.kind === 'combination' ? apiDiyCommercePink() : Promise.resolve(null)]);
        if (!current(revision, owner, key)) return;
        cards.value = value; pink.value = summary;
      }
      if (current(revision, owner, key)) loaded.value = true;
    } catch (reason) {
      if (current(revision, owner, key)) { clear(); error.value = reason instanceof Error ? reason.message : '商城内容读取失败，请重试'; }
    } finally { if (current(revision, owner, key)) loading.value = false; }
  }
  function selectPromotion(index: number) {
    if (!ready() || !Number.isInteger(index) || !config.value.tabs[index] || index === selectedTab.value && loading.value) return;
    generation++; clear(); selectedTab.value = index; void load(index);
  }
  function selectSeckill(id: number) {
    if (!navigable() || !slots.value.some(item => item.id === id && item.start_time && item.end_time)) return;
    generation++; clear(); void load(selectedTab.value, id);
  }
  function more() {
    if (!navigable()) return;
    const kind = config.value.kind;
    const url = kind === 'presale' ? '/pages/activity/presale' : kind === 'pointsMall' ? '/pages/user/integral'
      : kind === 'coupon' ? '/pages/user/couponCenter' : kind === 'liveBroadcast' ? '/pages/columnGoods/live_list/index'
      : ['seckill', 'combination', 'bargain'].includes(kind ?? '') ? `/pages/activity/index?type=${kind}` : '';
    if (url) openDiyLink(url);
  }
  function cardTarget(id: number) {
    if (!navigable() || !cards.value.some(row => row.id === id)) return '';
    return config.value.kind === 'seckill' ? `/pages/activity/seckillDetail?id=${id}` : config.value.kind === 'combination' ? `/pages/activity/detail?id=${id}`
      : config.value.kind === 'bargain' ? `/pages/activity/bargainDetail?id=${id}&spid=${auth.uid}` : config.value.kind === 'presale' ? `/pages/activity/presaleDetail?id=${id}`
      : config.value.kind === 'pointsMall' ? `/pages/activity/integralDetail?id=${id}` : '';
  }
  function openCard(id: number) {
    const target = cardTarget(id); if (!target) return;
    openDiyLink(config.value.kind === 'bargain' && !auth.isLoggedIn ? '/pages/auth/login' : target);
  }
  function openProduct(id: number) {
    if (!navigable()) return; const product = products.value.find(row => row.id === id); if (!product) return;
    if (!product.destination || product.navigationExpiresAt !== null && product.navigationExpiresAt <= Date.now()) { navigationNotice.value = '商品活动入口待核实，请刷新当前组件'; return; }
    openDiyLink(product.activityKind === 'bargain' && !auth.isLoggedIn ? '/pages/auth/login'
      : product.destination + (product.activityKind === 'bargain' && auth.uid > 0 ? `&spid=${auth.uid}` : ''));
  }
  async function promotionAction(id: number) {
    if (!navigable() || !config.value.showAction) return;
    const product = products.value.find(row => row.id === id); if (!product) return;
    if (!config.value.cartMode || product.activityKind || product.is_presale_product || product.cart_button === 0 || !product.destination || product.navigationExpiresAt !== null) { openProduct(id); return; }
    await purchase.open(product, 'cart', product.spec_type === 0);
  }
  async function receive(id: number) {
    if (!navigable() || config.value.kind !== 'coupon' || config.value.style === 3 || claiming.value) return;
    const coupon = coupons.value.find(row => row.id === id); if (!coupon || coupon.is_use !== false) return;
    if (!auth.isLoggedIn) { openDiyLink('/pages/auth/login'); return; }
    const state = diyCouponClaimState(auth.uid, id);
    if (state) { claimNotice.value = state === 'unknown' || state === 'pending' ? '领取结果尚未确认，请只读核对，不要重复领取' : '已有领取记录，请到优惠券中心核对'; return; }
    const revision = generation, owner = actor(), key = fingerprint.value, uid = auth.uid;
    claiming.value = id; claimNotice.value = '';
    try {
      await claimDiyCoupon(uid, id);
      if (!current(revision, owner, key)) return;
      coupons.value = coupons.value.map(row => row.id === id ? { ...row, is_use: true } : row);
      claimNotice.value = '领取成功'; uni.showToast({ title: '领取成功', icon: 'success' });
    } catch (reason) { if (current(revision, owner, key)) claimNotice.value = diyCouponClaimState(uid, id) === 'unknown' ? '领取结果尚未确认，请只读核对，不要重复领取' : reason instanceof Error ? reason.message : '领取失败'; }
    finally { if (current(revision, owner, key)) claiming.value = 0; }
  }
  function couponState(id: number) { return diyCouponClaimState(auth.uid, id); }
  const hasCouponJournal = computed(() => coupons.value.some(row => !!couponState(row.id)));
  function couponLabel(coupon: CommerceCoupon) {
    const state = couponState(coupon.id);
    return state === 'pending' ? '领取中…' : state === 'unknown' ? '结果待核对' : state === 'invalid' ? '恢复资料异常'
      : coupon.is_use === true || state === 'acknowledged' || state === 'owned' ? '已领取' : coupon.is_use === 2 ? '已过期' : '领取';
  }
  async function reconcile() {
    if (!navigable() || config.value.kind !== 'coupon' || claiming.value) return;
    const owner = actor(), key = fingerprint.value, expected = generation + 1;
    await load();
    if (current(expected, owner, key) && navigable()) claimNotice.value = coupons.value.some(row => couponState(row.id) === 'unknown')
      ? '已读取当前优惠券，但仍无法证明上次结果；保留领取保护，可到优惠券中心核对' : '已读取当前账号持券状态，没有重新提交领取';
  }
  function openLive(id: number) {
    if (!navigable() || !miniProgram) return;
    const room = rooms.value.find(row => row.id === id); if (!room) return;
    // #ifdef MP-WEIXIN
    uni.navigateTo({ url: `plugin-private://wx2b03c6e691cd7370/pages/live-player-plugin?room_id=${room.room_id}&custom_params=${encodeURIComponent(JSON.stringify({ pid: auth.uid > 0 ? auth.uid : 0 }))}` });
    // #endif
  }
  const selectedStop = computed(() => slots.value.find(row => row.id === selectedSlot.value)?.stop ?? 0);
  const countdown = computed(() => { const seconds = Math.max(0, Math.floor(selectedStop.value - now.value / 1000)); return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); });
  const stop = watch([fingerprint, actor, active], () => {
    invalidate(); const revision = generation;
    if (ready()) void Promise.resolve().then(() => { if (revision === generation && ready()) void load(); });
  }, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); invalidate(); }
  onScopeDispose(dispose);
  return { config, cards, coupons, rooms, products, slots, selectedSlot, selectedTab, pink, loading, loaded, error, claimNotice, navigationNotice, claiming, miniProgram,
    countdown, selectedStop, load, selectPromotion,selectSeckill, more, openCard, openProduct, promotionAction, receive, reconcile, couponState, couponLabel, hasCouponJournal, openLive, purchase, dispose };
}
