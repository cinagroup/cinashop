export interface ApiEnvelope<T> {
  status: number;
  msg: string;
  data: T;
}

export interface KefuIdentity {
  id: number;
  uid: number;
  account: string;
  avatar: string;
  nickname: string;
  phone: string;
  online: number;
  site_name?: string;
}

export interface TransferTarget {
  id: number;
  uid: number;
  avatar: string;
  nickname: string;
  online: number;
}

export interface TransferResult {
  request_key: string;
  idempotent: boolean;
  uid: number;
  from_uid: number;
  to_uid: number;
  copied_message_count: number;
  recored: SessionRecord | null;
}

export interface LoginResult {
  token: string;
  exp_time: number;
  kefuInfo: KefuIdentity;
}

export interface KefuClientConfig {
  appid: string;
  site_name: string;
  version: string;
}

export interface KefuScanChallenge {
  key: string;
  poll_token: string;
  time: number;
  expires_in: number;
  audience: "kefu_agent";
}

export type KefuScanPollResult =
  | { status: 0 }
  | { status: 1 | 2; audience: "kefu_agent"; expiresAt: number }
  | ({ status: 3 } & LoginResult);

export interface AttachmentUpload {
  att_id: number;
  name: string;
  size: number;
  type: string;
  /** Stable reference stored in chat records. */
  url: string;
  /** Short-lived signed preview URL. */
  src: string;
}

export interface KefuProductSummary {
  id: number;
  sales: number;
  store_name: string;
  image: string;
  stock: number;
  price: string;
  ot_price?: string;
}

export interface KefuProductDetail extends KefuProductSummary {
  slider_image: string[];
  vip_price: string;
  ot_price: string;
  description: string;
}

export interface KefuOrderCartItem {
  unique: string;
  id: number;
  cart_id: string;
  product_id: number;
  product_type: number;
  cart_num: number;
  refund_num: number;
  surplus_num: number;
  is_gift: number;
  is_support_refund: number;
  truePrice: string;
  vip_truePrice: string;
  vip_sum_truePrice: string;
  sum_true_price: string;
  productInfo: {
    id: number;
    store_name: string;
    image: string;
    price: string;
    attrInfo: { suk: string; image: string; price: string };
  };
}

export interface KefuOrderStatus {
  _type: number;
  _title: string;
  _msg?: string;
  _class?: string;
  _payType?: string;
  _deliveryType?: string;
}

export interface KefuOrderSummary {
  id: number;
  order_id: string;
  uid: number;
  real_name: string;
  user_phone: string;
  user_address: string;
  total_num: number;
  total_price: string;
  pay_price: string;
  paid: number;
  status: number;
  shipping_type: number;
  delivery_type?: string;
  delivery_name?: string;
  delivery_code?: string;
  delivery_id?: string;
  pay_type: string;
  pay_time: number;
  add_time: number;
  refund_status: number;
  refund_type: number;
  type: number;
  type_name: string;
  remark: string;
  _add_time: string;
  _pay_time: string;
  _status: KefuOrderStatus;
  cartInfo: KefuOrderCartItem[];
  is_all_refund: boolean;
}

export interface KefuRefundSummary {
  id: number;
  store_order_id: number;
  order_id: string;
  uid: number;
  refund_type: number;
  refund_num: number;
  refund_price: string;
  refunded_price: string;
  refund_reason: string;
  refuse_reason: string;
  remark: string;
  add_time: number | string;
  _add_time: string;
  total_num: number;
  pay_price: string;
  refund_status: number;
  _status: KefuOrderStatus & { status_name?: string; desc?: string };
  cartInfo: KefuOrderCartItem[];
  store_order_sn?: string;
  shipping_type?: number;
  real_name?: string;
  user_phone?: string;
  user_address?: string;
  orderStatus?: KefuOrderStatus;
}

export interface KefuOrderDetail {
  orderInfo: KefuOrderSummary & {
    invoice?: Record<string, unknown> | null;
    promotions_detail?: Array<Record<string, unknown>>;
    vip_true_price?: string;
  };
  userInfo: {
    uid: number;
    nickname: string;
    avatar: string;
    phone: string;
    group_id: number;
    now_money: string;
    integral: number;
    spread_uid: number;
    account?: string;
    real_name?: string;
    status?: number;
  };
}

export interface KefuRefundDetail {
  orderInfo: KefuRefundSummary;
  userInfo: KefuOrderDetail["userInfo"];
}

export interface KefuRefundListResult {
  list: KefuRefundSummary[];
  count: number;
  num: Record<string, { name: string; num: number }>;
}

export interface KefuManagementFormField {
  field: string;
  label: string;
  type: "input" | "number";
  value: string;
  disabled?: boolean;
  min?: number;
  precision?: number;
  required?: boolean;
}

export interface KefuManagementForm {
  title: string;
  action: string;
  method: "PUT";
  fields: KefuManagementFormField[];
}

export interface KefuOrderEditResult {
  id: number;
  order_id: string;
  pay_price: string;
  gain_integral: string;
  changed: boolean;
}

export interface KefuRemarkResult {
  kind: "order" | "refund";
  id: number;
  order_id: string;
  remark: string;
  changed: boolean;
}

export interface KefuExpressOption {
  id: number;
  value: string;
  code: string;
}

export interface KefuDeliveryAgent {
  id: number;
  uid: number;
  avatar: string;
  wx_name: string;
  nickname: string;
  phone: string;
  status: number;
}

export interface KefuSplitCartItem {
  id: number;
  cart_id: string;
  product_id: number;
  sku_unique: string;
  cart_num: number;
  refund_num: number;
  surplus_num: number;
  product_name: string;
  image: string;
  sku: string;
  cart_info: Record<string, unknown> | null;
}

export interface KefuFulfillmentResult {
  split: boolean;
  order_id: number;
  remaining_order_id: number | null;
  idempotent: boolean;
}

export interface KefuWriteoffCartItem {
  id: number;
  cart_id: string;
  product_id: number;
  product_type: number;
  write_times: number;
  write_surplus_times: number;
  is_writeoff: number;
  write_start: number;
  write_end: number;
  cart_info: Record<string, unknown> | null;
}

export interface KefuWriteoffInfo {
  id: number;
  order_id: string;
  store_id: number;
  shipping_type: number;
  delivery_type: string;
  actor_kind: "kefu";
  real_name: string;
  user_phone: string;
  status: number;
  total_num: number;
  cart_info: KefuWriteoffCartItem[];
}

export interface KefuWriteoffResult {
  order_id: string;
  completed: boolean;
  status: number;
}

export interface SessionRecord {
  id: number;
  user_id: number;
  to_uid: number;
  nickname: string;
  avatar: string;
  phone: string;
  is_tourist: number;
  online: number;
  type: number;
  add_time: number;
  update_time: number;
  mssage_num: number;
  message: string;
  message_type: number;
}

export interface SessionPage {
  list: SessionRecord[];
  next_cursor: string | null;
}

export interface ChatMessage {
  id: number;
  mer_id?: number;
  msn: string;
  uid: number;
  to_uid: number;
  is_tourist: number;
  time_node?: string;
  add_time: number;
  type: number;
  remind?: number;
  msn_type: number;
  nickname?: string;
  avatar?: string;
  sender_role?: 1 | 2 | 3;
  recored?: SessionRecord;
}

export interface UserLabel {
  id: number;
  label_name: string;
  color: string;
  disabled: boolean;
}

export interface UserLabelCategory {
  id: number;
  name: string;
  sort: number;
  label: UserLabel[];
}

export interface UserGroup {
  id: number;
  group_name: string;
}

export interface UserInfo {
  uid: number;
  nickname: string;
  avatar: string;
  spread_uid: number;
  spread_name: string;
  is_promoter: number;
  birthday: string;
  now_money: string;
  user_type: string;
  level: number;
  level_name: string;
  group_id: number;
  group_name: string;
  phone: string;
  is_money_level: number;
  labelNames: string[];
  labels: Array<{ id: number; label_name: string; color: string }>;
}

export interface SpeechcraftCategory {
  id: number;
  name: string;
  sort: number;
}

export interface Speechcraft {
  id: number;
  kefu_id: number;
  cate_id: number;
  title: string;
  message: string;
  sort: number;
  add_time: number;
}

export interface RealtimeEvent {
  type?: "chat" | "reply" | "mssage_num" | "online" | "err_tip" | "ping" | "transfer" | "transfer_out" | "to_transfer";
  status?: number;
  msg?: string;
  data?: unknown;
}
