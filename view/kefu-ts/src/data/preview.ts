import type {
  ChatMessage,
  KefuIdentity,
  KefuOrderCartItem,
  KefuOrderDetail,
  KefuOrderSummary,
  KefuProductDetail,
  KefuProductSummary,
  KefuRefundDetail,
  KefuRefundSummary,
  SessionRecord,
  Speechcraft,
  SpeechcraftCategory,
  UserGroup,
  UserInfo,
  UserLabelCategory,
} from "@/types/kefu";

const now = Math.floor(Date.now() / 1000);

export const previewIdentity: KefuIdentity = {
  id: 1, uid: 1001, account: "preview", avatar: "", nickname: "客服一",
  phone: "", online: 1, site_name: "CinaShop",
};

export const previewSessions: SessionRecord[] = [
  { id: 11, user_id: 1001, to_uid: 2001, nickname: "客户一", avatar: "", phone: "13900000001", is_tourist: 0, online: 1, type: 0, add_time: now - 7200, update_time: now - 150, mssage_num: 0, message: "请问这款商品还有库存吗？", message_type: 1 },
  { id: 12, user_id: 1001, to_uid: 2002, nickname: "客户二", avatar: "", phone: "13800000002", is_tourist: 0, online: 0, type: 0, add_time: now - 8600, update_time: now - 1980, mssage_num: 2, message: "订单什么时候发货？", message_type: 1 },
  { id: 13, user_id: 1001, to_uid: 2003, nickname: "客户三", avatar: "", phone: "13700000003", is_tourist: 0, online: 0, type: 0, add_time: now - 86400, update_time: now - 86400, mssage_num: 0, message: "好的，谢谢！", message_type: 1 },
  { id: 14, user_id: 1001, to_uid: 2004, nickname: "客户四", avatar: "", phone: "13600000004", is_tourist: 0, online: 1, type: 0, add_time: now - 172800, update_time: now - 172800, mssage_num: 1, message: "能帮我修改收货地址吗？", message_type: 1 },
];

export const previewMessages: ChatMessage[] = [
  { id: 101, uid: 2001, to_uid: 1001, msn: "请问这款商品还有库存吗？", is_tourist: 0, add_time: now - 240, type: 0, msn_type: 1 },
  { id: 102, uid: 1001, to_uid: 2001, msn: "您好，目前库存充足，可以正常下单。", is_tourist: 0, add_time: now - 180, type: 1, msn_type: 1 },
];

export const previewUser: UserInfo = {
  uid: 2001, nickname: "客户一", avatar: "", spread_uid: 0, spread_name: "",
  is_promoter: 0, birthday: "", now_money: "286.50", user_type: "wechat",
  level: 2, level_name: "银卡会员", group_id: 2, group_name: "重点客户",
  phone: "13900000001", is_money_level: 0,
  labelNames: ["咨询客户", "重点跟进"],
  labels: [
    { id: 1, label_name: "咨询客户", color: "#e8f3ff" },
    { id: 2, label_name: "重点跟进", color: "#fff0e5" },
  ],
};

export const previewGroups: UserGroup[] = [
  { id: 1, group_name: "普通客户" },
  { id: 2, group_name: "重点客户" },
  { id: 3, group_name: "待回访" },
];

export const previewLabels: UserLabelCategory[] = [
  { id: 1, name: "客户状态", sort: 10, label: [
    { id: 1, label_name: "咨询客户", color: "#e8f3ff", disabled: true },
    { id: 2, label_name: "重点跟进", color: "#fff0e5", disabled: true },
    { id: 3, label_name: "待回访", color: "#eef8ee", disabled: false },
  ] },
];

export const previewProducts: KefuProductSummary[] = [
  { id: 701, store_name: "双盖保温随行杯", image: "", sales: 368, stock: 42, price: "79.00", ot_price: "99.00" },
  { id: 702, store_name: "云朵棉旅行颈枕", image: "", sales: 214, stock: 18, price: "49.90", ot_price: "69.00" },
  { id: 703, store_name: "轻量防水收纳包", image: "", sales: 529, stock: 76, price: "35.00", ot_price: "45.00" },
];

export const previewProductDetails: KefuProductDetail[] = previewProducts.map((item) => ({
  ...item,
  slider_image: [],
  vip_price: (Number(item.price) * 0.9).toFixed(2),
  ot_price: item.ot_price ?? item.price,
  description: "适合日常和旅行场景，库存与价格以商品页面为准。",
}));

const previewOrderCarts: KefuOrderCartItem[] = [
  {
    unique: "preview-order-cup", id: 8101, cart_id: "5101", product_id: 701, product_type: 0,
    cart_num: 1, refund_num: 0, surplus_num: 1, is_gift: 0, is_support_refund: 1,
    truePrice: "79.00", vip_truePrice: "0.00", vip_sum_truePrice: "0.00", sum_true_price: "79.00",
    productInfo: { id: 701, store_name: "双盖保温随行杯", image: "", price: "79.00", attrInfo: { suk: "珊瑚红", image: "", price: "79.00" } },
  },
  {
    unique: "preview-order-pillow", id: 8102, cart_id: "5102", product_id: 702, product_type: 0,
    cart_num: 1, refund_num: 1, surplus_num: 0, is_gift: 0, is_support_refund: 1,
    truePrice: "49.90", vip_truePrice: "4.99", vip_sum_truePrice: "4.99", sum_true_price: "49.90",
    productInfo: { id: 702, store_name: "云朵棉旅行颈枕", image: "", price: "49.90", attrInfo: { suk: "云雾灰", image: "", price: "49.90" } },
  },
];

export const previewOrders: KefuOrderSummary[] = [
  {
    id: 801, order_id: "wx202608270001", uid: 2001, real_name: "客户一", user_phone: "13900000001",
    user_address: "新加坡示例地址 1 号", total_num: 2, total_price: "128.90", pay_price: "128.90",
    paid: 1, status: 0, shipping_type: 1, pay_type: "weixin", pay_time: now - 7200, add_time: now - 7300,
    refund_status: 0, refund_type: 0, type: 0, type_name: "普通", remark: "优先发货",
    _add_time: "2026-08-27 18:03:00", _pay_time: "2026-08-27 18:05:00",
    _status: { _type: 1, _title: "未发货", _msg: "商家未发货,请耐心等待", _payType: "微信支付", _deliveryType: "快递" },
    cartInfo: structuredClone(previewOrderCarts), is_all_refund: false,
  },
  {
    id: 802, order_id: "wx202608260008", uid: 2001, real_name: "客户一", user_phone: "13900000001",
    user_address: "新加坡示例地址 1 号", total_num: 1, total_price: "49.90", pay_price: "44.91",
    paid: 1, status: 1, shipping_type: 1, pay_type: "yue", pay_time: now - 86400, add_time: now - 86500,
    refund_status: 1, refund_type: 1, type: 0, type_name: "普通", remark: "",
    _add_time: "2026-08-26 19:58:00", _pay_time: "2026-08-26 20:00:00",
    _status: { _type: -1, _title: "申请退款中", _msg: "商家审核中,请耐心等待", _payType: "余额支付", _deliveryType: "快递" },
    cartInfo: [structuredClone(previewOrderCarts[1])], is_all_refund: true,
  },
  {
    id: 803, order_id: "wx202608250016", uid: 2001, real_name: "客户一", user_phone: "13900000001",
    user_address: "新加坡示例地址 1 号", total_num: 1, total_price: "35.00", pay_price: "35.00",
    paid: 0, status: 0, shipping_type: 1, pay_type: "weixin", pay_time: 0, add_time: now - 172800,
    refund_status: 0, refund_type: 0, type: 0, type_name: "普通", remark: "",
    _add_time: "2026-08-25 20:00:00", _pay_time: "",
    _status: { _type: 0, _title: "待付款", _msg: "等待客户完成支付" },
    cartInfo: [{ ...structuredClone(previewOrderCarts[0]), product_id: 703, productInfo: { id: 703, store_name: "轻量防水收纳包", image: "", price: "35.00", attrInfo: { suk: "雾蓝", image: "", price: "35.00" } } }],
    is_all_refund: false,
  },
];

export const previewRefunds: KefuRefundSummary[] = [
  {
    id: 901, store_order_id: 802, order_id: "refund202608260001", uid: 2001,
    refund_type: 1, refund_num: 1, refund_price: "44.91", refunded_price: "0.00",
    refund_reason: "尺寸不合适", refuse_reason: "", remark: "等待审核", add_time: "2026-08-27 09:10",
    _add_time: "2026-08-27 09:10:00", total_num: 1, pay_price: "44.91", refund_status: 1,
    _status: { _type: 0, _title: "申请中", status_name: "商家审核中", desc: "等待处理售后申请" },
    cartInfo: [structuredClone(previewOrderCarts[1])],
  },
];

const previewOrderUser = {
  uid: 2001, account: "customer-2001", real_name: "客户一", nickname: "客户一", avatar: "",
  phone: "13900000001", group_id: 2, now_money: "286.50", integral: 168, spread_uid: 0, status: 1,
};

export const previewOrderDetails: Record<number, KefuOrderDetail> = Object.fromEntries(previewOrders.map((order) => [order.id, {
  orderInfo: { ...structuredClone(order), invoice: null, promotions_detail: [], vip_true_price: "4.99" },
  userInfo: structuredClone(previewOrderUser),
}]));

export const previewRefundDetails: Record<number, KefuRefundDetail> = {
  901: {
    orderInfo: {
      ...structuredClone(previewRefunds[0]), store_order_sn: "wx202608260008", shipping_type: 1,
      real_name: "客户一", user_phone: "13900000001", user_address: "新加坡示例地址 1 号",
      orderStatus: previewOrders[1]._status,
    },
    userInfo: structuredClone(previewOrderUser),
  },
};

export const previewSpeechCategories: SpeechcraftCategory[] = [
  { id: 1, name: "售前咨询", sort: 10 },
  { id: 2, name: "物流", sort: 8 },
  { id: 3, name: "售后", sort: 6 },
];

export const previewSpeechcraft: Speechcraft[] = [
  { id: 1, kefu_id: 0, cate_id: 1, title: "欢迎语", message: "您好，很高兴为您服务，请问有什么可以帮您？", sort: 10, add_time: now },
  { id: 2, kefu_id: 0, cate_id: 1, title: "库存", message: "这款商品目前库存充足，可以正常下单。", sort: 9, add_time: now },
  { id: 3, kefu_id: 0, cate_id: 1, title: "确认规格", message: "请您提供一下具体的商品或颜色尺码，我为您查询。", sort: 8, add_time: now },
];
