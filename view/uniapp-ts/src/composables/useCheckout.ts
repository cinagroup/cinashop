import { computed, ref, shallowRef, watch } from "vue";
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
import { parseCheckoutSelection, checkoutRequiresAddress, type CheckoutCartItem } from "../../../common/checkoutSelection";
import { CheckoutIntentJournal, type CheckoutIntent } from "../../../common/checkoutIntent";
import { prepareOrderSystemFormSubmission } from "../../../common/order-system-form";
import type { BargainShippingSelection } from '../../../common/bargainShipping';

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
  let query: Record<string, unknown> = {}, checkedIds: number[] = [], generation = 0;
  let uncertain = false;
  let resumeForm = false;
  const locked = computed(() => loading.value || shippingLoading.value || !!pending.value || !visible.value || !auth.isLoggedIn);
  // Native image selection can hide the page. Do not invalidate its owned form on that hide.
  const formLocked = computed(() => loading.value || !!pending.value || !auth.isLoggedIn);
  const allowedShippingTypes = computed<readonly number[]>(() => activity.value.type === 2 ? shippingSelection.value?.shippingTypes ?? [] : items.value.some(i => i.productInfo?.productType === 4) ? [2] : [1,2]);
  const requiresAddress = computed(() => activity.value.type === 2
    ? shippingSelection.value?.requiresAddress !== false : checkoutRequiresAddress(items.value));
  const options = computed<CheckoutQuoteOptions>(() => ({ ...activity.value, addressId: shippingType.value === 1 && requiresAddress.value ? addressId.value : 0,
    shippingType: shippingType.value, storeId: shippingType.value === 2 ? storeId.value : 0,
    couponId: activity.value.type === 0 ? couponId.value : 0, useIntegral: activity.value.type === 0 && useIntegral.value }));
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
    if (loading.value || error.value || !items.value.length || activity.value.type !== 0) return null;
    try { return orderCouponScope(items.value, shippingType.value, storeId.value); } catch { return null; }
  });
  const ready = computed(() => !locked.value && !error.value && !deliveryError.value && !quote.value.loading && !!quote.value.result
    && quote.value.fingerprint === checkoutQuoteFingerprint(items.value, options.value));
  const canSubmit = computed(() => !submitting.value && !error.value && visible.value && auth.isLoggedIn
    && (pending.value ? pending.value.uid === auth.uid : ready.value && !formValidation.value && uploads.value === 0));
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
    couponId.value = id;
  }
  async function loadCoupons(append = false) {
    if (locked.value || !couponScope.value) return;
    if (!append) { couponId.value = 0; void refreshQuote(); }
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
      const selection = parseCheckoutSelection(query);
      const rows = await checkoutApi.items(selection, checkedIds);
      if (current !== generation) return;
      const type = rows[0].type;
      if (rows.some((row) => row.type !== type)) throw new Error("不同活动商品请分开结算");
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
    // Clear only after navigation has succeeded. A navigation/storage failure must not resubmit payment.
    await new Promise<void>((resolve, reject) => uni.redirectTo({ url: `/pages/order/detail?orderId=${encodeURIComponent(intent.orderId!)}`, success: () => resolve(), fail: reject }));
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
      if (!pending.value) pending.value = journal.begin(owner.uid, quote.value.result!.key, {
        quoteToken: quote.value.result!.quoteToken,
        ...options.value, cartIds: items.value.map((row) => row.id), mark: mark.value,
        ...(shippingType.value === 2 ? { realName: contact.value.realName.trim(), userPhone: contact.value.userPhone.trim() } : {}), customForm: customForm.value,
      });
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
  function suspend() { resumeForm = uploads.value > 0; visible.value = false; generation++; shippingGeneration++; shippingLoading.value = false; quoteSession.reset(); couponSession.reset(); }
  watch(() => couponScope.value?.fingerprint ?? "", () => {
    if (pending.value) { couponSession.pause(); return; }
    couponId.value = 0; couponSession.reset();
    if (couponScope.value && !locked.value) void couponSession.load(couponScope.value);
  }, { flush: "sync" });
  watch(options, () => { void refreshQuote(); }, { flush: "sync" });
  watch(() => auth.sessionVersion, () => {
    generation++; quoteSession.reset(); couponSession.reset(); pending.value = null; items.value = [];
    shippingGeneration++; shippingSelection.value = null; shippingLoading.value = false; shippingError.value = '';
    customForm.value = []; formRevision.value++; formName.value = ""; uploads.value = 0;
    contact.value = { realName: "", userPhone: "" }; mark.value = ""; addresses.value = []; stores.value = [];
    addressId.value = 0; storeId.value = 0; couponId.value = 0; useIntegral.value = false;
    error.value = "登录状态已变化，请重新加载结算";
  });
  onLoad((params) => { query = params ?? {}; checkedIds = cart.checkedItems.map((row) => row.id); });
  onShow(() => {
    visible.value = true;
    if (resumeForm && items.value.length && !error.value) { resumeForm = false; void refreshQuote(activity.value.type === 2); void loadCoupons(); }
    else void load();
  });
  onHide(suspend); onUnload(suspend);
  return { loading, error, load, locked, formLocked, items, displayItems, addresses, stores, addressId, storeId, shippingType, setShipping, contact, mark,
    allowedShippingTypes, requiresAddress, shippingLoading,
    customForm, formName, formRevision, formValidation, uploads, activity, useIntegral, quote, ready, deliveryError, refreshQuote,
    coupons, couponId, couponScope, selectCoupon, loadCoupons, pending, submissionError, submitting, canSubmit, submit };
}
