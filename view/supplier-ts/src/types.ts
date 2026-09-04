export interface SupplierUser {
  id: number;
  account: string;
  avatar: string;
  real_name: string;
  supplier_id: number;
  supplier_name: string;
  is_primary: boolean;
}

export interface SupplierNavigationItem {
  path: string;
  name: string;
  icon: string;
  permission: string;
}

export interface LoginResult {
  token: string;
  expires_time: number;
  user_info: SupplierUser;
  unique_auth: string[];
  menus: SupplierNavigationItem[];
}

export interface SupplierRoleOption {
  value: number;
  label: string;
}

export interface SupplierRole {
  id: number;
  role_name: string;
  rules: string[];
  level: number;
  status: number;
}

export interface SupplierPermissionTreeNode {
  key: string;
  label: string;
  children: Array<{ key: string; label: string }>;
}

export interface SupplierRoleListResult {
  list: SupplierRole[];
  permission_tree: SupplierPermissionTreeNode[];
}

export interface SupplierRolePayload {
  role_name: string;
  rules: string[];
  status: 0 | 1;
}

export interface SupplierAdministrator {
  id: number;
  account: string;
  real_name: string;
  phone: string;
  head_pic: string;
  roles: number[];
  role_names: string[];
  status: number;
  level: number;
  add_time: number;
  last_time: number;
  login_count: number;
  _add_time: string;
  _last_time: string;
}

export interface SupplierAdminFormDefinition {
  title: string;
  action: string;
  method: "POST" | "PUT";
  rules: Array<Record<string, unknown>>;
  role_options: SupplierRoleOption[];
  info: SupplierAdministrator | null;
}

export interface SupplierAdminPayload {
  account: string;
  real_name: string;
  phone: string;
  head_pic: string;
  roles: number[];
  status: 0 | 1;
  pwd: string;
  conf_pwd: string;
}

export interface DashboardStats {
  today_sales: string;
  yesterday_sales: string;
  month_sales: string;
  today_orders: number;
  yesterday_orders: number;
  month_orders: number;
  pending_delivery: number;
  product_count: number;
  refund_count: number;
  trend: Array<{ date: string; sales: string; orders: number }>;
}

export interface ProductRow {
  id: number;
  product_type: number;
  image: string;
  store_name: string;
  price: string;
  stock: number;
  sales: number;
  is_show: number;
  is_verify: number;
  add_time: number;
}

export interface VirtualInventorySku {
  unique: string;
  suk: string;
  stock: number;
  sum_stock: number;
  sales: number;
  disk_info_configured: boolean;
  total_cards: number;
  available_cards: number;
  assigned_cards: number;
  unassigned_minus_sellable: number;
}

export interface VirtualInventoryCard {
  id: number;
  attr_unique: string;
  card_no_masked: string;
  password_configured: boolean;
  status: "available" | "assigned";
}

export interface VirtualInventoryView {
  product: { id: number; store_name: string; owner_type: number; owner_id: number };
  summary: { total_cards: number; available_cards: number; assigned_cards: number };
  skus: VirtualInventorySku[];
  selected_attr_unique: string;
  list: VirtualInventoryCard[];
  next_cursor: number | null;
}

export interface VirtualInventoryImportResult {
  inserted: number;
  skipped_existing: number;
  skipped_request_duplicates: number;
  total_cards: number;
  available_cards: number;
  assigned_cards: number;
  sku_stock: number;
  product_stock: number;
}

export interface VirtualInventoryExportTicket {
  ticket: string;
  expires_at: number;
  available_count: number;
  product: { id: number; store_name: string };
  attr_unique: string;
}

export interface VirtualInventoryExportResult {
  export_id: number;
  exported_at: number;
  reason: string;
  requested_count: number;
  exported_count: number;
  product: { id: number; store_name: string };
  attr_unique: string;
  scope: "available";
  cards: Array<{ card_no: string; card_pwd: string }>;
}

export interface VirtualInventoryAlertRow {
  sku_id: number;
  product_id: number;
  store_name: string;
  owner_type: number;
  owner_id: number;
  attr_unique: string;
  suk: string;
  sellable_stock: number;
  total_cards: number;
  available_cards: number;
  assigned_cards: number;
  buffer: number;
  risk_level: "shortage" | "low_buffer";
}

export interface VirtualInventoryAlertView {
  threshold: number;
  level: "all" | "shortage" | "low_buffer";
  summary: {
    products_scanned: number;
    skus_scanned: number;
    alert_products: number;
    alert_skus: number;
    shortage_skus: number;
    low_buffer_skus: number;
  };
  list: VirtualInventoryAlertRow[];
  next_cursor: number | null;
}

export interface ProductCategory {
  id: number;
  pid: number;
  cate_name: string;
  path: string;
  level: number;
  pic: string;
  sort: number;
  is_show: number;
  add_time: number;
  children: ProductCategory[];
}

export interface ProductDimension {
  value: string;
  detail: string[];
}

export interface ProductRuleTemplate {
  id: number;
  type: number;
  relation_id: number;
  rule_name: string;
  rule_value: string | null;
  attr_name: string;
  attr_value: string[];
  spec: ProductDimension[];
}

export interface ProductRulePayload {
  rule_name: string;
  spec: ProductDimension[];
}

export interface ProductSku {
  id?: number;
  unique?: string;
  suk: string;
  detail: Record<string, string>;
  image: string;
  price: string;
  settle_price: string;
  cost: string;
  ot_price: string;
  vip_price: string;
  stock: number;
  sales?: number;
  sumStock?: number;
  is_retired?: 0 | 1;
  bar_code: string;
  weight: string;
  volume: string;
  brokerage: string;
  brokerage_two: string;
  code: string;
  disk_info?: string;
  delivery_mode?: "card" | "fixed";
  original_disk_info?: string;
}

export interface ProductDetail {
  id: number;
  product_type: 0 | 1;
  store_name: string;
  store_info: string;
  keyword: string;
  unit_name: string;
  bar_code: string;
  cate_id: number[];
  slider_image: string[];
  description: string;
  spec_type: 0 | 1;
  items: ProductDimension[];
  attrs: ProductSku[];
  retired_attrs?: ProductSku[];
  freight: 1 | 2 | 3;
  postage: string;
  temp_id: number;
  is_postage: number;
  is_support_refund: number;
  is_limit: number;
  limit_type: number;
  limit_num: number;
  sort: number;
  ficti: number;
  video_link: string;
  is_show?: number;
  is_verify?: number;
  refusal?: string;
}

export interface ShippingTemplateRow {
  id: number;
  name: string;
  type: string;
  appoint: string;
  sort: number;
  add_time: string;
}

export interface ShippingTemplateListResult {
  data: ShippingTemplateRow[];
  count: number;
}

export interface ShippingCityOption {
  id: number;
  city_id: number;
  level: number;
  parent_id: number;
  name: string;
  is_show: number;
  children?: ShippingCityOption[];
}

export interface ShippingRegionRule {
  id?: number;
  city_ids: number[][];
  first: string;
  first_price: string;
  continue: string;
  continue_price: string;
}

export interface ShippingFreeRule {
  id?: number;
  city_ids: number[][];
  number: string;
  price: string;
}

export interface ShippingNoDeliveryRule {
  id?: number;
  city_ids: number[][];
}

export interface ShippingTemplateDetail {
  formData: {
    name: string;
    type: 1 | 2 | 3;
    appoint_check: 0 | 1;
    no_delivery_check: 0 | 1;
    sort: number;
  };
  templateList: ShippingRegionRule[];
  appointList: ShippingFreeRule[];
  noDeliveryList: ShippingNoDeliveryRule[];
}

export interface ShippingTemplatePayload {
  name: string;
  type: 1 | 2 | 3;
  appoint: 0 | 1;
  no_delivery: 0 | 1;
  sort: number;
  region_info: ShippingRegionRule[];
  appoint_info: ShippingFreeRule[];
  no_delivery_info: ShippingNoDeliveryRule[];
}

export interface ProductSaveResult {
  id: number;
  is_verify: number;
  is_show: number;
}

export interface ProductBatchResult {
  updated: number;
  skipped: number[];
  skipped_count: number;
}

export interface SupplierProductReviewReply {
  id: number;
  content: string;
  add_time: string;
  update_time: string;
}

export interface SupplierProductReview {
  id: number;
  product_id: number;
  store_name: string;
  image: string;
  nickname: string;
  account: string;
  comment: string;
  sku: string;
  product_score: number;
  service_score: number;
  delivery_score: number;
  score: number;
  pics: string[];
  is_reply: 0 | 1;
  add_time: string;
  replyComment: SupplierProductReviewReply | null;
}

export interface OrderRow {
  id: number;
  pid?: number;
  order_id: string;
  real_name: string;
  user_phone: string;
  total_num: number;
  pay_price: string;
  paid: number;
  status: number;
  pay_type: string;
  refund_status: number;
  shipping_type: number;
  delivery_type: string;
  delivery_name: string;
  delivery_code: string;
  delivery_id: string;
  fictitious_content: string;
  remark: string;
  add_time: number;
  pay_time: number;
}

export interface PickingSheetItem {
  index: number;
  product_name: string;
  sku: string;
  unit_price: string;
  quantity: number;
  subtotal: string;
}

export interface PickingSheetOrder {
  id: number;
  order_id: string;
  real_name: string;
  user_phone: string;
  user_address: string;
  pay_time: number;
  pay_type: string;
  freight_price: string;
  coupon_price: string;
  vip_true_price: string;
  deduction_price: string;
  use_integral: string;
  pay_price: string;
  mark: string;
  supplier_remark: string;
  items: PickingSheetItem[];
}

export interface PickingSheetResult {
  supplier: { name: string; phone: string; address: string };
  list: PickingSheetOrder[];
}

export interface SplitCartItem {
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

export interface SplitOrder {
  id: number;
  pid: number;
  order_id: string;
  total_num: number;
  pay_price: string;
  paid: number;
  status: number;
  refund_status: number;
  delivery_type: string;
  delivery_name: string;
  delivery_code: string;
  delivery_id: string;
  fictitious_content: string;
  cart_info: SplitCartItem[];
}

export interface SplitDeliveryResult {
  split: boolean;
  order_id: number;
  remaining_order_id: number | null;
}

export interface ExpressCompany {
  id: number;
  code: string;
  name: string;
}

export interface OrderStatusLog {
  id: number;
  oid: number;
  changeType: string;
  changeMessage: string;
  changeTime: number;
}

export type LegacyExportCell = string | number;

export interface LegacyExportManifest {
  header: string[];
  filekey: string[];
  export: Array<Record<string, LegacyExportCell | undefined>>;
  filename: string;
  page?: number;
  limit?: number;
  has_more?: boolean;
  bounded: true;
}

export interface SupplierQueueHistoryRow {
  id: number;
  type: 7 | 8 | 9 | 10;
  title: string;
  status: 0 | 1 | 2 | 3;
  status_cn: string;
  first_time: string;
  again_time: string;
  finish_time: string;
  add_time: string;
  total_num: number;
  success_num: number;
  surplus_num: number;
  cache_type: 3 | 4 | 5 | 6;
  is_show_log: boolean;
  actions_available: string[];
}

export interface SupplierQueueDeliveryLogRow {
  id: number;
  binding_id: number;
  relation_id: number;
  type: 3 | 4 | 5 | 6;
  order_id: string;
  delivery_name: string;
  delivery_id: string;
  fictitious_content: string;
  status: 0 | 1 | 2 | 3;
  status_cn: string;
  error: string;
  update_time: string;
  add_time: string;
}

export interface SupplierQueueHistoryResult<T> {
  list: T[];
  count: number;
  history_authority: "legacy_history_only";
  runtime_authority: "supplier_scoped_job_ledgers";
  read_only: true;
  mutation_routes_retired: true;
}

export interface RefundRow {
  id: number;
  refund_order_id: string;
  store_order_id: number;
  order_id: string;
  real_name: string;
  user_phone: string;
  apply_type: number;
  apply_price: string;
  refund_type: number;
  refund_num: number;
  refund_price: string;
  refunded_price: string;
  refund_reason: string;
  refuse_reason: string;
  remark: string;
  add_time: number;
  refunded_time: number;
  pay_type: string;
  pay_price: string;
  refund_provider?: string | null;
  provider_status?: string | null;
  provider_refund_id?: string | null;
  out_refund_no?: string | null;
  provider_error?: string | null;
  provider_update_time?: number;
}

export interface RefundExecutionResult {
  completed: boolean;
  status: string;
}

export interface RefundDetail extends RefundRow {
  cartInfo: unknown;
  orderInfo: unknown;
}

export interface FinanceInfo {
  bank_code: string;
  bank_address: string;
  alipay_account: string;
  alipay_qrcode_url: string;
  wechat: string;
  wechat_qrcode_url: string;
}

export interface FinanceSummary {
  available: string;
  pending_settlement: string;
  total_income: string;
  total_refund: string;
  pending_extract: string;
  paid_extract: string;
}

export interface FinanceFlow {
  id: number;
  orderId: string;
  linkId: string;
  pm: number;
  number: string;
  type: number;
  payType: string;
  status: number;
  mark: string;
  tradeTime: number;
  addTime: number;
}

export interface SupplierExtract {
  id: number;
  extractType: string;
  extractPrice: string;
  status: number;
  payStatus: number;
  supplierMark: string;
  failMsg: string;
  voucherTitle: string;
  addTime: number;
}

export interface ExtractPageResult extends PageResult<SupplierExtract> {
  extract_statistics: FinanceSummary;
}

export interface PageResult<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

export interface SupplierProfile {
  id: number;
  supplier_name: string;
  avatar: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  province: number;
  city: number;
  area: number;
  street: number;
  detailed_address: string;
  sort: number;
  is_show: number;
  mark: string;
  account: string;
}

export interface SupplierConfigField {
  key: string;
  label: string;
  input_type: "switch" | "text" | "password";
  value: string | number;
  configured: boolean;
}

export interface SupplierConfigGroup {
  key: "store_printing_deploy" | "store_electronic_sheet";
  label: string;
  fields: SupplierConfigField[];
}

export interface SupplierConfigView {
  type: string;
  title: string;
  action: string;
  method: string;
  groups: SupplierConfigGroup[];
}

export interface PrintDocumentView {
  id: number;
  type: 1 | 2;
  supplier_id: number;
  print_name: string;
  yly_user_id: string;
  yly_app_id: string;
  yly_app_secret: "";
  yly_app_secret_configured: boolean;
  yly_sn: string;
  fey_user: string;
  fey_ukey: "";
  fey_ukey_configured: boolean;
  fey_sn: string;
  times: number;
  print_type: 1 | 2;
  add_time: number;
  status: 0 | 1;
  is_del: 0 | 1;
  provider_ready: boolean;
  content_configured: boolean;
  content_valid: boolean;
  ready: boolean;
}

export interface PrintContent {
  header: number;
  delivery: number;
  buyer_remarks: number;
  goods: number[];
  freight: number;
  preferential: number;
  pay: number[];
  custom: number;
  order: number[];
  code: number;
  code_url: string;
  show_notice: number;
  notice_content: string;
}

export type PrintJobStatus =
  | "PENDING" | "ENQUEUING" | "ENQUEUED" | "PROCESSING" | "RETRYABLE"
  | "SENT" | "UNKNOWN" | "DEAD" | "CLOSED";

export interface PrintJobView {
  id: number;
  event_key: string;
  order_id: number;
  order_no: string;
  printer_id: number;
  supplier_id: number;
  trigger: "created" | "paid" | "manual";
  provider: "yilianyun" | "feieyun";
  actor_type: "system" | "admin" | "supplier";
  actor_id: number;
  status: PrintJobStatus;
  dispatch_count: number;
  attempt_count: number;
  replay_count: number;
  available_time: number;
  lease_until: number;
  provider_reference: string;
  provider_request_id: string;
  response_code: string;
  content_hash: string;
  last_error: string;
  sent_time: number;
  add_time: number;
  update_time: number;
}

export interface PrintJobSummary {
  pending: number;
  sent: number;
  unknown: number;
  dead: number;
  closed: number;
}

export interface PrintJobListResult {
  list: PrintJobView[];
  next_cursor: number | null;
  summary: PrintJobSummary;
}

export type WaybillJobStatus =
  | "PENDING" | "ENQUEUING" | "ENQUEUED" | "PROCESSING" | "RETRYABLE"
  | "SENT" | "UNKNOWN" | "DEAD" | "CLOSED";

export interface WaybillJobView {
  id: number;
  event_key: string;
  order_id: number;
  order_no: string;
  root_order_id: number;
  supplier_id: number;
  actor_type: "admin" | "supplier";
  actor_id: number;
  fulfillment_mode: "whole" | "split";
  carrier_id: number;
  carrier_code: string;
  carrier_name: string;
  template_id: string;
  has_cloud_printer: boolean;
  status: WaybillJobStatus;
  dispatch_count: number;
  attempt_count: number;
  replay_count: number;
  available_time: number;
  lease_until: number;
  provider_reference: string;
  response_code: string;
  tracking_number: string;
  label_url: string;
  payload_hash: string;
  fulfilled_order_id: number;
  remaining_order_id: number | null;
  last_error: string;
  sent_time: number;
  add_time: number;
  update_time: number;
}

export interface WaybillJobSummary {
  pending: number;
  sent: number;
  unknown: number;
  dead: number;
  closed: number;
}

export interface WaybillJobListResult {
  list: WaybillJobView[];
  next_cursor: number | null;
  summary: WaybillJobSummary;
}
