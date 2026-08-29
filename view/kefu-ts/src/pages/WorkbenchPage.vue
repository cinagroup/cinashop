<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import UiIcon from "@/components/UiIcon.vue";
import { kefuApi } from "@/api/kefu";
import { resolveKefuAssetUrl } from "@/api/client";
import {
  previewGroups,
  previewIdentity,
  previewLabels,
  previewMessages,
  previewOrderDetails,
  previewOrders,
  previewProductDetails,
  previewProducts,
  previewRefundDetails,
  previewRefunds,
  previewSessions,
  previewSpeechCategories,
  previewSpeechcraft,
  previewUser,
} from "@/data/preview";
import { KefuRealtimeClient, sessionMessagePreview, updateSessionFromMessage, upsertMessage } from "@/services/realtime";
import { useAuthStore } from "@/stores/auth";
import type {
  ChatMessage,
  KefuDeliveryAgent,
  KefuExpressOption,
  KefuOrderDetail,
  KefuManagementForm,
  KefuOrderSummary,
  KefuProductDetail,
  KefuProductSummary,
  KefuRefundDetail,
  KefuRefundSummary,
  KefuSplitCartItem,
  KefuWriteoffCartItem,
  KefuWriteoffInfo,
  RealtimeEvent,
  SessionRecord,
  Speechcraft,
  SpeechcraftCategory,
  UserGroup,
  UserInfo,
  UserLabelCategory,
  TransferTarget,
} from "@/types/kefu";

const router = useRouter();
const auth = useAuthStore();
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const loading = ref(true);
const toast = ref("");
const search = ref("");
const sessionTab = ref<"all" | "unread">("all");
const sessions = ref<SessionRecord[]>([]);
const selected = ref<SessionRecord | null>(null);
const messages = ref<ChatMessage[]>([]);
const customer = ref<UserInfo | null>(null);
const orderContextTab = ref<"orders" | "refunds">("orders");
const orderSearch = ref("");
const orderItems = ref<KefuOrderSummary[]>([]);
const refundItems = ref<KefuRefundSummary[]>([]);
const ordersLoading = ref(false);
const orderDetailLoading = ref(false);
const orderDetail = ref<KefuOrderDetail | null>(null);
const refundDetail = ref<KefuRefundDetail | null>(null);
const orderAction = ref<"edit" | "order-remark" | "refund-remark" | "fulfillment" | "writeoff" | null>(null);
const orderActionForm = ref<KefuManagementForm | null>(null);
const orderActionBusy = ref(false);
const editPayPrice = ref("");
const editGainIntegral = ref("");
const editReadonlyValues = ref<Record<string, string>>({});
const editRemark = ref("");
const fulfillmentType = ref<"express" | "send" | "fictitious">("express");
const expressOptions = ref<KefuExpressOption[]>([]);
const deliveryAgents = ref<KefuDeliveryAgent[]>([]);
const fulfillmentExpressId = ref(0);
const fulfillmentTrackingNo = ref("");
const fulfillmentAgentUid = ref(0);
const fulfillmentVirtualContent = ref("");
const fulfillmentSplit = ref(false);
const fulfillmentCarts = ref<KefuSplitCartItem[]>([]);
const fulfillmentQuantities = ref<Record<string, number>>({});
const writeoffInfo = ref<KefuWriteoffInfo | null>(null);
const writeoffQuantities = ref<Record<string, number>>({});
const productTab = ref<"cart" | "visit" | "hot">("cart");
const productSearch = ref("");
const productItems = ref<KefuProductSummary[]>([]);
const productsLoading = ref(false);
const productDetailLoading = ref(false);
const productDetail = ref<KefuProductDetail | null>(null);
const groups = ref<UserGroup[]>([]);
const labelCategories = ref<UserLabelCategory[]>([]);
const speechType = ref<0 | 1>(0);
const speechCategories = ref<SpeechcraftCategory[]>([]);
const activeSpeechCategory = ref(0);
const speechcraft = ref<Speechcraft[]>([]);
const composer = ref("");
const imageInput = ref<HTMLInputElement | null>(null);
const uploadingImage = ref(false);
const socketState = ref<"connecting" | "open" | "closed">("closed");
const availability = ref(true);
const mobileChat = ref(true);
const mobileInspector = ref(false);
const quickDrawer = ref(false);
const labelsEditing = ref(false);
const savingLabels = ref(false);
const addingPhrase = ref(false);
const transferOpen = ref(false);
const transferLoading = ref(false);
const transferBusy = ref(false);
const transferTargets = ref<TransferTarget[]>([]);
const transferTargetUid = ref(0);
const transferRequestKey = ref("");
const newPhrase = ref({ title: "", message: "" });
const scrollArea = ref<HTMLElement | null>(null);
let toastTimer = 0;
let orderRequest = 0;
let orderDetailRequest = 0;
let productRequest = 0;
let productDetailRequest = 0;

const realtime = new KefuRealtimeClient({
  onState: (state) => { socketState.value = state; },
  onEvent: handleRealtimeEvent,
});

const filteredSessions = computed(() => sessions.value.filter((item) => {
  if (sessionTab.value === "unread" && item.mssage_num < 1) return false;
  const keyword = search.value.trim().toLowerCase();
  return !keyword || item.nickname.toLowerCase().includes(keyword) || item.phone.includes(keyword);
}));
const unreadTotal = computed(() => sessions.value.reduce((sum, item) => sum + item.mssage_num, 0));
const allLabels = computed(() => labelCategories.value.flatMap((category) => category.label));
const selectedLabels = computed(() => allLabels.value.filter((item) => item.disabled));
const kefuUid = computed(() => auth.identity?.uid ?? 0);
const isTouristSession = computed(() => selected.value?.is_tourist === 1);
const orderContextCount = computed(() => orderContextTab.value === "orders" ? orderItems.value.length : refundItems.value.length);

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ""; }, 2600);
}

function initials(name: string) {
  return name.trim().slice(0, 1) || "客";
}

function compactTime(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function fullTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function maskedPhone(phone: string) {
  return phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
}

function productTabLabel(tab: "cart" | "visit" | "hot") {
  return tab === "cart" ? "已购" : tab === "visit" ? "浏览" : "热销";
}

function orderContextTabLabel(tab: "orders" | "refunds") {
  return tab === "orders" ? "订单" : "售后";
}

function orderProductName(item: KefuOrderSummary | KefuRefundSummary) {
  return item.cartInfo[0]?.productInfo.store_name ?? "商品信息暂缺";
}

function previewOrderContext() {
  const keyword = orderSearch.value.trim().toLowerCase();
  const matches = (item: KefuOrderSummary | KefuRefundSummary) => !keyword
    || item.order_id.toLowerCase().includes(keyword)
    || item.cartInfo.some((cart) => cart.productInfo.store_name.toLowerCase().includes(keyword));
  return orderContextTab.value === "orders"
    ? structuredClone(previewOrders.filter(matches))
    : structuredClone(previewRefunds.filter(matches));
}

function closeOrderDetail() {
  ++orderDetailRequest;
  orderDetailLoading.value = false;
  orderDetail.value = null;
  refundDetail.value = null;
  closeOrderAction();
}

function closeOrderAction() {
  if (orderActionBusy.value) return;
  orderAction.value = null;
  orderActionForm.value = null;
  editPayPrice.value = "";
  editGainIntegral.value = "";
  editReadonlyValues.value = {};
  editRemark.value = "";
  fulfillmentType.value = "express";
  expressOptions.value = [];
  deliveryAgents.value = [];
  fulfillmentExpressId.value = 0;
  fulfillmentTrackingNo.value = "";
  fulfillmentAgentUid.value = 0;
  fulfillmentVirtualContent.value = "";
  fulfillmentSplit.value = false;
  fulfillmentCarts.value = [];
  fulfillmentQuantities.value = {};
  writeoffInfo.value = null;
  writeoffQuantities.value = {};
}

function canFulfill(order: KefuOrderSummary) {
  return order.paid === 1
    && order.status === 0
    && order.shipping_type !== 2
    && [0, 3].includes(order.refund_status);
}

function canWriteoff(order: KefuOrderSummary) {
  return order.paid === 1 && (
    (order.shipping_type === 2 && [0, 5].includes(order.status))
    || (order.delivery_type === "send" && [1, 5].includes(order.status))
  );
}

function previewFulfillmentCarts(detail: KefuOrderDetail): KefuSplitCartItem[] {
  return detail.orderInfo.cartInfo.map((cart) => ({
    id: cart.id,
    cart_id: cart.cart_id,
    product_id: cart.product_id,
    sku_unique: cart.unique,
    cart_num: cart.cart_num,
    refund_num: cart.refund_num,
    surplus_num: cart.surplus_num || cart.cart_num,
    product_name: cart.productInfo.store_name,
    image: cart.productInfo.image,
    sku: cart.productInfo.attrInfo.suk,
    cart_info: null,
  }));
}

function previewWriteoff(detail: KefuOrderDetail): KefuWriteoffInfo {
  return {
    id: detail.orderInfo.id,
    order_id: detail.orderInfo.order_id,
    store_id: 1,
    shipping_type: detail.orderInfo.shipping_type,
    delivery_type: detail.orderInfo.delivery_type ?? "",
    actor_kind: "kefu",
    real_name: detail.orderInfo.real_name,
    user_phone: maskedPhone(detail.orderInfo.user_phone),
    status: detail.orderInfo.status,
    total_num: detail.orderInfo.total_num,
    cart_info: detail.orderInfo.cartInfo.map((cart) => ({
      id: cart.id,
      cart_id: cart.cart_id,
      product_id: cart.product_id,
      product_type: cart.product_type,
      write_times: cart.cart_num,
      write_surplus_times: cart.surplus_num || cart.cart_num,
      is_writeoff: 0,
      write_start: 0,
      write_end: 0,
      cart_info: { productInfo: cart.productInfo },
    })),
  };
}

function writeoffCartName(cart: KefuWriteoffCartItem) {
  const productInfo = cart.cart_info?.productInfo;
  return productInfo && typeof productInfo === "object" && !Array.isArray(productInfo)
    ? String((productInfo as Record<string, unknown>).store_name ?? "订单商品")
    : "订单商品";
}

async function openFulfillment() {
  const detail = orderDetail.value;
  if (!detail || !canFulfill(detail.orderInfo)) return;
  orderActionBusy.value = true;
  try {
    const [expresses, agents, carts] = preview
      ? [
          [{ id: 1, value: "顺丰速运", code: "SF" } satisfies KefuExpressOption],
          [{ id: 1, uid: 3001, avatar: "", wx_name: "林配送", nickname: "林配送", phone: "13800138001", status: 1 } satisfies KefuDeliveryAgent],
          previewFulfillmentCarts(detail),
        ]
      : await Promise.all([
          kefuApi.expressOptions(),
          kefuApi.deliveryAgents(),
          kefuApi.splitCartInfo(detail.orderInfo.id),
        ]);
    expressOptions.value = expresses;
    deliveryAgents.value = agents;
    fulfillmentCarts.value = carts;
    fulfillmentExpressId.value = expresses[0]?.id ?? 0;
    fulfillmentAgentUid.value = agents[0]?.uid ?? 0;
    fulfillmentQuantities.value = Object.fromEntries(carts.map((cart) => [cart.cart_id, 0]));
    fulfillmentSplit.value = false;
    fulfillmentType.value = expresses.length ? "express" : agents.length ? "send" : "fictitious";
    orderAction.value = "fulfillment";
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "履约信息加载失败");
  } finally {
    orderActionBusy.value = false;
  }
}

async function openWriteoff() {
  const detail = orderDetail.value;
  if (!detail || !canWriteoff(detail.orderInfo)) return;
  orderActionBusy.value = true;
  try {
    const info = preview ? previewWriteoff(detail) : await kefuApi.writeoffCartInfo(detail.orderInfo.id);
    writeoffInfo.value = info;
    writeoffQuantities.value = Object.fromEntries(
      info.cart_info.filter((cart) => cart.write_surplus_times > 0).map((cart) => [cart.cart_id, cart.write_surplus_times]),
    );
    orderAction.value = "writeoff";
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "核销信息加载失败");
  } finally {
    orderActionBusy.value = false;
  }
}

function previewEditForm(detail: KefuOrderDetail): KefuManagementForm {
  const order = detail.orderInfo;
  return {
    title: "修改订单",
    action: `/order/update/${order.id}`,
    method: "PUT",
    fields: [
      { field: "order_id", label: "订单编号", type: "input", value: order.order_id, disabled: true },
      { field: "total_price", label: "商品总价", type: "number", value: order.total_price, disabled: true },
      { field: "total_postage", label: "原始邮费", type: "number", value: "0.00", disabled: true },
      { field: "pay_postage", label: "实际支付邮费", type: "number", value: "0.00", disabled: true },
      { field: "pay_price", label: "实际支付金额", type: "number", value: order.pay_price, min: 0, precision: 2, required: true },
      { field: "gain_integral", label: "赠送积分", type: "number", value: "0", min: 0, precision: 0, required: true },
    ],
  };
}

async function openOrderEdit() {
  const detail = orderDetail.value;
  if (!detail || detail.orderInfo.paid) return;
  orderActionBusy.value = true;
  try {
    const form = preview ? previewEditForm(detail) : await kefuApi.orderEditForm(detail.orderInfo.id);
    orderActionForm.value = form;
    editReadonlyValues.value = Object.fromEntries(form.fields.filter((field) => field.disabled).map((field) => [field.field, field.value]));
    editPayPrice.value = form.fields.find((field) => field.field === "pay_price")?.value ?? detail.orderInfo.pay_price;
    editGainIntegral.value = form.fields.find((field) => field.field === "gain_integral")?.value ?? "0";
    orderAction.value = "edit";
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "订单编辑表单加载失败");
  } finally {
    orderActionBusy.value = false;
  }
}

function openOrderRemark(kind: "order" | "refund") {
  if (kind === "order" && orderDetail.value) {
    editRemark.value = orderDetail.value.orderInfo.remark;
    orderAction.value = "order-remark";
  } else if (kind === "refund" && refundDetail.value) {
    editRemark.value = refundDetail.value.orderInfo.remark;
    orderAction.value = "refund-remark";
  }
}

async function refreshOrderDetail(id: number) {
  if (preview) return;
  const detail = await kefuApi.orderInfo(id);
  orderDetail.value = detail;
  const index = orderItems.value.findIndex((item) => item.id === id);
  if (index >= 0) orderItems.value[index] = detail.orderInfo;
}

async function refreshRefundDetail(id: number) {
  if (preview) return;
  const detail = await kefuApi.refundDetail(id);
  refundDetail.value = detail;
  const index = refundItems.value.findIndex((item) => item.id === id);
  if (index >= 0) refundItems.value[index] = detail.orderInfo;
}

function fulfillmentPayload(): Record<string, unknown> {
  if (fulfillmentType.value === "express") {
    const express = expressOptions.value.find((item) => item.id === fulfillmentExpressId.value);
    if (!express) throw new Error("请选择快递公司");
    const deliveryId = fulfillmentTrackingNo.value.trim();
    if (!deliveryId) throw new Error("请输入快递单号");
    return {
      type: 1,
      express_record_type: 1,
      delivery_name: express.value,
      delivery_code: express.code,
      delivery_id: deliveryId,
    };
  }
  if (fulfillmentType.value === "send") {
    if (!fulfillmentAgentUid.value) throw new Error("请选择配送员");
    return { type: 2, delivery_type: 1, sh_delivery_uid: fulfillmentAgentUid.value };
  }
  const content = fulfillmentVirtualContent.value.trim();
  if (!content) throw new Error("请填写虚拟发货内容");
  return { type: 3, fictitious_content: content };
}

function selectedFulfillmentCarts() {
  return fulfillmentCarts.value.flatMap((cart) => {
    const quantity = Number(fulfillmentQuantities.value[cart.cart_id] ?? 0);
    return Number.isInteger(quantity) && quantity > 0
      ? [{ cart_id: cart.cart_id, cart_num: quantity }]
      : [];
  });
}

async function submitOrderAction() {
  if (!orderAction.value || orderActionBusy.value) return;
  orderActionBusy.value = true;
  let reloadOrderContext = false;
  try {
    if (orderAction.value === "edit") {
      const detail = orderDetail.value;
      if (!detail) return;
      if (preview) {
        detail.orderInfo.pay_price = Number(editPayPrice.value).toFixed(2);
        const item = orderItems.value.find((entry) => entry.id === detail.orderInfo.id);
        if (item) item.pay_price = detail.orderInfo.pay_price;
      } else {
        await kefuApi.updateOrder(detail.orderInfo.id, {
          ...editReadonlyValues.value,
          pay_price: editPayPrice.value,
          gain_integral: editGainIntegral.value,
        });
        await refreshOrderDetail(detail.orderInfo.id);
      }
      notify("订单金额已更新");
    } else if (orderAction.value === "order-remark") {
      const detail = orderDetail.value;
      if (!detail) return;
      if (!preview) {
        await kefuApi.updateOrderRemark(detail.orderInfo.order_id, editRemark.value);
        await refreshOrderDetail(detail.orderInfo.id);
      } else {
        detail.orderInfo.remark = editRemark.value.trim();
        const item = orderItems.value.find((entry) => entry.id === detail.orderInfo.id);
        if (item) item.remark = detail.orderInfo.remark;
      }
      notify("订单备注已更新");
    } else if (orderAction.value === "refund-remark") {
      const detail = refundDetail.value;
      if (!detail) return;
      if (!preview) {
        await kefuApi.updateRefundRemark(detail.orderInfo.id, editRemark.value);
        await refreshRefundDetail(detail.orderInfo.id);
      } else {
        detail.orderInfo.remark = editRemark.value.trim();
        const item = refundItems.value.find((entry) => entry.id === detail.orderInfo.id);
        if (item) item.remark = detail.orderInfo.remark;
      }
      notify("售后备注已更新");
    } else if (orderAction.value === "fulfillment") {
      const detail = orderDetail.value;
      if (!detail) return;
      const payload = fulfillmentPayload();
      const selectedCarts = selectedFulfillmentCarts();
      if (fulfillmentSplit.value && !selectedCarts.length) throw new Error("请选择本次发货商品和数量");
      if (preview) {
        detail.orderInfo.status = 1;
        detail.orderInfo.delivery_type = fulfillmentType.value;
        detail.orderInfo._status._title = fulfillmentSplit.value ? "部分发货" : "待收货";
        detail.orderInfo._status._msg = fulfillmentSplit.value ? "所选商品已拆单发货" : "订单已提交履约";
        const item = orderItems.value.find((entry) => entry.id === detail.orderInfo.id);
        if (item) {
          item.status = detail.orderInfo.status;
          item.delivery_type = detail.orderInfo.delivery_type;
          item._status = { ...detail.orderInfo._status };
        }
      } else if (fulfillmentSplit.value) {
        await kefuApi.splitDelivery(detail.orderInfo.id, { ...payload, cart_ids: selectedCarts });
        reloadOrderContext = true;
      } else {
        await kefuApi.deliverOrder(detail.orderInfo.id, payload);
        reloadOrderContext = true;
      }
      notify(fulfillmentSplit.value ? "拆单发货已提交" : "订单发货已提交");
    } else {
      const detail = orderDetail.value;
      const info = writeoffInfo.value;
      if (!detail || !info) return;
      const cartIds = info.cart_info.flatMap((cart) => {
        const quantity = Number(writeoffQuantities.value[cart.cart_id] ?? 0);
        return Number.isInteger(quantity) && quantity > 0
          ? [{ cart_id: cart.cart_id, cart_num: quantity }]
          : [];
      });
      if (!cartIds.length) throw new Error("请选择核销商品和数量");
      if (preview) {
        detail.orderInfo.status = 2;
        detail.orderInfo._status._title = "已完成";
        detail.orderInfo._status._msg = "订单商品已核销";
        const item = orderItems.value.find((entry) => entry.id === detail.orderInfo.id);
        if (item) {
          item.status = detail.orderInfo.status;
          item._status = { ...detail.orderInfo._status };
        }
      } else {
        await kefuApi.writeoffOrder(info.order_id, cartIds);
        reloadOrderContext = true;
      }
      notify("订单核销已提交");
    }
    orderAction.value = null;
    orderActionForm.value = null;
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "保存失败");
  } finally {
    orderActionBusy.value = false;
  }
  if (reloadOrderContext) await loadOrderContext();
}

async function loadOrderContext() {
  const session = selected.value;
  closeOrderDetail();
  if (!session || session.is_tourist) {
    orderItems.value = [];
    refundItems.value = [];
    return;
  }
  const request = ++orderRequest;
  ordersLoading.value = true;
  try {
    if (orderContextTab.value === "orders") {
      const list = preview
        ? previewOrderContext() as KefuOrderSummary[]
        : await kefuApi.customerOrders(session.to_uid, { search: orderSearch.value.trim(), limit: 20 }) as KefuOrderSummary[];
      if (request === orderRequest && selected.value?.id === session.id) orderItems.value = list;
    } else {
      const list = preview
        ? previewOrderContext() as KefuRefundSummary[]
        : await kefuApi.customerOrders(session.to_uid, { type: -1, search: orderSearch.value.trim(), limit: 20 }) as KefuRefundSummary[];
      if (request === orderRequest && selected.value?.id === session.id) refundItems.value = list;
    }
  } catch (cause) {
    if (request === orderRequest) notify(cause instanceof Error ? cause.message : "订单上下文加载失败");
  } finally {
    if (request === orderRequest) ordersLoading.value = false;
  }
}

async function changeOrderContextTab(tab: "orders" | "refunds") {
  if (orderContextTab.value === tab) return;
  orderContextTab.value = tab;
  await loadOrderContext();
}

async function searchOrderContext() {
  await loadOrderContext();
}

async function openOrderContextDetail(id: number, kind: "order" | "refund") {
  const request = ++orderDetailRequest;
  const sessionId = selected.value?.id;
  orderDetailLoading.value = true;
  orderDetail.value = null;
  refundDetail.value = null;
  try {
    if (kind === "order") {
      const detail = preview ? previewOrderDetails[id] ?? null : await kefuApi.orderInfo(id);
      if (!detail) throw new Error("订单未查到");
      if (request === orderDetailRequest && selected.value?.id === sessionId) orderDetail.value = structuredClone(detail);
    } else {
      const detail = preview ? previewRefundDetails[id] ?? null : await kefuApi.refundDetail(id);
      if (!detail) throw new Error("售后单未查到");
      if (request === orderDetailRequest && selected.value?.id === sessionId) refundDetail.value = structuredClone(detail);
    }
  } catch (cause) {
    if (request === orderDetailRequest) notify(cause instanceof Error ? cause.message : "订单详情加载失败");
  } finally {
    if (request === orderDetailRequest) orderDetailLoading.value = false;
  }
}

function previewProductList() {
  const keyword = productSearch.value.trim().toLowerCase();
  const source = productTab.value === "hot"
    ? [...previewProducts].sort((left, right) => right.sales - left.sales)
    : productTab.value === "visit"
      ? [...previewProducts].reverse()
      : previewProducts;
  return structuredClone(source.filter((item) => !keyword || item.store_name.toLowerCase().includes(keyword)));
}

async function loadProductContext() {
  const session = selected.value;
  ++productDetailRequest;
  productDetailLoading.value = false;
  productDetail.value = null;
  if (!session || session.is_tourist) {
    productItems.value = [];
    return;
  }
  const request = ++productRequest;
  productsLoading.value = true;
  try {
    let list: KefuProductSummary[];
    if (preview) list = previewProductList();
    else if (productTab.value === "visit") {
      list = await kefuApi.visitedProducts(session.to_uid, { store_name: productSearch.value.trim(), limit: 20 });
    } else if (productTab.value === "hot") {
      list = await kefuApi.hotProducts(session.to_uid, productSearch.value.trim());
    } else {
      list = await kefuApi.purchasedProducts(session.to_uid, { store_name: productSearch.value.trim(), limit: 20 });
    }
    if (request === productRequest && selected.value?.id === session.id) productItems.value = list;
  } catch (cause) {
    if (request === productRequest) notify(cause instanceof Error ? cause.message : "商品上下文加载失败");
  } finally {
    if (request === productRequest) productsLoading.value = false;
  }
}

async function changeProductTab(tab: "cart" | "visit" | "hot") {
  if (productTab.value === tab) return;
  productTab.value = tab;
  await loadProductContext();
}

async function searchProductContext() {
  await loadProductContext();
}

async function openProductDetail(id: number) {
  const request = ++productDetailRequest;
  const sessionId = selected.value?.id;
  productDetailLoading.value = true;
  productDetail.value = null;
  try {
    const detail = preview
      ? previewProductDetails.find((item) => item.id === id) ?? null
      : await kefuApi.productInfo(id);
    if (!detail) throw new Error("商品未查到");
    if (request === productDetailRequest && selected.value?.id === sessionId) {
      productDetail.value = structuredClone(detail);
    }
  } catch (cause) {
    if (request === productDetailRequest) {
      notify(cause instanceof Error ? cause.message : "商品详情加载失败");
    }
  } finally {
    if (request === productDetailRequest) productDetailLoading.value = false;
  }
}

function newTransferRequestKey() {
  transferRequestKey.value = crypto.randomUUID();
}

function isMine(message: ChatMessage) {
  return message.uid === kefuUid.value;
}

async function initialize() {
  loading.value = true;
  try {
    if (preview) {
      auth.usePreviewIdentity(previewIdentity);
      sessions.value = structuredClone(previewSessions);
      groups.value = structuredClone(previewGroups);
      selected.value = sessions.value[0] ?? null;
      messages.value = structuredClone(previewMessages);
      customer.value = structuredClone(previewUser);
      labelCategories.value = structuredClone(previewLabels);
      speechCategories.value = structuredClone(previewSpeechCategories);
      speechcraft.value = structuredClone(previewSpeechcraft);
      activeSpeechCategory.value = speechCategories.value[0]?.id ?? 0;
      socketState.value = "open";
      await Promise.all([loadOrderContext(), loadProductContext()]);
      await scrollToLatest();
      return;
    }
    const [customerPage, visitorPage, groupList] = await Promise.all([
      kefuApi.sessions({ limit: 60, is_tourist: 0 }),
      kefuApi.sessions({ limit: 60, is_tourist: 1 }),
      kefuApi.groups(),
      auth.refreshIdentity(),
    ]);
    sessions.value = [...customerPage.list, ...visitorPage.list]
      .sort((left, right) => right.update_time - left.update_time || right.id - left.id);
    groups.value = groupList;
    selected.value = sessions.value[0] ?? null;
    if (selected.value) await openSession(selected.value);
    await loadSpeechcraft();
    realtime.connect(
      selected.value?.to_uid ?? 0,
      selected.value?.is_tourist === 1 ? 1 : 0,
    );
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "工作台加载失败");
  } finally {
    loading.value = false;
  }
}

async function openSession(session: SessionRecord) {
  selected.value = session;
  session.mssage_num = 0;
  mobileChat.value = true;
  mobileInspector.value = false;
  try {
    if (preview) {
      messages.value = structuredClone(previewMessages).map((message) => ({
        ...message,
        uid: message.uid === 2001 ? session.to_uid : message.uid,
        to_uid: message.to_uid === 2001 ? session.to_uid : message.to_uid,
      }));
      customer.value = { ...structuredClone(previewUser), uid: session.to_uid, nickname: session.nickname, phone: session.phone, group_id: session.to_uid === 2002 ? 3 : 2 };
      labelCategories.value = structuredClone(previewLabels);
      await Promise.all([loadOrderContext(), loadProductContext()]);
      await scrollToLatest();
      return;
    }
    if (session.is_tourist === 1) {
      messages.value = await kefuApi.history(session.to_uid, { limit: 60, is_tourist: 1 });
      customer.value = {
        uid: session.to_uid,
        nickname: session.nickname,
        avatar: session.avatar,
        spread_uid: 0,
        spread_name: "",
        is_promoter: 0,
        birthday: "",
        now_money: "0",
        user_type: "visitor",
        level: 0,
        level_name: "游客会话",
        group_id: 0,
        group_name: "",
        phone: "",
        is_money_level: 0,
        labelNames: [],
        labels: [],
      };
      labelCategories.value = [];
    } else {
      const [history, userInfo, labels] = await Promise.all([
        kefuApi.history(session.to_uid, { limit: 60, is_tourist: 0 }),
        kefuApi.userInfo(session.to_uid),
        kefuApi.userLabels(session.to_uid),
      ]);
      messages.value = history;
      customer.value = userInfo;
      labelCategories.value = labels;
    }
    realtime.selectConversation(session.to_uid, session.is_tourist === 1 ? 1 : 0);
    await Promise.all([loadOrderContext(), loadProductContext()]);
    await scrollToLatest();
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "会话加载失败");
  }
}

async function scrollToLatest() {
  await nextTick();
  if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight;
}

function handleRealtimeEvent(event: RealtimeEvent) {
  if (event.type === "err_tip") {
    const data = event.data as { msg?: string } | undefined;
    notify(data?.msg ?? "实时消息处理失败");
    return;
  }
  if (event.type === "chat" || event.type === "reply") {
    const message = event.data as ChatMessage;
    sessions.value = updateSessionFromMessage(sessions.value, message, kefuUid.value);
    const peerUid = message.uid === kefuUid.value ? message.to_uid : message.uid;
    if (
      selected.value?.to_uid === peerUid
      && selected.value.is_tourist === message.is_tourist
    ) {
      messages.value = upsertMessage(messages.value, message);
      void scrollToLatest();
    }
    return;
  }
  if (event.type === "mssage_num") {
    const data = event.data as { uid: number; is_tourist: number; num: number; recored?: SessionRecord };
    const session = sessions.value.find((item) =>
      item.to_uid === data.uid && item.is_tourist === data.is_tourist
    );
    if (session) {
      session.mssage_num = selected.value?.to_uid === data.uid
        && selected.value.is_tourist === data.is_tourist ? 0 : data.num;
    }
    else if (data.recored?.id) sessions.value.unshift({ ...data.recored, phone: data.recored.phone ?? "" });
    return;
  }
  if (event.type === "online") {
    const data = event.data as { uid: number; online: number; is_tourist: number };
    const session = sessions.value.find((item) =>
      item.to_uid === data.uid && item.is_tourist === data.is_tourist
    );
    if (session) session.online = data.online;
    return;
  }
  if (event.type === "transfer_out") {
    const data = event.data as { uid: number; is_tourist: number; nickname?: string };
    void removeTransferredSession(
      data.uid,
      data.is_tourist,
      `会话已转接给${data.nickname ? ` ${data.nickname}` : "其他客服"}`,
    );
    return;
  }
  if (event.type === "transfer") {
    const data = event.data as { recored?: SessionRecord; kefuInfo?: { nickname?: string } };
    if (data.recored?.id && !sessions.value.some((item) => item.id === data.recored?.id)) {
      sessions.value.unshift({ ...data.recored, phone: data.recored.phone ?? "" });
    }
    notify(`${data.kefuInfo?.nickname ?? "其他客服"}转来一条会话`);
  }
}

async function removeTransferredSession(uid: number, isTourist: number, message?: string) {
  const wasSelected = selected.value?.to_uid === uid && selected.value.is_tourist === isTourist;
  sessions.value = sessions.value.filter((item) =>
    item.to_uid !== uid || item.is_tourist !== isTourist
  );
  if (wasSelected) {
    transferOpen.value = false;
    selected.value = null;
    messages.value = [];
    customer.value = null;
    labelCategories.value = [];
    ++orderRequest;
    orderItems.value = [];
    refundItems.value = [];
    closeOrderDetail();
    productItems.value = [];
    productDetail.value = null;
    const next = sessions.value[0];
    if (next) await openSession(next);
    else {
      realtime.connect(0, 0);
      mobileChat.value = false;
    }
  }
  if (message) notify(message);
}

async function openTransfer() {
  if (!selected.value) return;
  transferOpen.value = true;
  transferLoading.value = true;
  transferTargetUid.value = 0;
  newTransferRequestKey();
  try {
    if (preview) {
      transferTargets.value = [
        { id: 2, uid: 1002, nickname: "林舟", avatar: "", online: 1 },
        { id: 3, uid: 1003, nickname: "周宁", avatar: "", online: 1 },
      ];
    } else {
      transferTargets.value = (await kefuApi.transferTargets()).list;
    }
    transferTargetUid.value = transferTargets.value[0]?.uid ?? 0;
    if (!transferTargets.value.length) notify("当前没有其他在线客服");
  } catch (cause) {
    transferOpen.value = false;
    notify(cause instanceof Error ? cause.message : "转接客服列表加载失败");
  } finally {
    transferLoading.value = false;
  }
}

function chooseTransferTarget(uid: number) {
  if (uid === transferTargetUid.value) return;
  transferTargetUid.value = uid;
  newTransferRequestKey();
}

async function confirmTransfer() {
  const session = selected.value;
  if (!session || !transferTargetUid.value || transferBusy.value) return;
  const target = transferTargets.value.find((item) => item.uid === transferTargetUid.value);
  transferBusy.value = true;
  try {
    if (!preview) {
      await kefuApi.transfer({
        uid: session.to_uid,
        kefuToUid: transferTargetUid.value,
        request_key: transferRequestKey.value,
        is_tourist: session.is_tourist === 1 ? 1 : 0,
      });
    }
    transferOpen.value = false;
    await removeTransferredSession(session.to_uid, session.is_tourist);
    notify(`已转接给 ${target?.nickname ?? "目标客服"}`);
  } catch (cause) {
    // Keep request_key unchanged: a retry after an uncertain network outcome is safe.
    notify(cause instanceof Error ? cause.message : "客服转接失败");
  } finally {
    transferBusy.value = false;
  }
}

function sendMessage() {
  const text = composer.value.trim();
  if (!selected.value || !text) return;
  if (text.length > 2000) return notify("消息不能超过 2000 个字符");
  if (preview) {
    const message: ChatMessage = { id: Date.now(), uid: kefuUid.value, to_uid: selected.value.to_uid, msn: text, is_tourist: selected.value.is_tourist, add_time: Math.floor(Date.now() / 1000), type: 1, msn_type: 1 };
    messages.value = upsertMessage(messages.value, message);
    sessions.value = updateSessionFromMessage(sessions.value, message, kefuUid.value);
    composer.value = "";
    quickDrawer.value = false;
    void scrollToLatest();
    return;
  }
  try {
    realtime.sendMessage(selected.value.to_uid, text);
    composer.value = "";
    quickDrawer.value = false;
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "消息发送失败");
  }
}

function readPreviewImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("图片预览失败")));
    reader.readAsDataURL(file);
  });
}

function chooseImage() {
  if (!selected.value || uploadingImage.value || (!preview && socketState.value !== "open")) return;
  imageInput.value?.click();
}

async function sendSelectedImage(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const session = selected.value;
  if (!file || !session) return;
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
    notify("只支持 JPEG、PNG、WebP 或 GIF 图片");
    return;
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
    notify("图片不能超过 10 MiB");
    return;
  }
  uploadingImage.value = true;
  try {
    if (preview) {
      const message: ChatMessage = {
        id: Date.now(),
        uid: kefuUid.value,
        to_uid: session.to_uid,
        msn: await readPreviewImage(file),
        is_tourist: session.is_tourist,
        add_time: Math.floor(Date.now() / 1000),
        type: 1,
        msn_type: 3,
      };
      messages.value = upsertMessage(messages.value, message);
      sessions.value = updateSessionFromMessage(sessions.value, message, kefuUid.value);
      await scrollToLatest();
      return;
    }
    const attachment = await kefuApi.uploadImage(file);
    realtime.sendMessage(session.to_uid, attachment.url, 3);
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "图片发送失败");
  } finally {
    uploadingImage.value = false;
  }
}

function insertPhrase(message: string) {
  composer.value = message;
  quickDrawer.value = false;
}

async function loadSpeechcraft() {
  if (preview) return;
  try {
    speechCategories.value = await kefuApi.speechcraftCategories(speechType.value);
    if (!speechCategories.value.some((item) => item.id === activeSpeechCategory.value)) {
      activeSpeechCategory.value = speechCategories.value[0]?.id ?? 0;
    }
    speechcraft.value = await kefuApi.speechcraft(speechType.value, {
      cate_id: activeSpeechCategory.value || undefined,
      limit: 100,
    });
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "话术加载失败");
  }
}

async function changeSpeechType(type: 0 | 1) {
  speechType.value = type;
  activeSpeechCategory.value = 0;
  addingPhrase.value = false;
  if (preview) {
    speechCategories.value = structuredClone(previewSpeechCategories);
    activeSpeechCategory.value = speechCategories.value[0]?.id ?? 0;
    speechcraft.value = type === 0 ? structuredClone(previewSpeechcraft) : [];
  } else await loadSpeechcraft();
}

async function changeSpeechCategory(id: number) {
  activeSpeechCategory.value = id;
  if (!preview) await loadSpeechcraft();
}

async function createPhrase() {
  if (!newPhrase.value.message.trim()) return notify("请输入话术内容");
  if (!activeSpeechCategory.value) return notify("请先创建或选择个人话术分类");
  try {
    if (preview) {
      speechcraft.value.push({ id: Date.now(), kefu_id: 1, cate_id: activeSpeechCategory.value, title: newPhrase.value.title, message: newPhrase.value.message, sort: 0, add_time: Math.floor(Date.now() / 1000) });
    } else {
      await kefuApi.createSpeechcraft({ cate_id: activeSpeechCategory.value, title: newPhrase.value.title, message: newPhrase.value.message });
      await loadSpeechcraft();
    }
    newPhrase.value = { title: "", message: "" };
    addingPhrase.value = false;
    notify("个人话术已保存");
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "个人话术保存失败");
  }
}

async function createPersonalCategory() {
  const name = window.prompt("个人话术分类名称");
  if (!name?.trim()) return;
  try {
    if (preview) {
      const item = { id: Date.now(), name: name.trim(), sort: 0 };
      speechCategories.value.push(item);
      activeSpeechCategory.value = item.id;
    } else {
      const result = await kefuApi.createSpeechcraftCategory(name.trim());
      await loadSpeechcraft();
      activeSpeechCategory.value = result.id;
    }
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "个人话术分类创建失败");
  }
}

async function removePhrase(id: number) {
  try {
    if (preview) speechcraft.value = speechcraft.value.filter((item) => item.id !== id);
    else {
      await kefuApi.deleteSpeechcraft(id);
      await loadSpeechcraft();
    }
    notify("话术已删除");
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : "话术删除失败");
  }
}

async function updateGroup(event: Event) {
  if (!selected.value || !customer.value) return;
  const groupId = Number((event.target as HTMLSelectElement).value);
  if (!groupId || groupId === customer.value.group_id) return;
  try {
    if (!preview) await kefuApi.setGroup(selected.value.to_uid, groupId);
    customer.value.group_id = groupId;
    customer.value.group_name = groups.value.find((item) => item.id === groupId)?.group_name ?? "";
    notify("客户分组已更新");
  } catch (cause) { notify(cause instanceof Error ? cause.message : "分组更新失败"); }
}

function toggleLabel(id: number) {
  const label = allLabels.value.find((item) => item.id === id);
  if (label) label.disabled = !label.disabled;
}

async function saveLabels() {
  if (!selected.value) return;
  savingLabels.value = true;
  try {
    const active = allLabels.value.filter((item) => item.disabled).map((item) => item.id);
    const inactive = allLabels.value.filter((item) => !item.disabled).map((item) => item.id);
    if (!preview) {
      await kefuApi.setUserLabels(selected.value.to_uid, active, inactive);
      const [info, labels] = await Promise.all([kefuApi.userInfo(selected.value.to_uid), kefuApi.userLabels(selected.value.to_uid)]);
      customer.value = info;
      labelCategories.value = labels;
    } else if (customer.value) {
      customer.value.labelNames = selectedLabels.value.map((item) => item.label_name);
    }
    labelsEditing.value = false;
    notify("客户标签已更新");
  } catch (cause) { notify(cause instanceof Error ? cause.message : "标签更新失败"); }
  finally { savingLabels.value = false; }
}

function toggleAvailability() {
  availability.value = !availability.value;
  if (!preview) {
    try { realtime.setOnline(availability.value); }
    catch (cause) { notify(cause instanceof Error ? cause.message : "在线状态更新失败"); }
  }
}

async function logout() {
  realtime.close();
  const serverRevoked = await auth.logout();
  await router.replace(serverRevoked ? "/login" : "/login?logout=local-only");
}

function handleExpired() { void router.replace("/login"); }

watch(activeSpeechCategory, () => {
  if (!preview && !loading.value) void loadSpeechcraft();
});

onMounted(() => {
  window.addEventListener("kefu-auth-expired", handleExpired);
  void initialize();
});

onBeforeUnmount(() => {
  realtime.close();
  window.removeEventListener("kefu-auth-expired", handleExpired);
  window.clearTimeout(toastTimer);
});
</script>

<template>
  <main class="workbench" :class="{ 'mobile-list-mode': !mobileChat }">
    <aside class="app-rail">
      <div class="brand-mark small">C</div>
      <div class="agent-block">
        <span class="avatar agent-avatar">{{ initials(auth.identity?.nickname ?? '客') }}</span>
        <span class="presence-dot"></span>
        <strong>{{ auth.identity?.nickname ?? '客服' }}</strong>
      </div>
      <nav aria-label="工作台导航">
        <button class="rail-button active" title="会话"><UiIcon name="chat" /></button>
        <button class="rail-button" title="客户资料（随会话显示）"><UiIcon name="users" /></button>
        <button class="rail-button" title="快捷话术（随会话显示）"><UiIcon name="book" /></button>
        <button class="rail-button" title="设置暂未迁移" disabled><UiIcon name="settings" /></button>
      </nav>
      <button class="rail-logout" title="退出登录" @click="logout"><UiIcon name="logout" /><span>退出</span></button>
    </aside>

    <aside class="session-panel">
      <header class="session-header">
        <div><p class="eyebrow">INBOX</p><h1>会话</h1></div>
        <button class="availability" :class="{ offline: !availability }" @click="toggleAvailability">
          <span></span>{{ availability ? '在线' : '离线' }}
        </button>
      </header>
      <label class="search-box"><UiIcon name="search" /><input v-model="search" placeholder="搜索客户或手机号" /></label>
      <div class="session-tabs">
        <button :class="{ active: sessionTab === 'all' }" @click="sessionTab = 'all'">全部 <span>{{ sessions.length }}</span></button>
        <button :class="{ active: sessionTab === 'unread' }" @click="sessionTab = 'unread'">未读 <span>{{ unreadTotal }}</span></button>
      </div>
      <div class="session-list" role="list">
        <button
          v-for="session in filteredSessions" :key="session.id"
          class="session-item" :class="{ active: selected?.id === session.id }"
          @click="openSession(session)"
        >
          <span class="avatar customer-avatar">{{ initials(session.nickname) }}<i v-if="session.online"></i></span>
          <span class="session-copy"><strong>{{ session.nickname }}</strong><small>{{ sessionMessagePreview(session.message, session.message_type) || '暂无消息' }}</small></span>
          <span class="session-meta"><time>{{ compactTime(session.update_time) }}</time><b v-if="session.mssage_num">{{ session.mssage_num > 99 ? '99+' : session.mssage_num }}</b></span>
        </button>
        <div v-if="!loading && !filteredSessions.length" class="empty-state"><UiIcon name="chat" /><p>暂无匹配会话</p></div>
      </div>
    </aside>

    <section class="chat-panel" :class="{ hidden: !mobileChat }">
      <header class="chat-header">
        <button class="mobile-icon back-button" title="返回会话" @click="mobileChat = false"><UiIcon name="back" /></button>
        <template v-if="selected">
          <span class="avatar header-avatar">{{ initials(selected.nickname) }}</span>
          <div class="chat-identity"><h2>{{ selected.nickname }} <i :class="{ online: selected.online }"></i></h2><p>UID {{ selected.to_uid }} · {{ selected.is_tourist ? '游客会话' : maskedPhone(selected.phone) }}</p></div>
          <div class="header-labels"><span v-for="label in selectedLabels.slice(0, 2)" :key="label.id">{{ label.label_name }}</span></div>
          <span class="socket-status" :class="socketState">{{ preview ? '预览数据' : socketState === 'open' ? '实时连接' : socketState === 'connecting' ? '连接中' : '已断开' }}</span>
          <button class="transfer-button" title="转接会话" @click="openTransfer"><UiIcon name="users" /><span>转接</span></button>
          <button class="mobile-icon info-button" title="客户资料" @click="mobileInspector = true"><UiIcon name="info" /></button>
        </template>
        <p v-else>选择一个会话开始服务</p>
      </header>

      <div v-if="selected" ref="scrollArea" class="message-area">
        <div class="day-marker"><span>今天</span></div>
        <article v-for="message in messages" :key="message.id" class="message-row" :class="{ mine: isMine(message) }">
          <span class="avatar message-avatar">{{ isMine(message) ? initials(auth.identity?.nickname ?? '客') : initials(selected.nickname) }}</span>
          <div>
            <a v-if="message.msn_type === 3" class="message-bubble image-bubble" :href="resolveKefuAssetUrl(message.msn)" target="_blank" rel="noreferrer" title="查看原图">
              <img :src="resolveKefuAssetUrl(message.msn)" alt="聊天图片" />
            </a>
            <p v-else class="message-bubble">{{ message.msn }}</p>
            <time>{{ fullTime(message.add_time) }} <span v-if="isMine(message)">✓✓</span></time>
          </div>
        </article>
        <div v-if="!messages.length" class="empty-chat"><UiIcon name="message" /><p>还没有消息，发送一句问候开始服务。</p></div>
      </div>
      <div v-else class="chat-placeholder"><div class="brand-mark pale">C</div><h2>客户会话中心</h2><p>从左侧选择会话，查看实时消息与客户上下文。</p></div>

      <footer v-if="selected" class="composer-panel">
        <div class="composer-toolbar">
          <div class="composer-tools">
            <button title="快捷回复" :class="{ active: quickDrawer }" @click="quickDrawer = !quickDrawer"><UiIcon name="message" />快捷回复</button>
            <button :disabled="uploadingImage || (!preview && socketState !== 'open')" :title="uploadingImage ? '图片上传中' : '发送图片'" @click="chooseImage"><UiIcon name="image" />{{ uploadingImage ? '上传中…' : '发送图片' }}</button>
            <input ref="imageInput" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="选择聊天图片" @change="sendSelectedImage" />
          </div>
          <span>{{ composer.length }}/2000</span>
        </div>
        <div class="composer-row">
          <textarea v-model="composer" maxlength="2000" placeholder="输入消息，Enter 发送，Shift + Enter 换行" @keydown.enter.exact.prevent="sendMessage"></textarea>
          <button class="primary-button send-button" :disabled="!composer.trim() || (!preview && socketState !== 'open')" title="发送消息" @click="sendMessage"><UiIcon name="send" /><span>发送</span></button>
        </div>
      </footer>
    </section>

    <aside class="inspector" :class="{ open: mobileInspector }">
      <header class="mobile-drawer-header"><h2>客户资料</h2><button title="关闭" @click="mobileInspector = false"><UiIcon name="close" /></button></header>
      <template v-if="customer && selected">
        <section class="customer-card">
          <div class="customer-title"><span class="avatar inspector-avatar">{{ initials(customer.nickname) }}</span><div><h2>{{ customer.nickname }}</h2><p>{{ isTouristSession ? '匿名游客' : customer.level_name || '普通会员' }}</p></div></div>
          <dl>
            <div><dt>UID</dt><dd>{{ customer.uid }}</dd></div>
            <div v-if="isTouristSession"><dt>身份</dt><dd>独立签名游客会话</dd></div>
            <template v-else>
              <div><dt>手机号</dt><dd>{{ maskedPhone(customer.phone) }}</dd></div>
              <div><dt>账户余额</dt><dd>¥{{ customer.now_money }}</dd></div>
              <div><dt>客户分组</dt><dd><select :value="customer.group_id" @change="updateGroup"><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.group_name }}</option></select></dd></div>
            </template>
          </dl>
          <div v-if="!isTouristSession" class="label-heading"><span>客户标签</span><button @click="labelsEditing = !labelsEditing">{{ labelsEditing ? '取消' : '编辑' }}</button></div>
          <div v-if="!isTouristSession && labelsEditing" class="label-editor">
            <div v-for="category in labelCategories" :key="category.id"><small>{{ category.name }}</small><div class="label-list"><button v-for="label in category.label" :key="label.id" :class="{ selected: label.disabled }" @click="toggleLabel(label.id)">{{ label.label_name }}</button></div></div>
            <button class="secondary-button" :disabled="savingLabels" @click="saveLabels">{{ savingLabels ? '保存中…' : '保存标签' }}</button>
          </div>
          <div v-else-if="!isTouristSession" class="label-list display-labels"><span v-for="label in selectedLabels" :key="label.id">{{ label.label_name }}</span><em v-if="!selectedLabels.length">暂无标签</em></div>
        </section>

        <section v-if="!isTouristSession" class="order-context" aria-labelledby="order-context-title">
          <header>
            <div><p class="eyebrow">ORDER</p><h2 id="order-context-title">订单与售后</h2></div>
            <span>{{ orderContextTabLabel(orderContextTab) }} {{ orderContextCount }}</span>
          </header>
          <div class="order-tabs" role="tablist" aria-label="订单上下文类型">
            <button role="tab" :aria-selected="orderContextTab === 'orders'" :class="{ active: orderContextTab === 'orders' }" @click="changeOrderContextTab('orders')">订单</button>
            <button role="tab" :aria-selected="orderContextTab === 'refunds'" :class="{ active: orderContextTab === 'refunds' }" @click="changeOrderContextTab('refunds')">售后</button>
          </div>
          <form class="order-search" @submit.prevent="searchOrderContext">
            <label><span class="visually-hidden">搜索订单或商品</span><UiIcon name="search" /><input v-model="orderSearch" maxlength="100" placeholder="订单号或商品" /></label>
            <button type="submit" :disabled="ordersLoading">搜索</button>
          </form>
          <div v-if="ordersLoading" class="order-empty">正在加载{{ orderContextTabLabel(orderContextTab) }}…</div>
          <div v-else-if="orderContextTab === 'orders' && orderItems.length" class="order-list">
            <button v-for="item in orderItems" :key="item.id" class="order-row" @click="openOrderContextDetail(item.id, 'order')">
              <span class="order-row-head"><strong>{{ item.order_id }}</strong><em>{{ item._status._title }}</em></span>
              <span class="order-row-product">{{ orderProductName(item) }}<small v-if="item.total_num > 1">等 {{ item.total_num }} 件</small></span>
              <span class="order-row-foot"><time>{{ item._add_time }}</time><b>¥{{ item.pay_price }}</b></span>
            </button>
          </div>
          <div v-else-if="orderContextTab === 'refunds' && refundItems.length" class="order-list">
            <button v-for="item in refundItems" :key="item.id" class="order-row refund" @click="openOrderContextDetail(item.id, 'refund')">
              <span class="order-row-head"><strong>{{ item.order_id }}</strong><em>{{ item._status._title }}</em></span>
              <span class="order-row-product">{{ item.refund_reason || orderProductName(item) }}<small>{{ orderProductName(item) }}</small></span>
              <span class="order-row-foot"><time>{{ item._add_time }}</time><b>¥{{ item.refund_price }}</b></span>
            </button>
          </div>
          <div v-else class="order-empty">暂无{{ orderContextTabLabel(orderContextTab) }}</div>
        </section>

        <section v-if="!isTouristSession" class="product-context" aria-labelledby="product-context-title">
          <header>
            <div><p class="eyebrow">CONTEXT</p><h2 id="product-context-title">商品上下文</h2></div>
            <span>{{ productTabLabel(productTab) }} {{ productItems.length }}</span>
          </header>
          <div class="product-tabs" role="tablist" aria-label="商品上下文类型">
            <button v-for="tab in (['cart', 'visit', 'hot'] as const)" :key="tab" role="tab" :aria-selected="productTab === tab" :class="{ active: productTab === tab }" @click="changeProductTab(tab)">{{ productTabLabel(tab) }}</button>
          </div>
          <form class="product-search" @submit.prevent="searchProductContext">
            <label><span class="visually-hidden">搜索商品</span><UiIcon name="search" /><input v-model="productSearch" maxlength="100" placeholder="按商品名搜索" /></label>
            <button type="submit" :disabled="productsLoading">搜索</button>
          </form>
          <div v-if="productsLoading" class="product-empty">正在加载{{ productTabLabel(productTab) }}商品…</div>
          <div v-else-if="productItems.length" class="product-list">
            <button v-for="item in productItems" :key="`${productTab}-${item.id}`" class="product-row" @click="openProductDetail(item.id)">
              <span class="product-thumb"><img v-if="item.image" :src="resolveKefuAssetUrl(item.image)" alt="" /><b v-else>{{ initials(item.store_name) }}</b></span>
              <span class="product-copy"><strong>{{ item.store_name }}</strong><small>库存 {{ item.stock }} · 销量 {{ item.sales }}</small></span>
              <span class="product-price">¥{{ item.price }}<UiIcon name="chevron" /></span>
            </button>
          </div>
          <div v-else class="product-empty">暂无{{ productTabLabel(productTab) }}商品</div>
        </section>

        <section class="quick-panel" :class="{ 'mobile-quick-open': quickDrawer }">
          <div class="drawer-handle"></div>
          <header><h2>快捷回复</h2><button class="mobile-close-quick" title="关闭快捷回复" @click="quickDrawer = false"><UiIcon name="close" /></button></header>
          <div class="quick-tabs"><button :class="{ active: speechType === 0 }" @click="changeSpeechType(0)">公共话术</button><button :class="{ active: speechType === 1 }" @click="changeSpeechType(1)">个人话术</button></div>
          <div class="category-row">
            <button v-for="category in speechCategories" :key="category.id" :class="{ active: activeSpeechCategory === category.id }" @click="changeSpeechCategory(category.id)">{{ category.name }}</button>
            <button v-if="speechType === 1" class="icon-add" title="新增个人分类" @click="createPersonalCategory"><UiIcon name="plus" /></button>
          </div>
          <div class="phrase-list">
            <div v-for="phrase in speechcraft" :key="phrase.id" class="phrase-row">
              <button class="phrase-item" @click="insertPhrase(phrase.message)"><span><strong>{{ phrase.title || '快捷回复' }}</strong>{{ phrase.message }}</span><UiIcon name="plus" /></button>
              <button v-if="speechType === 1" class="phrase-delete" title="删除个人话术" @click="removePhrase(phrase.id)"><UiIcon name="close" /></button>
            </div>
            <p v-if="!speechcraft.length" class="phrase-empty">当前分类暂无话术</p>
          </div>
          <div v-if="speechType === 1" class="personal-actions">
            <button v-if="!addingPhrase" class="text-button" @click="addingPhrase = true"><UiIcon name="plus" />新增个人话术</button>
            <form v-else class="phrase-form" @submit.prevent="createPhrase"><input v-model="newPhrase.title" maxlength="100" placeholder="话术标题（可选）" /><textarea v-model="newPhrase.message" maxlength="255" placeholder="话术内容"></textarea><div><button type="button" @click="addingPhrase = false">取消</button><button class="primary-button" type="submit">保存</button></div></form>
          </div>
        </section>
      </template>
      <div v-else class="empty-inspector"><UiIcon name="info" /><p>选择会话后显示客户资料</p></div>
    </aside>

    <div v-if="mobileInspector" class="mobile-scrim" @click="mobileInspector = false"></div>
    <div v-if="transferOpen" class="transfer-scrim" @click.self="transferOpen = false">
      <section class="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
        <header><div><p class="eyebrow accent">HANDOFF</p><h2 id="transfer-title">转接会话</h2></div><button title="关闭" :disabled="transferBusy" @click="transferOpen = false"><UiIcon name="close" /></button></header>
        <p class="transfer-note">将 {{ selected?.nickname }} 的完整会话安全转接给另一位在线客服。提交后你将不能再访问该会话。</p>
        <div v-if="transferLoading" class="transfer-empty">正在查找在线客服…</div>
        <div v-else-if="!transferTargets.length" class="transfer-empty">当前没有可转接的在线客服</div>
        <div v-else class="transfer-list" role="radiogroup" aria-label="目标客服">
          <button v-for="target in transferTargets" :key="target.id" role="radio" :aria-checked="transferTargetUid === target.uid" :class="{ selected: transferTargetUid === target.uid }" @click="chooseTransferTarget(target.uid)">
            <span class="avatar transfer-avatar">{{ initials(target.nickname) }}<i></i></span><span><strong>{{ target.nickname }}</strong><small>UID {{ target.uid }} · 在线</small></span><em></em>
          </button>
        </div>
        <footer><button class="dialog-cancel" :disabled="transferBusy" @click="transferOpen = false">取消</button><button class="primary-button" :disabled="!transferTargetUid || transferBusy" @click="confirmTransfer">{{ transferBusy ? '转接中…' : '确认转接' }}</button></footer>
      </section>
    </div>
    <div v-if="productDetail || productDetailLoading" class="product-detail-scrim" @click.self="productDetail = null">
      <section class="product-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="product-detail-title">
        <div v-if="productDetailLoading" class="product-detail-loading">正在加载商品详情…</div>
        <template v-else-if="productDetail">
          <header><div><p class="eyebrow accent">PRODUCT</p><h2 id="product-detail-title">{{ productDetail.store_name }}</h2></div><button title="关闭" @click="productDetail = null"><UiIcon name="close" /></button></header>
          <div class="product-detail-body">
            <div class="product-detail-media"><img v-if="productDetail.image" :src="resolveKefuAssetUrl(productDetail.image)" alt="" /><span v-else>{{ initials(productDetail.store_name) }}</span></div>
            <dl>
              <div><dt>售价</dt><dd>¥{{ productDetail.price }}</dd></div>
              <div><dt>会员价</dt><dd>¥{{ productDetail.vip_price }}</dd></div>
              <div><dt>划线价</dt><dd>¥{{ productDetail.ot_price }}</dd></div>
              <div><dt>库存 / 销量</dt><dd>{{ productDetail.stock }} / {{ productDetail.sales }}</dd></div>
            </dl>
            <p class="product-description">{{ productDetail.description || '暂无商品说明' }}</p>
          </div>
        </template>
      </section>
    </div>
    <div v-if="orderDetail || refundDetail || orderDetailLoading" class="order-detail-scrim" @click.self="closeOrderDetail">
      <section class="order-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">
        <div v-if="orderDetailLoading" class="order-detail-loading">正在加载订单详情…</div>
        <template v-else-if="orderDetail">
          <header>
            <div><p class="eyebrow accent">ORDER</p><h2 id="order-detail-title">{{ orderDetail.orderInfo.order_id }}</h2></div>
            <button title="关闭" @click="closeOrderDetail"><UiIcon name="close" /></button>
          </header>
          <div class="order-detail-body">
            <div class="order-detail-status"><strong>{{ orderDetail.orderInfo._status._title }}</strong><span>{{ orderDetail.orderInfo._status._msg || '订单状态已更新' }}</span></div>
            <div class="order-detail-actions">
              <button v-if="!orderDetail.orderInfo.paid" :disabled="orderActionBusy" @click="openOrderEdit">修改金额</button>
              <button v-if="canFulfill(orderDetail.orderInfo)" :disabled="orderActionBusy" @click="openFulfillment">订单履约</button>
              <button v-if="canWriteoff(orderDetail.orderInfo)" :disabled="orderActionBusy" @click="openWriteoff">订单核销</button>
              <button :disabled="orderActionBusy" @click="openOrderRemark('order')">编辑备注</button>
            </div>
            <dl class="order-detail-summary">
              <div><dt>实付金额</dt><dd>¥{{ orderDetail.orderInfo.pay_price }}</dd></div>
              <div><dt>客户</dt><dd>{{ orderDetail.orderInfo.real_name || orderDetail.userInfo.nickname }}</dd></div>
              <div><dt>下单时间</dt><dd>{{ orderDetail.orderInfo._add_time }}</dd></div>
              <div><dt>支付方式</dt><dd>{{ orderDetail.orderInfo._status._payType || orderDetail.orderInfo.pay_type }}</dd></div>
            </dl>
            <div v-if="orderDetail.orderInfo.user_address" class="order-detail-note"><span>收货信息</span><p>{{ orderDetail.orderInfo.real_name }} · {{ maskedPhone(orderDetail.orderInfo.user_phone) }}<br />{{ orderDetail.orderInfo.user_address }}</p></div>
            <div v-if="orderDetail.orderInfo.remark" class="order-detail-note"><span>订单备注</span><p>{{ orderDetail.orderInfo.remark }}</p></div>
            <div class="order-detail-items">
              <article v-for="cart in orderDetail.orderInfo.cartInfo" :key="cart.unique">
                <span class="order-item-thumb"><img v-if="cart.productInfo.image" :src="resolveKefuAssetUrl(cart.productInfo.image)" alt="" /><b v-else>{{ initials(cart.productInfo.store_name) }}</b></span>
                <div><strong>{{ cart.productInfo.store_name }}</strong><small>{{ cart.productInfo.attrInfo.suk || '默认规格' }} · × {{ cart.cart_num }}</small></div>
                <em>¥{{ cart.truePrice }}</em>
              </article>
            </div>
          </div>
        </template>
        <template v-else-if="refundDetail">
          <header>
            <div><p class="eyebrow accent">AFTER-SALE</p><h2 id="order-detail-title">{{ refundDetail.orderInfo.order_id }}</h2></div>
            <button title="关闭" @click="closeOrderDetail"><UiIcon name="close" /></button>
          </header>
          <div class="order-detail-body">
            <div class="order-detail-status refund"><strong>{{ refundDetail.orderInfo._status._title }}</strong><span>{{ refundDetail.orderInfo._status.status_name || refundDetail.orderInfo._status.desc || '售后状态已更新' }}</span></div>
            <div class="order-detail-actions">
              <button :disabled="orderActionBusy" @click="openOrderRemark('refund')">编辑售后备注</button>
            </div>
            <dl class="order-detail-summary">
              <div><dt>申请金额</dt><dd>¥{{ refundDetail.orderInfo.refund_price }}</dd></div>
              <div><dt>原订单号</dt><dd>{{ refundDetail.orderInfo.store_order_sn || refundDetail.orderInfo.store_order_id }}</dd></div>
              <div><dt>申请时间</dt><dd>{{ refundDetail.orderInfo._add_time }}</dd></div>
              <div><dt>客户</dt><dd>{{ refundDetail.orderInfo.real_name || refundDetail.userInfo.nickname }}</dd></div>
            </dl>
            <div class="order-detail-note"><span>售后原因</span><p>{{ refundDetail.orderInfo.refund_reason || '客户未填写原因' }}</p></div>
            <div v-if="refundDetail.orderInfo.remark" class="order-detail-note"><span>处理备注</span><p>{{ refundDetail.orderInfo.remark }}</p></div>
            <div class="order-detail-items">
              <article v-for="cart in refundDetail.orderInfo.cartInfo" :key="cart.unique">
                <span class="order-item-thumb"><img v-if="cart.productInfo.image" :src="resolveKefuAssetUrl(cart.productInfo.image)" alt="" /><b v-else>{{ initials(cart.productInfo.store_name) }}</b></span>
                <div><strong>{{ cart.productInfo.store_name }}</strong><small>{{ cart.productInfo.attrInfo.suk || '默认规格' }} · 申请 {{ cart.refund_num || cart.cart_num }} 件</small></div>
                <em>¥{{ cart.truePrice }}</em>
              </article>
            </div>
          </div>
        </template>
      </section>
    </div>
    <div v-if="orderAction" class="order-action-scrim" @click.self="closeOrderAction">
      <section class="order-action-dialog" role="dialog" aria-modal="true" aria-labelledby="order-action-title">
        <header>
          <div><p class="eyebrow accent">MANAGE</p><h2 id="order-action-title">{{ orderAction === 'edit' ? '修改订单' : orderAction === 'order-remark' ? '编辑订单备注' : orderAction === 'refund-remark' ? '编辑售后备注' : orderAction === 'fulfillment' ? '订单履约' : '订单核销' }}</h2></div>
          <button title="关闭" :disabled="orderActionBusy" @click="closeOrderAction"><UiIcon name="close" /></button>
        </header>
        <form class="order-action-form" @submit.prevent="submitOrderAction">
          <template v-if="orderAction === 'edit'">
            <label><span>订单编号</span><input :value="editReadonlyValues.order_id" disabled /></label>
            <div class="order-action-readonly">
              <span>商品总价 <b>¥{{ editReadonlyValues.total_price }}</b></span>
              <span>原始邮费 <b>¥{{ editReadonlyValues.total_postage }}</b></span>
              <span>实际邮费 <b>¥{{ editReadonlyValues.pay_postage }}</b></span>
            </div>
            <label><span>实际支付金额</span><input v-model="editPayPrice" required inputmode="decimal" pattern="\d+(?:\.\d{1,2})?" maxlength="14" /></label>
            <label><span>赠送积分</span><input v-model="editGainIntegral" required inputmode="numeric" pattern="\d+" maxlength="10" /></label>
            <p class="order-action-note">仅未支付订单可改价；商品总价与邮费只读，提交时会再次核对数据库快照。</p>
          </template>
          <template v-else-if="orderAction === 'fulfillment'">
            <div class="fulfillment-types" role="tablist" aria-label="履约方式">
              <button type="button" :class="{ active: fulfillmentType === 'express' }" :disabled="!expressOptions.length" @click="fulfillmentType = 'express'">快递发货</button>
              <button type="button" :class="{ active: fulfillmentType === 'send' }" :disabled="!deliveryAgents.length" @click="fulfillmentType = 'send'">平台配送</button>
              <button type="button" :class="{ active: fulfillmentType === 'fictitious' }" @click="fulfillmentType = 'fictitious'">虚拟发货</button>
            </div>
            <template v-if="fulfillmentType === 'express'">
              <label><span>快递公司</span><select v-model.number="fulfillmentExpressId" required><option v-for="item in expressOptions" :key="item.id" :value="item.id">{{ item.value }}</option></select></label>
              <label><span>快递单号</span><input v-model="fulfillmentTrackingNo" required maxlength="64" autocomplete="off" /></label>
              <p class="order-action-note">客服入口只提交手工单号；电子面单必须走可重试任务，避免第三方结果不明时重复下单。</p>
            </template>
            <template v-else-if="fulfillmentType === 'send'">
              <label><span>配送员</span><select v-model.number="fulfillmentAgentUid" required><option v-for="item in deliveryAgents" :key="item.id" :value="item.uid">{{ item.nickname }} · {{ maskedPhone(item.phone) }}</option></select></label>
              <p class="order-action-note">提交时以后端启用配送员资料为准，并生成新的 12 位核销码。</p>
            </template>
            <template v-else>
              <label><span>虚拟发货内容</span><textarea v-model="fulfillmentVirtualContent" required maxlength="500" rows="4" /></label>
            </template>
            <label v-if="fulfillmentCarts.length" class="order-action-toggle"><input v-model="fulfillmentSplit" type="checkbox" /><span>仅发本次选中的商品（拆单发货）</span></label>
            <div v-if="fulfillmentSplit" class="fulfillment-cart-list">
              <label v-for="cart in fulfillmentCarts" :key="cart.cart_id">
                <span><strong>{{ cart.product_name }}</strong><small>{{ cart.sku || '默认规格' }} · 可发 {{ cart.surplus_num }}</small></span>
                <input v-model.number="fulfillmentQuantities[cart.cart_id]" type="number" min="0" :max="cart.surplus_num" step="1" inputmode="numeric" />
              </label>
            </div>
          </template>
          <template v-else-if="orderAction === 'writeoff' && writeoffInfo">
            <div class="writeoff-summary"><span>订单号 <b>{{ writeoffInfo.order_id }}</b></span><span>客户 <b>{{ writeoffInfo.real_name }}</b></span></div>
            <div class="fulfillment-cart-list writeoff-list">
              <label v-for="cart in writeoffInfo.cart_info" :key="cart.cart_id">
                <span><strong>{{ writeoffCartName(cart) }}</strong><small>剩余可核销 {{ cart.write_surplus_times }} / {{ cart.write_times }}</small></span>
                <input v-model.number="writeoffQuantities[cart.cart_id]" type="number" min="0" :max="cart.write_surplus_times" step="1" inputmode="numeric" :disabled="cart.write_surplus_times < 1" />
              </label>
            </div>
            <p class="order-action-note">核销会在同一事务扣减次数、写入操作证据并执行订单收货结算；请核对数量后提交。</p>
          </template>
          <template v-else>
            <label><span>{{ orderAction === 'refund-remark' ? '售后备注' : '订单备注' }}</span><textarea v-model="editRemark" required :maxlength="orderAction === 'refund-remark' ? 255 : 512" rows="5" /></label>
            <small class="order-action-count">{{ editRemark.length }} / {{ orderAction === 'refund-remark' ? 255 : 512 }}</small>
          </template>
          <footer><button type="button" class="dialog-cancel" :disabled="orderActionBusy" @click="closeOrderAction">取消</button><button type="submit" class="primary-button" :disabled="orderActionBusy">{{ orderActionBusy ? '保存中…' : '保存' }}</button></footer>
        </form>
      </section>
    </div>
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
    <div v-if="loading" class="loading-screen"><div class="brand-mark pulse">C</div><p>正在载入客服工作台…</p></div>
  </main>
</template>
