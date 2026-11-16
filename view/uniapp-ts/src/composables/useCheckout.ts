import { createCheckoutInvoice, initialCheckoutInvoice } from '../../../common/checkoutInvoice';
import { apiBuyerInvoicePage } from '@/api/buyerInvoice';
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";
import { checkoutApi } from "@/api/checkout";
import { apiAddressList, apiPickupStores, apiOrderSystemForm, apiOrderCreate } from "@/api/order";
import { RequestError } from "@/utils/request";
import type { UserAddress, PickupStore } from "@/types/order";
import type { SystemFormComponent } from "@/types/systemForm";
import { CheckoutQuoteSession, checkoutQuoteFingerprint, type CheckoutQuoteOptions, type CheckoutQuoteState } from "../../../common/checkoutQuote";
import { OrderCouponSession, orderCouponScope, type OrderCouponState } from "../../../common/orderCoupons";
import { parseCheckoutSelection, checkoutRequiresAddress, checkoutSupportsIntegral, type CheckoutCartItem } from "../../../common/checkoutSelection";
import { CheckoutIntentJournal, type CheckoutIntent } from "../../../common/checkoutIntent";
import { prepareOrderSystemFormSubmission } from "../../../common/order-system-form";
import type { BargainShippingSelection } from '../../../common/bargainShipping';
import { CartCouponPreselection } from '../../../common/cartCouponPreselection';
import { ProductCouponBuyJournal, type ProductCouponBuyIntent } from '../../../common/productCouponBuyIntent';
import { assertProductCouponBuyRows, parseProductCouponBuySelection, ProductCouponBuyPreselection, type ProductCouponBuySelection } from '../../../common/productCouponBuyPreselection';

export function useCheckout() {
  const auth = useAuthStore(), cart = useCartStore();
  const loading = ref(true), error = ref(""), submitting = ref(false), visible = ref(false);
  const items = ref<CheckoutCartItem[]>([]), addresses = ref<UserAddress[]>([]), stores = ref<PickupStore[]>([]);
  const addressId = ref(0), storeId = ref(0), shippingType = ref<1 | 2>(1), couponId = ref(0), useIntegral = ref(false);
  const shippingSelection = shallowRef<BargainShippingSelection | null>(null), shippingLoading = ref(false), shippingError = ref('');
  let shippingGeneration = 0;
  const contact = ref({ realName: "", userPhone: "" }), mark = ref("");
  const addressError = ref(""), storeError = ref(""), formError = ref("");
  const customForm = ref<SystemFormComponent[]>([]), formName = ref(""), formRevision = ref(0), uploads = ref(0);
  const activity = ref<Pick<CheckoutQuoteOptions, "type" | "pinkId" | "combinationId" | "seckillId" | "bargainUserId">>({ type: 0 });
  const pending = shallowRef<CheckoutIntent | null>(null), submissionError = ref("");
  const journal = new CheckoutIntentJournal({ get: (key) => uni.getStorageSync(key), set: (key, value) => uni.setStorageSync(key, value), remove: (key) => uni.removeStorageSync(key) });
  const buyJournal = new ProductCouponBuyJournal({ get: (key) => uni.getStorageSync(key), set: (key, value) => uni.setStorageSync(key, value), remove: (key) => uni.removeStorageSync(key) });
  const couponBuyRequested = ref(false), couponBuyError = ref(''), couponBuyValidated = ref(false), couponBuyBound = ref(false), couponBuyProductId = ref(0);
  let buySelection: ProductCouponBuySelection | null = null, buyPreselection: ProductCouponBuyPreselection | null = null, buyRouteError = '';
  let query: Record<string, unknown> = {}, checkedIds: number[] = [], generation = 0;
  let uncertain = false;
  let resumeForm = false;
  let cartCouponPreselection: CartCouponPreselection | null = null, cartCouponError = '';
  const locked = computed(() => loading.value || shippingLoading.value || !!pending.value || !visible.value || !auth.isLoggedIn);
  // Native image selection can hide the page. Do not invalidate its owned form on that hide.
  const formLocked = computed(() => loading.value || !!pending.value || !auth.isLoggedIn);
  const integralEligible = computed(() => checkoutSupportsIntegral(items.value));
  const allowedShippingTypes = computed<readonly number[]>(() => activity.value.type === 2 ? shippingSelection.value?.shippingTypes ?? [] : items.value.some(i => i.productInfo?.productType === 4) ? [2] : [1,2]);
  const requiresAddress = computed(() => activity.value.type === 2
    ? shippingSelection.value?.requiresAddress !== false : checkoutRequiresAddress(items.value));
  let invoiceHash: string | null = null;
  const invoiceDocumentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const invoiceRouteCurrent = () => typeof location === 'undefined' || invoiceHash === null || location.hash === invoiceHash;
  const invoiceState = reactive(initialCheckoutInvoice());
  const invoiceFlow = createCheckoutInvoice(invoiceState, {
    page: apiBuyerInvoicePage,
    capture: () => { const uid = auth.uid, token = auth.token, version = auth.sessionVersion, current = generation; return { uid, token, current: () => auth.isLoggedIn && auth.uid === uid && auth.token === token && auth.sessionVersion === version && current === generation && visible.value && invoiceDocumentVisible.value && invoiceRouteCurrent() && !pending.value }; },
    canEdit: () => !locked.value && !submitting.value,
  });
  const options = computed<CheckoutQuoteOptions>(() => ({ ...activity.value, ...invoiceFlow.options(), addressId: shippingType.value === 1 && requiresAddress.value ? addressId.value : 0,
    shippingType: shippingType.value, storeId: shippingType.value === 2 ? storeId.value : 0,
    couponId: activity.value.type === 0 ? couponId.value : 0, useIntegral: integralEligible.value && useIntegral.value }));
  const deliveryError = computed(() => shippingLoading.value ? '正在读取活动配送规则' : shippingError.value ||
    (!allowedShippingTypes.value.includes(shippingType.value) ? allowedShippingTypes.value.length ? '原配送方式已不可用，请重新选择' : '当前没有可用配送方式，请刷新或联系商家' : shippingType.value === 1 && !requiresAddress.value ? '' : shippingType.value === 1
    ? addressError.value || (!addresses.value.some((a) => a.id === addressId.value) ? "请选择收货地址" : "")
    : storeError.value || (!stores.value.some((s) => s.id === storeId.value) ? "请选择自提门店" : "")));
  const formValidation = computed(() => {
    if (formError.value) return formError.value;
    if (!customForm.value.length) return "";
    try { prepareOrderSystemFormSubmission(customForm.value, customForm.value, 0); return ""; }
    catch (e) { return message(e, "请检查补充信息"); }
  });
  const quote = shallowRef<CheckoutQuoteState>({ loading: false, error: "", fingerprint: "", result: null });
  const quoteSession = new CheckoutQuoteSession(checkoutApi, (state) => { quote.value = state; });
  const coupons = shallowRef<OrderCouponState>({ list: [], nextCursor: null, fingerprint: "", loading: false, error: "" });
  const couponSession = new OrderCouponSession(checkoutApi.coupons, (state) => { coupons.value = state; });
  const couponScope = computed(() => {
    if (loading.value || error.value || !items.value.length || activity.value.type !== 0 || couponBuyRequested.value && deliveryError.value) return null;
    try { return orderCouponScope(items.value, shippingType.value, storeId.value); } catch { return null; }
  });
  const ready = computed(() => !locked.value && !error.value && !deliveryError.value && !quote.value.loading && !!quote.value.result
    && quote.value.fingerprint === checkoutQuoteFingerprint(items.value, options.value));
  const canSubmit = computed(() => invoiceRouteCurrent() && !submitting.value && !error.value && visible.value && auth.isLoggedIn
    && (pending.value ? pending.value.uid === auth.uid : (!couponBuyRequested.value || couponBuyValidated.value)
      && ready.value && invoiceFlow.ready() && !formValidation.value && uploads.value === 0));
  const couponBuyPending = computed(() => couponBuyRequested.value && !pending.value && (!couponBuyValidated.value || !ready.value));
  const canDeclineCouponBuy = computed(() => couponBuyRequested.value && couponBuyBound.value && !locked.value && !submitting.value);
  const displayItems = computed(() => ready.value ? quote.value.result!.items : items.value);
  function message(e: unknown, fallback: string) { return e instanceof Error ? e.message : fallback; }
  async function refreshQuote(renew = false) {
    if (pending.value) return;
    if (renew) quoteSession.reset();
    if (renew && activity.value.type === 2) { await loadShipping(generation); return; }
    if (locked.value || error.value || deliveryError.value || formError.value || !items.value.length) { quoteSession.invalidate(); return; }
    await quoteSession.load(items.value, options.value);
  }
  function selectCoupon(id: number) {
    if (locked.value || coupons.value.loading || coupons.value.fingerprint !== couponScope.value?.fingerprint) return;
    if (id !== 0 && !coupons.value.list.some((c) => c.id === id && c.availability === "available")) return;
    if (couponBuyRequested.value) {
      try {
        if (!buyPreselection || !couponBuyBound.value) throw Error('原领券购买尚未核实，请返回原商品核对');
        buyPreselection.decline({ uid: auth.uid, version: auth.sessionVersion });
        buyPreselection.assertSelection({ uid: auth.uid, version: auth.sessionVersion }, couponScope.value, coupons.value, id);
        couponBuyError.value = ''; couponBuyValidated.value = true;
      } catch (e) { couponBuyValidated.value = false; couponBuyError.value = message(e, '未能保存选券决定'); return; }
    }
    couponId.value = id;
  }
  function declineCouponBuy() {
    if (!canDeclineCouponBuy.value || !buyPreselection) return;
    try {
      buyPreselection.decline({ uid: auth.uid, version: auth.sessionVersion });
      buyPreselection.assertSelection({ uid: auth.uid, version: auth.sessionVersion }, couponScope.value, coupons.value, 0);
      couponId.value = 0; couponBuyError.value = ''; couponBuyValidated.value = true;
      void refreshQuote();
    } catch (e) { couponBuyValidated.value = false; couponBuyError.value = message(e, '未能保存不用券决定'); }
  }
  function reviewCouponBuy() {
    if (!locked.value && couponBuyProductId.value > 0) uni.navigateTo({ url: `/pages/goods/detail?id=${couponBuyProductId.value}` });
  }
  async function loadCoupons(append = false) {
    if (locked.value || !couponScope.value) return;
    if (!append) { couponId.value = 0; if (couponBuyRequested.value) couponBuyValidated.value = false; void refreshQuote(); }
    await couponSession.load(couponScope.value, append);
  }
  function setShipping(type: 1 | 2) {
    if (locked.value || !allowedShippingTypes.value.includes(type)) return;
    shippingType.value = type;
  }
  async function loadShipping(current: number, initial = false) {
    const request = ++shippingGeneration;
    shippingLoading.value = true; shippingError.value = ''; quoteSession.invalidate();
    try {
      const result = await checkoutApi.bargainShipping(items.value.map(item => item.id));
      if (current !== generation || request !== shippingGeneration) return;
      shippingSelection.value = result; stores.value = result.stores; storeError.value = '';
      if (initial) shippingType.value = result.shippingTypes[0] ?? 1;
      if (!result.stores.some(store => store.id === storeId.value)) storeId.value = initial ? result.stores[0]?.id ?? 0 : 0;
    } catch (e) {
      if (current === generation && request === shippingGeneration) { shippingSelection.value = null; stores.value = []; shippingError.value = message(e, '活动配送加载失败'); }
    } finally {
      if (current === generation && request === shippingGeneration) { shippingLoading.value = false; if (!loading.value) await refreshQuote(); }
    }
  }
  async function load() {
    if (!visible.value || submitting.value) return;
    const current = ++generation;
    buyPreselection?.invalidate(); buyPreselection = null; couponBuyValidated.value = false; couponBuyBound.value = false; couponBuyError.value = ''; couponBuyProductId.value = 0;
    shippingGeneration++; shippingSelection.value = null; shippingLoading.value = false; shippingError.value = '';
    quoteSession.reset(); couponSession.reset(); loading.value = true; error.value = "";
    items.value = []; customForm.value = []; formRevision.value++; uploads.value = 0;
    formError.value = ""; submissionError.value = ""; couponId.value = 0;
    pending.value = null;
    try {
      if (!auth.isLoggedIn || auth.uid <= 0) throw new Error("请先登录后结算");
      pending.value = journal.read(auth.uid);
      if (pending.value) { uncertain = true; return; }
      uncertain = false;
      if (buyRouteError) throw Error(buyRouteError);
      if (buySelection) {
        const intent = buyJournal.read(auth.uid);
        if (intent?.attempt === buySelection.attempt && intent.cartId === buySelection.cartId) couponBuyProductId.value = intent.productId;
        buyPreselection = new ProductCouponBuyPreselection(buySelection, buyJournal, { uid: auth.uid, version: auth.sessionVersion });
      }
      const selection = parseCheckoutSelection(query);
      if (cartCouponError) throw new Error(cartCouponError);
      if (query.couponId !== undefined && selection.mode !== 'cart') throw new Error('购物车优惠券不能用于立即购买');
      const rows = await checkoutApi.items(selection, checkedIds);
      if (current !== generation) return;
      if (buySelection) {
        const intent = buyJournal.read(auth.uid);
        if (!intent) throw Error('原领券购买记录不存在，请返回原商品核对');
        assertProductCouponBuyRows(intent, buySelection, auth.uid, rows);
      }
      const type = rows[0].type;
      if (query.couponId !== undefined && type !== 0) throw new Error('活动购物车不能预选普通优惠券');
      if (rows.some((row) => row.type !== type)) throw new Error("不同活动商品请分开结算");
      if (type === 7) {
        const rawId = query.newcomerId;
        if (selection.mode !== 'buy' || rows.length !== 1 || typeof rawId !== 'string' ||
          !/^[1-9]\d{0,9}$/.test(rawId) || Number(rawId) > 2_147_483_647 ||
          rows[0].activityId !== Number(rawId) || rows[0].cartNum !== 1) {
          throw new Error('新人专享结算活动不匹配，请返回活动商品重新选择');
        }
      } else if (query.newcomerId !== undefined) throw new Error('活动结算参数无效');
      const selectedActivity: typeof activity.value = { type };
      for (const name of ["type", "pinkId", "combinationId", "seckillId", "bargainUserId"] as const) {
        const value = query[name]; if (value === undefined) continue;
        if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (name === "type" && Number(value) !== type)) throw new Error("活动结算参数无效");
        selectedActivity[name] = Number(value);
      }
      activity.value = selectedActivity; items.value = rows;
      if (rows.some((row) => row.productInfo?.productType === 4)) shippingType.value = 2;
      const formIds = [...new Set(rows.map((row) => row.productInfo!.systemFormId).filter((id) => id > 0))];
      if (formIds.length > 1) throw new Error("同一订单不能包含不同的自定义表单");
      await Promise.all([
        invoiceFlow.load(),
        apiAddressList().then((list) => {
          if (current !== generation) return;
          addresses.value = list; addressError.value = "";
          const address = list.find((a) => a.id === addressId.value) ?? list.find((a) => a.is_default) ?? list[0];
          addressId.value = address?.id ?? 0;
          if (address && !contact.value.realName && !contact.value.userPhone) contact.value = { realName: address.real_name, userPhone: address.phone };
        }).catch((e) => { if (current === generation) { addresses.value = []; addressError.value = message(e, "地址加载失败"); } }),
        type === 2 ? loadShipping(current, true) : apiPickupStores().then((list) => { if (current === generation) { stores.value = list; storeError.value = ""; storeId.value = list.some((s) => s.id === storeId.value) ? storeId.value : list[0]?.id ?? 0; } })
          .catch((e) => { if (current === generation) { stores.value = []; storeError.value = message(e, "门店加载失败"); } }),
        formIds.length ? apiOrderSystemForm(formIds[0]).then((form) => {
          if (current !== generation) return;
          formName.value = form.name;
          customForm.value = form.value.map((field) => ({ ...field, value: field.value ?? (field.name === "uploadPicture" || field.name === "dateranges" ? [] : field.name === "texts" ? field.defaultValConfig?.value ?? "" : "") }));
          if (!form.value.length) formError.value = "系统表单配置为空";
        }).catch((e) => { if (current === generation) formError.value = message(e, "表单加载失败"); }) : Promise.resolve(),
      ]);
    } catch (e) { if (current === generation) error.value = message(e, "结算加载失败"); }
    finally { if (current === generation) { loading.value = false; await refreshQuote(); } }
  }
  async function openResult() {
    const intent = pending.value;
    if (!intent?.orderId || intent.uid !== auth.uid) return;
    let buy: ProductCouponBuyIntent | null = null;
    try { buy = buyJournal.read(intent.uid); }
    catch (e) { if (couponBuyRequested.value) throw e; }
    const completedBuy = buy?.phase === 'ready' && intent.payload.cartIds.length === 1 && intent.payload.cartIds[0] === buy.cartId
      && (!buySelection || buySelection.attempt === buy.attempt) ? buy : null;
    // Clear only after navigation has succeeded. A navigation/storage failure must not resubmit payment.
    await new Promise<void>((resolve, reject) => uni.redirectTo({ url: `/pages/order/detail?orderId=${encodeURIComponent(intent.orderId!)}`, success: () => resolve(), fail: reject }));
    if (completedBuy) buyJournal.completed(completedBuy, intent.payload.cartIds);
    journal.clear(intent);
  }
  async function submit() {
    if (!canSubmit.value) return;
    if (pending.value?.orderId) { try { await openResult(); } catch (e) { submissionError.value = message(e, "请重试查看订单"); } return; }
    if (!pending.value && shippingType.value === 2 && (!contact.value.realName.trim() || !contact.value.userPhone.trim())) {
      submissionError.value = "请填写自提联系人和手机号"; return;
    }
    submitting.value = true; submissionError.value = "";
    const owner = { uid: auth.uid, version: auth.sessionVersion }, current = generation;
    let sent = false;
    try {
      if (!pending.value && couponBuyRequested.value) {
        if (!buyPreselection) throw Error('原领券购买尚未核实');
        buyPreselection.assertSelection({ uid: auth.uid, version: auth.sessionVersion }, couponScope.value, coupons.value, couponId.value);
      }
      if (!pending.value) pending.value = journal.begin(owner.uid, quote.value.result!.key, {
        quoteToken: quote.value.result!.quoteToken,
        ...options.value, cartIds: items.value.map((row) => row.id), mark: mark.value,
        ...(shippingType.value === 2 ? { realName: contact.value.realName.trim(), userPhone: contact.value.userPhone.trim() } : {}), customForm: customForm.value,
      });
      invoiceFlow.clear(true);
      const intent = journal.assertCurrent(pending.value);
      couponSession.pause();
      sent = true;
      const result = await apiOrderCreate(intent.key, intent.payload as Parameters<typeof apiOrderCreate>[1]);
      // Record a known result for its original owner even if the page has since left. No new-account UI mutation.
      const settled = journal.settled(intent, result);
      if (owner.uid !== auth.uid || owner.version !== auth.sessionVersion || current !== generation) return;
      pending.value = settled;
      await openResult();
    } catch (e) {
      if (owner.uid !== auth.uid || owner.version !== auth.sessionVersion || current !== generation) return;
      submissionError.value = message(e, "下单结果尚未确认");
      const data = e instanceof RequestError && e.status === 400 && e.httpStatus === 200 ? e.data as { errorCode?: unknown; orderKey?: unknown } | null : null;
      if (sent && !uncertain && pending.value && (data?.errorCode === "ORDER_FORM_REJECTED" || data?.errorCode === "ORDER_QUOTE_RECONFIRM_REQUIRED") && data.orderKey === pending.value.key) {
        try { journal.clear(pending.value); pending.value = null; await refreshQuote(); }
        catch (storageError) { submissionError.value = message(storageError, "待确认记录处理失败"); }
      } else if (sent) uncertain = true;
      else {
        // A storage write can succeed and still throw during read-back. Recover it before allowing another intent.
        try { pending.value = journal.read(owner.uid); if (pending.value) uncertain = true; }
        catch (storageError) { error.value = message(storageError, "无法读取待确认记录，请先核对订单列表"); }
      }
    } finally { submitting.value = false; if (visible.value && current !== generation) void load(); }
  }
  function suspend() { invoiceFlow.clear(true); cartCouponPreselection?.revoke(); buyPreselection?.invalidate(); couponBuyValidated.value = false; couponBuyBound.value = false; resumeForm = uploads.value > 0; visible.value = false; generation++; shippingGeneration++; shippingLoading.value = false; quoteSession.reset(); couponSession.reset(); }
  async function resumeBuyForm() {
    // Native image selection temporarily hides this page. Preserve the user's
    // form/upload references while re-reading the actual cart before unlocking.
    const current = ++generation;
    loading.value = true; couponBuyValidated.value = false; couponBuyBound.value = false;
    quoteSession.reset(); couponSession.reset();
    try {
      if (!buySelection || !auth.isLoggedIn) throw Error('请重新读取原领券购买记录');
      const rows = await checkoutApi.items(parseCheckoutSelection(query), checkedIds);
      if (current !== generation) return;
      const intent = buyJournal.read(auth.uid);
      if (!intent) throw Error('原领券购买记录不存在');
      assertProductCouponBuyRows(intent, buySelection, auth.uid, rows);
      if (rows[0].productInfo!.systemFormId !== items.value[0]?.productInfo?.systemFormId
        || rows[0].productInfo!.productType !== items.value[0]?.productInfo?.productType) throw Error('商品结算要求已变化，请重新加载结算');
      items.value = rows;
      buyPreselection = new ProductCouponBuyPreselection(buySelection, buyJournal, { uid: auth.uid, version: auth.sessionVersion });
      void invoiceFlow.load();
    } catch (e) { if (current === generation) error.value = message(e, '原领券购买尚未核实'); }
    finally { if (current === generation) { loading.value = false; await refreshQuote(); } }
  }
  watch(() => couponScope.value?.fingerprint ?? "", () => {
    cartCouponPreselection?.bind(couponScope.value, { uid: auth.uid, version: auth.sessionVersion }, items.value.map(row => row.id),
      !items.value.length || items.value.every(row => row.type === 0 && row.isNew === 0));
    if (pending.value) { couponSession.pause(); return; }
    if (couponBuyRequested.value) {
      couponBuyValidated.value = false; couponBuyBound.value = false; buyPreselection?.invalidate();
      if (couponScope.value && buyPreselection) {
        try {
          const intent = buyPreselection.bind(couponScope.value, { uid: auth.uid, version: auth.sessionVersion }, items.value);
          couponBuyBound.value = true; couponBuyError.value = ''; couponBuyValidated.value = intent.decision === 'declined';
        } catch (e) { couponBuyError.value = message(e, '原领券购买尚未核实'); }
      }
    }
    couponId.value = 0; couponSession.reset();
    if (couponScope.value && !locked.value) void couponSession.load(couponScope.value);
  }, { flush: "sync" });
  watch(coupons, state => {
    if (couponBuyRequested.value) {
      if (!buyPreselection || !couponBuyBound.value || !couponScope.value || state.fingerprint !== couponScope.value.fingerprint) return;
      try {
        const result = buyPreselection.accept(state, { uid: auth.uid, version: auth.sessionVersion });
        couponBuyValidated.value = false;
        if (result.couponId !== null) couponId.value = result.couponId;
        if (result.couponId !== null || result.declined) {
          buyPreselection.assertSelection({ uid: auth.uid, version: auth.sessionVersion }, couponScope.value, state, couponId.value);
          couponBuyValidated.value = true; couponBuyError.value = '';
        }
        if (result.loadMore) void loadCoupons(true);
      } catch (e) { couponBuyValidated.value = false; couponBuyError.value = message(e, '原优惠券尚未核实'); }
      return;
    }
    const suggestion = cartCouponPreselection?.accept(state);
    if (suggestion?.couponId) selectCoupon(suggestion.couponId);
    else if (suggestion?.loadMore) void loadCoupons(true);
  }, { flush: 'sync' });
  watch(options, () => { void refreshQuote(); }, { flush: "sync" });
  watch(() => auth.sessionVersion, () => {
    invoiceFlow.clear(); cartCouponPreselection?.revoke();
    buyPreselection?.invalidate(); couponBuyValidated.value = false; couponBuyBound.value = false;
    generation++; quoteSession.reset(); couponSession.reset(); pending.value = null; items.value = [];
    shippingGeneration++; shippingSelection.value = null; shippingLoading.value = false; shippingError.value = '';
    customForm.value = []; formRevision.value++; formName.value = ""; uploads.value = 0;
    contact.value = { realName: "", userPhone: "" }; mark.value = ""; addresses.value = []; stores.value = [];
    addressId.value = 0; storeId.value = 0; couponId.value = 0; useIntegral.value = false;
    error.value = "登录状态已变化，请重新加载结算";
  });
  function invoiceDocumentChange() { invoiceDocumentVisible.value = document.visibilityState !== 'hidden'; if (!invoiceDocumentVisible.value) invoiceFlow.clear(true); else if (visible.value && !pending.value && invoiceRouteCurrent()) void invoiceFlow.load(); }
  function invoiceHashChange() { invoiceFlow.clear(true); if (visible.value && !invoiceRouteCurrent()) { quoteSession.reset(); error.value = '结算页面链接已变化，请重新进入结算'; } }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', invoiceDocumentChange);
  if (typeof window !== 'undefined') window.addEventListener('hashchange', invoiceHashChange);
  onUnload(() => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', invoiceDocumentChange); if (typeof window !== 'undefined') window.removeEventListener('hashchange', invoiceHashChange); });
  onLoad((params) => {
    invoiceHash = typeof location === 'undefined' ? null : location.hash;
    query = params ?? {}; checkedIds = cart.checkedItems.map((row) => row.id);
    couponBuyRequested.value = Object.prototype.hasOwnProperty.call(query, 'couponBuy');
    buyRouteError = ''; buySelection = null;
    try { buySelection = parseProductCouponBuySelection(query); }
    catch (e) { buyRouteError = message(e, '领券购买参数无效'); }
    if (query.couponId !== undefined) {
      try { cartCouponPreselection = new CartCouponPreselection(query.couponId, { uid: auth.uid, version: auth.sessionVersion }, checkedIds); }
      catch (error) { cartCouponError = message(error, '购物车优惠券参数无效'); }
    }
  });
  onShow(() => {
    visible.value = true;
    if (resumeForm && items.value.length && !error.value) {
      resumeForm = false;
      if (couponBuyRequested.value) void resumeBuyForm();
      else { void invoiceFlow.load(); void refreshQuote(activity.value.type === 2); void loadCoupons(); }
    }
    else void load();
  });
  onHide(suspend); onUnload(suspend);
  return { invoiceState, invoiceFlow, loading, error, load, locked, formLocked, items, displayItems, addresses, stores, addressId, storeId, shippingType, setShipping, contact, mark,
    allowedShippingTypes, requiresAddress, shippingLoading,
    customForm, formName, formRevision, formValidation, uploads, activity, integralEligible, useIntegral, quote, ready, deliveryError, refreshQuote,
    coupons, couponId, couponScope, selectCoupon, loadCoupons, couponBuyRequested, couponBuyPending, couponBuyError, canDeclineCouponBuy, declineCouponBuy, reviewCouponBuy, couponBuyProductId,
    pending, submissionError, submitting, canSubmit, submit };
}
