import { apiRequest } from "./http";
import type {
  DashboardStats,
  ExpressCompany,
  ExtractPageResult,
  FinanceFlow,
  FinanceInfo,
  FinanceSummary,
  LoginResult,
  OrderRow,
  OrderStatusLog,
  PickingSheetResult,
  SplitCartItem,
  SplitDeliveryResult,
  SplitOrder,
  PageResult,
  ProductRow,
  ProductBatchResult,
  ProductCategory,
  ProductDetail,
  ProductRulePayload,
  ProductRuleTemplate,
  ProductSaveResult,
  VirtualInventoryImportResult,
  VirtualInventoryExportResult,
  VirtualInventoryExportTicket,
  VirtualInventoryAlertView,
  VirtualInventoryView,
  RefundDetail,
  RefundExecutionResult,
  RefundRow,
  SupplierProfile,
  SupplierConfigView,
  PrintContent,
  PrintDocumentView,
  PrintJobListResult,
  WaybillJobListResult,
  ShippingCityOption,
  ShippingTemplateDetail,
  ShippingTemplateListResult,
  ShippingTemplatePayload,
  SupplierAdministrator,
  SupplierAdminFormDefinition,
  SupplierAdminPayload,
  SupplierRole,
  SupplierRoleListResult,
  SupplierRolePayload,
  SupplierProductReview,
  LegacyExportManifest,
  SupplierQueueDeliveryLogRow,
  SupplierQueueHistoryResult,
  SupplierQueueHistoryRow,
} from "@/types";

export const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewProducts: ProductRow[] = [
  { id: 71, product_type: 0, image: "", store_name: "简约便携保温杯 500ml", price: "89.00", stock: 28, sales: 216, is_show: 1, is_verify: 1, add_time: 1786200000 },
  { id: 72, product_type: 0, image: "", store_name: "无线蓝牙耳机 Pro", price: "329.00", stock: 18, sales: 148, is_show: 1, is_verify: 1, add_time: 1786190000 },
  { id: 73, product_type: 0, image: "", store_name: "智能手环 6 代", price: "269.00", stock: 15, sales: 97, is_show: 0, is_verify: 1, add_time: 1786180000 },
  { id: 74, product_type: 0, image: "", store_name: "快充移动电源 10000mAh", price: "159.00", stock: 35, sales: 302, is_show: 1, is_verify: 0, add_time: 1786170000 },
];

let previewProductRuleSequence = 903;
const previewProductRules: ProductRuleTemplate[] = [
  {
    id: 901,
    type: 2,
    relation_id: 1001,
    rule_name: "服装颜色尺码",
    rule_value: null,
    attr_name: "颜色,尺码",
    attr_value: ["黑色,白色", "S,M,L"],
    spec: [
      { value: "颜色", detail: ["黑色", "白色"] },
      { value: "尺码", detail: ["S", "M", "L"] },
    ],
  },
  {
    id: 902,
    type: 2,
    relation_id: 1001,
    rule_name: "杯壶容量",
    rule_value: null,
    attr_name: "颜色,容量",
    attr_value: ["曜石黑,象牙白", "350ml,500ml"],
    spec: [
      { value: "颜色", detail: ["曜石黑", "象牙白"] },
      { value: "容量", detail: ["350ml", "500ml"] },
    ],
  },
];

function cloneProductRule(row: ProductRuleTemplate): ProductRuleTemplate {
  return {
    ...row,
    attr_value: [...row.attr_value],
    spec: row.spec.map((dimension) => ({ value: dimension.value, detail: [...dimension.detail] })),
  };
}

const previewCategories: ProductCategory[] = [
  {
    id: 11,
    pid: 0,
    cate_name: "生活家居",
    path: "",
    level: 0,
    pic: "",
    sort: 100,
    is_show: 1,
    add_time: 1786100000,
    children: [
      { id: 12, pid: 11, cate_name: "杯壶", path: "11", level: 1, pic: "", sort: 90, is_show: 1, add_time: 1786100100, children: [] },
    ],
  },
  { id: 21, pid: 0, cate_name: "数码配件", path: "", level: 0, pic: "", sort: 80, is_show: 1, add_time: 1786100200, children: [] },
];

const previewProductDetails = new Map<number, ProductDetail>([
  [
    71,
    {
      id: 71,
      product_type: 0,
      store_name: "简约便携保温杯 500ml",
      store_info: "食品级不锈钢内胆，轻量随行",
      keyword: "保温杯,随行杯",
      unit_name: "个",
      bar_code: "",
      cate_id: [12],
      slider_image: ["https://images.unsplash.com/photo-1602143407151-7111542de6e8?auto=format&fit=crop&w=800&q=80"],
      description: "双层真空保温结构，适合通勤和日常使用。",
      spec_type: 1,
      items: [{ value: "颜色", detail: ["青绿", "云白"] }],
      attrs: [
        { id: 7101, unique: "PV71GRN1", suk: "青绿", detail: { 颜色: "青绿" }, image: "", price: "89.00", settle_price: "62.00", cost: "48.00", ot_price: "109.00", vip_price: "85.00", stock: 18, sales: 126, bar_code: "", weight: "0.35", volume: "0.00", brokerage: "2.00", brokerage_two: "1.00", code: "CUP-GREEN", is_retired: 0 },
        { id: 7102, unique: "PV71WHT1", suk: "云白", detail: { 颜色: "云白" }, image: "", price: "89.00", settle_price: "62.00", cost: "48.00", ot_price: "109.00", vip_price: "85.00", stock: 10, sales: 90, bar_code: "", weight: "0.35", volume: "0.00", brokerage: "2.00", brokerage_two: "1.00", code: "CUP-WHITE", is_retired: 0 },
      ],
      freight: 1,
      postage: "0.00",
      temp_id: 0,
      is_postage: 1,
      is_support_refund: 1,
      is_limit: 0,
      limit_type: 0,
      limit_num: 0,
      sort: 100,
      ficti: 188,
      video_link: "",
      is_show: 1,
      is_verify: 1,
      refusal: "",
    },
  ],
]);

function clonePreviewDetail(detail: ProductDetail): ProductDetail {
  return JSON.parse(JSON.stringify(detail)) as ProductDetail;
}

function defaultPreviewDetail(id: number): ProductDetail {
  const row = previewProducts.find((item) => item.id === id) ?? previewProducts[0];
  return {
    id: row.id,
    product_type: row.product_type === 1 ? 1 : 0,
    store_name: row.store_name,
    store_info: "",
    keyword: "",
    unit_name: "件",
    bar_code: "",
    cate_id: [21],
    slider_image: ["https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80"],
    description: "预览商品详情",
    spec_type: 0,
    items: [{ value: "规格", detail: ["默认"] }],
    attrs: [{ id: id * 100 + 1, unique: `PV${id}SKU`, suk: "默认", detail: { 规格: "默认" }, image: "", price: row.price, settle_price: row.price, cost: "0.00", ot_price: row.price, vip_price: row.price, stock: row.stock, sales: row.sales, bar_code: "", weight: "0.00", volume: "0.00", brokerage: "0.00", brokerage_two: "0.00", code: "", disk_info: "", is_retired: 0 }],
    freight: 1,
    postage: "0.00",
    temp_id: 0,
    is_postage: 1,
    is_support_refund: 1,
    is_limit: 0,
    limit_type: 0,
    limit_num: 0,
    sort: 0,
    ficti: 0,
    video_link: "",
    is_show: row.is_show,
    is_verify: row.is_verify,
    refusal: "",
  };
}

const previewOrders: OrderRow[] = [
  { id: 501, order_id: "CS2026080900123", real_name: "杭州星辰科技有限公司", user_phone: "138****1024", total_num: 4, pay_price: "3680.00", paid: 1, status: 0, pay_type: "alipay", refund_status: 0, shipping_type: 1, delivery_type: "", delivery_name: "", delivery_code: "", delivery_id: "", fictitious_content: "", remark: "", add_time: 1786250600, pay_time: 1786250610 },
  { id: 502, order_id: "CS2026080900117", real_name: "上海锐联贸易有限公司", user_phone: "136****8821", total_num: 8, pay_price: "6250.30", paid: 1, status: 1, pay_type: "weixin", refund_status: 0, shipping_type: 1, delivery_type: "express", delivery_name: "顺丰速运", delivery_code: "SF", delivery_id: "SF1839204857", fictitious_content: "", remark: "优先发货", add_time: 1786249900, pay_time: 1786249950 },
  { id: 503, order_id: "CS2026080900098", real_name: "广州优品商贸有限公司", user_phone: "159****3006", total_num: 2, pay_price: "1280.00", paid: 1, status: 2, pay_type: "alipay", refund_status: 0, shipping_type: 1, delivery_type: "express", delivery_name: "中通快递", delivery_code: "ZTO", delivery_id: "ZT18274630", fictitious_content: "", remark: "", add_time: 1786248200, pay_time: 1786248260 },
  { id: 504, order_id: "CS2026080900086", real_name: "深圳创想电子有限公司", user_phone: "137****7612", total_num: 5, pay_price: "2950.50", paid: 0, status: 0, pay_type: "weixin", refund_status: 0, shipping_type: 1, delivery_type: "", delivery_name: "", delivery_code: "", delivery_id: "", fictitious_content: "", remark: "", add_time: 1786247000, pay_time: 0 },
  { id: 505, order_id: "CS2026080900071", real_name: "北京宏图商贸有限公司", user_phone: "135****4418", total_num: 6, pay_price: "5430.00", paid: 1, status: 0, pay_type: "weixin", refund_status: 1, shipping_type: 1, delivery_type: "", delivery_name: "", delivery_code: "", delivery_id: "", fictitious_content: "", remark: "", add_time: 1786245200, pay_time: 1786245300 },
];

const previewOrderCarts = new Map<number, SplitCartItem[]>([
  [
    501,
    [
      { id: 1501, cart_id: "CART501A", product_id: 71, sku_unique: "PV71GRN1", cart_num: 2, refund_num: 0, surplus_num: 2, product_name: "简约便携保温杯 500ml", image: "", sku: "青绿", cart_info: null },
      { id: 1502, cart_id: "CART501B", product_id: 72, sku_unique: "PV72PRO1", cart_num: 2, refund_num: 0, surplus_num: 2, product_name: "无线蓝牙耳机 Pro", image: "", sku: "曜石黑", cart_info: null },
    ],
  ],
]);

const previewRefunds: RefundRow[] = [
  { id: 801, refund_order_id: "R202608090001", store_order_id: 501, order_id: "CS2026080900123", real_name: "杭州星辰科技有限公司", user_phone: "138****1024", apply_type: 1, apply_price: "680.00", refund_type: 0, refund_num: 1, refund_price: "680.00", refunded_price: "0.00", refund_reason: "商品与描述不符", refuse_reason: "", remark: "", add_time: 1786251400, refunded_time: 0, pay_type: "yue", pay_price: "3680.00" },
  { id: 802, refund_order_id: "R202608090002", store_order_id: 505, order_id: "CS2026080900071", real_name: "北京宏图商贸有限公司", user_phone: "135****4418", apply_type: 2, apply_price: "1280.00", refund_type: 0, refund_num: 2, refund_price: "1280.00", refunded_price: "0.00", refund_reason: "质量问题", refuse_reason: "", remark: "等待仓库确认", add_time: 1786251000, refunded_time: 0, pay_type: "weixin", pay_price: "5430.00" },
];

const previewFinanceInfo: FinanceInfo = {
  bank_code: "6222 **** **** 3188",
  bank_address: "招商银行深圳科技园支行",
  alipay_account: "finance@example.com",
  alipay_qrcode_url: "",
  wechat: "supplier-finance",
  wechat_qrcode_url: "",
};

const previewFinanceSummary: FinanceSummary = {
  available: "128640.50",
  pending_settlement: "38620.80",
  total_income: "526840.80",
  total_refund: "12680.00",
  pending_extract: "10000.00",
  paid_extract: "375520.30",
};

const previewShippingTemplates: ShippingTemplateDetail[] = [
  {
    formData: { name: "全国标准运费", type: 1, appoint_check: 1, no_delivery_check: 0, sort: 100 },
    templateList: [{ id: 101, city_ids: [[0]], first: "1.00", first_price: "8.00", continue: "1.00", continue_price: "2.00" }],
    appointList: [{ id: 102, city_ids: [[44, 4401]], number: "3.00", price: "99.00" }],
    noDeliveryList: [],
  },
  {
    formData: { name: "大件按重量", type: 2, appoint_check: 0, no_delivery_check: 1, sort: 80 },
    templateList: [{ id: 201, city_ids: [[0]], first: "1.00", first_price: "12.00", continue: "1.00", continue_price: "4.00" }],
    appointList: [],
    noDeliveryList: [{ id: 202, city_ids: [[65, 6501]] }],
  },
];

const previewShippingCities: ShippingCityOption[] = [
  { id: 1, city_id: 44, level: 1, parent_id: 0, name: "广东省", is_show: 1, children: [
    { id: 2, city_id: 4401, level: 2, parent_id: 44, name: "广州市", is_show: 1 },
    { id: 3, city_id: 4403, level: 2, parent_id: 44, name: "深圳市", is_show: 1 },
  ] },
  { id: 4, city_id: 65, level: 1, parent_id: 0, name: "新疆维吾尔自治区", is_show: 1, children: [
    { id: 5, city_id: 6501, level: 2, parent_id: 65, name: "乌鲁木齐市", is_show: 1 },
  ] },
];

const previewSupplierConfig: SupplierConfigView = {
  type: "third",
  title: "供应商履约配置",
  action: "/supplierapi/config",
  method: "POST",
  groups: [
    {
      key: "store_printing_deploy",
      label: "小票打印",
      fields: [
        { key: "store_pay_success_printing_switch", label: "支付成功后自动打印", input_type: "switch", value: 1, configured: true },
        { key: "store_printing_timing", label: "打印时机", input_type: "text", value: "pay", configured: true },
        { key: "store_terminal_number", label: "终端编号", input_type: "text", value: "SUPPLIER-01", configured: true },
        { key: "store_printing_client_id", label: "打印平台 Client ID", input_type: "text", value: "", configured: false },
        { key: "store_printing_api_key", label: "打印平台 API Key", input_type: "password", value: "", configured: true },
        { key: "store_develop_id", label: "开发者 ID", input_type: "text", value: "", configured: false },
        { key: "store_print_type", label: "打印机类型", input_type: "text", value: "feie", configured: true },
        { key: "store_fey_user", label: "飞鹅云账号", input_type: "text", value: "", configured: false },
        { key: "store_fey_ukey", label: "飞鹅云 UKEY", input_type: "password", value: "", configured: false },
        { key: "store_fey_sn", label: "飞鹅云打印机 SN", input_type: "text", value: "", configured: false },
      ],
    },
    {
      key: "store_electronic_sheet",
      label: "电子面单",
      fields: [
        { key: "store_config_export_open", label: "启用电子面单", input_type: "switch", value: 1, configured: true },
        { key: "store_config_export_id", label: "默认快递公司 ID", input_type: "text", value: "1", configured: true },
        { key: "store_config_export_temp_id", label: "电子面单模板 ID", input_type: "text", value: "SF-STD-01", configured: true },
        { key: "store_config_export_to_name", label: "发件人", input_type: "text", value: "CinaShop 仓配中心", configured: true },
        { key: "store_config_export_to_tel", label: "发件电话", input_type: "text", value: "13800138000", configured: true },
        { key: "store_config_export_to_address", label: "发件地址", input_type: "text", value: "深圳市南山区科技园南区 8 号", configured: true },
        { key: "store_config_export_siid", label: "月结账号", input_type: "text", value: "", configured: false },
      ],
    },
  ],
};

const defaultPrintContent: PrintContent = {
  header: 1,
  delivery: 1,
  buyer_remarks: 1,
  goods: [0],
  freight: 1,
  preferential: 1,
  pay: [0, 1],
  custom: 0,
  order: [0, 1, 2, 3],
  code: 0,
  code_url: "",
  show_notice: 1,
  notice_content: "感谢您的惠顾，请核对商品数量",
};

const previewPrintContents = new Map<number, PrintContent>([[31, { ...defaultPrintContent }]]);
const previewPrintDocuments: PrintDocumentView[] = [
  {
    id: 31,
    type: 1,
    supplier_id: 1,
    print_name: "仓库一号打印机",
    yly_user_id: "1000821",
    yly_app_id: "cina-supplier-preview",
    yly_app_secret: "",
    yly_app_secret_configured: true,
    yly_sn: "K4-CINA-001",
    fey_user: "",
    fey_ukey: "",
    fey_ukey_configured: false,
    fey_sn: "",
    times: 1,
    print_type: 1,
    add_time: 1786250000,
    status: 1,
    is_del: 0,
    provider_ready: true,
    content_configured: true,
    content_valid: true,
    ready: true,
  },
];

const previewFinanceFlows: FinanceFlow[] = [
  { id: 901, orderId: "PCS2026080900123", linkId: "CS2026080900123", pm: 1, number: "3250.00", type: 1, payType: "alipay", status: 1, mark: "", tradeTime: 1786250610, addTime: 1786250610 },
  { id: 902, orderId: "R801-CS2026080900123", linkId: "CS2026080900123", pm: 0, number: "601.50", type: 2, payType: "yue", status: 1, mark: "售后退款", tradeTime: 1786251600, addTime: 1786251600 },
];

const previewSupplierAdmins: SupplierAdministrator[] = [
  {
    id: 21,
    account: "warehouse.demo",
    real_name: "仓库主管",
    phone: "138****2021",
    head_pic: "",
    roles: [301],
    role_names: ["仓库履约"],
    status: 1,
    level: 1,
    add_time: 1786200000,
    last_time: 1786250000,
    login_count: 18,
    _add_time: "2026-08-08 12:00:00",
    _last_time: "2026-08-09 01:13:20",
  },
];

const previewSupplierRoles: SupplierRole[] = [
  { id: 301, role_name: "仓库履约", rules: ["supplier.order.view", "supplier.order.manage", "supplier.print.view", "supplier.print.manage", "supplier.waybill.view", "supplier.waybill.manage"], level: 1, status: 1 },
  { id: 302, role_name: "商品运营", rules: ["supplier.product.view", "supplier.product.manage", "supplier.shipping.view"], level: 1, status: 1 },
  { id: 303, role_name: "财务查看", rules: ["supplier.finance.view"], level: 1, status: 1 },
];

const previewSupplierPermissionTree = [
  ["dashboard", "经营概览", false], ["product", "商品管理", true], ["shipping", "运费模板", true],
  ["order", "订单管理", true], ["refund", "售后管理", true], ["finance", "财务结算", true],
  ["print", "小票打印", true], ["waybill", "电子面单", true], ["config", "履约配置", true],
  ["profile", "供应商资料", true], ["admin", "子账号管理", true], ["attachment", "素材中心", true],
].map(([key, label, manage]) => ({
  key: String(key),
  label: String(label),
  children: [
    { key: `supplier.${key}.view`, label: "查看" },
    ...(manage ? [{ key: `supplier.${key}.manage`, label: "管理" }] : []),
  ],
}));

function previewSupplierRoleOptions() {
  return previewSupplierRoles
    .filter((role) => role.status === 1)
    .map((role) => ({ value: role.id, label: role.role_name }));
}

export async function login(account: string, pwd: string) {
  return apiRequest<LoginResult>({ method: "POST", url: "/login", data: { account, pwd } });
}

export async function logout() {
  if (previewMode) return null;
  return apiRequest<null>({ method: "GET", url: "/logout" });
}

export async function getDashboard(): Promise<DashboardStats> {
  if (previewMode) {
    return {
      today_sales: "86420.50",
      yesterday_sales: "79720.30",
      month_sales: "526840.80",
      today_orders: 126,
      yesterday_orders: 114,
      month_orders: 916,
      pending_delivery: 68,
      product_count: 1256,
      refund_count: 15,
      trend: [
        { date: "08-03", sales: "62400.00", orders: 146 },
        { date: "08-04", sales: "54800.00", orders: 128 },
        { date: "08-05", sales: "67600.00", orders: 162 },
        { date: "08-06", sales: "81200.00", orders: 198 },
        { date: "08-07", sales: "55900.00", orders: 136 },
        { date: "08-08", sales: "74200.00", orders: 164 },
        { date: "08-09", sales: "86420.50", orders: 126 },
      ],
    };
  }
  return apiRequest<DashboardStats>({ method: "GET", url: "/home/dashboard" });
}

export async function getProducts(params: Record<string, string | number>): Promise<PageResult<ProductRow>> {
  if (previewMode) return { list: previewProducts, count: previewProducts.length, page: 1, limit: 20 };
  return apiRequest<PageResult<ProductRow>>({ method: "GET", url: "/product/product/list", params });
}

export async function getProductRuleTemplates(): Promise<ProductRuleTemplate[]> {
  if (previewMode) return previewProductRules.map(cloneProductRule);
  return apiRequest<ProductRuleTemplate[]>({ method: "GET", url: "/product/product/get_rule" });
}

export async function getProductRules(
  params: Record<string, string | number> = {},
): Promise<PageResult<ProductRuleTemplate>> {
  if (previewMode) {
    const keyword = String(params.rule_name ?? "").trim().toLowerCase();
    const page = Math.max(1, Number(params.page ?? 1));
    const limit = Math.max(1, Math.min(100, Number(params.limit ?? 20)));
    const filtered = previewProductRules.filter((row) => !keyword || row.rule_name.toLowerCase().includes(keyword));
    return {
      list: filtered.slice((page - 1) * limit, page * limit).map(cloneProductRule),
      count: filtered.length,
      page,
      limit,
    };
  }
  return apiRequest<PageResult<ProductRuleTemplate>>({
    method: "GET",
    url: "/product/product/rule",
    params,
  });
}

export async function getProductRule(id: number): Promise<ProductRuleTemplate> {
  if (previewMode) {
    const row = previewProductRules.find((item) => item.id === id);
    if (!row) throw new Error("规格模板不存在");
    return cloneProductRule(row);
  }
  const result = await apiRequest<{ info: ProductRuleTemplate }>({
    method: "GET",
    url: `/product/product/rule/${id}`,
  });
  return result.info;
}

export async function saveProductRule(id: number, payload: ProductRulePayload) {
  if (previewMode) {
    const savedId = id || previewProductRuleSequence++;
    const row: ProductRuleTemplate = {
      id: savedId,
      type: 2,
      relation_id: 1001,
      rule_name: payload.rule_name,
      rule_value: JSON.stringify(payload.spec),
      attr_name: payload.spec.map((item) => item.value).join(","),
      attr_value: payload.spec.map((item) => item.detail.join(",")),
      spec: payload.spec.map((item) => ({ value: item.value, detail: [...item.detail] })),
    };
    const index = previewProductRules.findIndex((item) => item.id === savedId);
    if (index >= 0) previewProductRules[index] = row;
    else previewProductRules.unshift(row);
    return { id: savedId };
  }
  return apiRequest<{ id: number }>({
    method: "POST",
    url: `/product/product/rule/${id}`,
    data: payload,
  });
}

export async function deleteProductRule(id: number) {
  if (previewMode) {
    const index = previewProductRules.findIndex((item) => item.id === id);
    if (index >= 0) previewProductRules.splice(index, 1);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/product/product/rule/delete/${id}` });
}

export async function getShippingTemplates(
  params: Record<string, string | number> = {},
): Promise<ShippingTemplateListResult> {
  if (previewMode) {
    const data = previewShippingTemplates.map((item, index) => ({
      id: index + 1,
      name: item.formData.name,
      type: item.formData.type === 1 ? "按件数" : item.formData.type === 2 ? "按重量" : "按体积",
      appoint: item.formData.appoint_check ? "开启" : "关闭",
      sort: item.formData.sort,
      add_time: "2026-09-02 09:00:00",
    }));
    return { data, count: data.length };
  }
  return apiRequest<ShippingTemplateListResult>({
    method: "GET",
    url: "/setting/shipping_templates/list",
    params,
  });
}

export async function getShippingTemplate(id: number): Promise<ShippingTemplateDetail> {
  if (previewMode) {
    const detail = previewShippingTemplates[id - 1];
    if (!detail) throw new Error("运费模板不存在");
    return JSON.parse(JSON.stringify(detail)) as ShippingTemplateDetail;
  }
  return apiRequest<ShippingTemplateDetail>({
    method: "GET",
    url: `/setting/shipping_templates/${id}/edit`,
  });
}

export async function saveShippingTemplate(id: number, data: ShippingTemplatePayload) {
  if (previewMode) {
    const detail: ShippingTemplateDetail = {
      formData: {
        name: data.name,
        type: data.type,
        appoint_check: data.appoint,
        no_delivery_check: data.no_delivery,
        sort: data.sort,
      },
      templateList: data.region_info,
      appointList: data.appoint_info,
      noDeliveryList: data.no_delivery_info,
    };
    const savedId = id || previewShippingTemplates.length + 1;
    previewShippingTemplates[savedId - 1] = detail;
    return { id: savedId };
  }
  return apiRequest<{ id: number }>({
    method: "POST",
    url: `/setting/shipping_templates/save/${id}`,
    data,
  });
}

export async function deleteShippingTemplate(id: number) {
  if (previewMode) {
    previewShippingTemplates.splice(id - 1, 1);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/setting/shipping_templates/del/${id}` });
}

export async function getShippingCities(): Promise<ShippingCityOption[]> {
  if (previewMode) return JSON.parse(JSON.stringify(previewShippingCities)) as ShippingCityOption[];
  return apiRequest<ShippingCityOption[]>({
    method: "GET",
    url: "/setting/shipping_templates/city_list",
  });
}

export async function setProductShow(id: number, isShow: number) {
  if (previewMode) {
    const row = previewProducts.find((item) => item.id === id);
    if (row) row.is_show = isShow;
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/product/product/set_show/${id}/${isShow}` });
}

export async function getProductCategories(): Promise<ProductCategory[]> {
  if (previewMode) return JSON.parse(JSON.stringify(previewCategories)) as ProductCategory[];
  return apiRequest<ProductCategory[]>({ method: "GET", url: "/product/category" });
}

export async function saveProductCategory(id: number, data: Record<string, unknown>) {
  if (previewMode) {
    const newId = id || Math.max(...previewCategories.flatMap((item) => [item.id, ...item.children.map((child) => child.id)])) + 1;
    if (!id) previewCategories.push({ id: newId, pid: Number(data.pid ?? 0), cate_name: String(data.cate_name ?? "新分类"), path: "", level: 0, pic: String(data.pic ?? ""), sort: Number(data.sort ?? 0), is_show: Number(data.is_show ?? 1), add_time: Math.floor(Date.now() / 1000), children: [] });
    return { id: newId };
  }
  return apiRequest<{ id: number }>({ method: id ? "PUT" : "POST", url: id ? `/product/category/${id}` : "/product/category", data });
}

export async function deleteProductCategory(id: number) {
  if (previewMode) {
    const index = previewCategories.findIndex((item) => item.id === id);
    if (index >= 0) previewCategories.splice(index, 1);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/product/category/${id}` });
}

export async function getProductDetail(id: number): Promise<ProductDetail> {
  if (previewMode) return clonePreviewDetail(previewProductDetails.get(id) ?? defaultPreviewDetail(id));
  return apiRequest<ProductDetail>({ method: "GET", url: `/product/product/${id}` });
}

export async function saveProduct(id: number, data: ProductDetail): Promise<ProductSaveResult> {
  if (previewMode) {
    const savedId = id || Math.max(...previewProducts.map((item) => item.id)) + 1;
    const saved = clonePreviewDetail({ ...data, id: savedId, is_show: 0, is_verify: 0 });
    previewProductDetails.set(savedId, saved);
    const stock = data.attrs.reduce((sum, item) => sum + Number(item.stock), 0);
    const price = data.attrs.reduce((minimum, item) => Math.min(minimum, Number(item.price)), Number.POSITIVE_INFINITY).toFixed(2);
    const row = previewProducts.find((item) => item.id === savedId);
    if (row) Object.assign(row, { product_type: data.product_type, store_name: data.store_name, image: data.slider_image[0], price, stock, is_show: 0, is_verify: 0 });
    else previewProducts.unshift({ id: savedId, product_type: data.product_type, image: data.slider_image[0], store_name: data.store_name, price, stock, sales: 0, is_show: 0, is_verify: 0, add_time: Math.floor(Date.now() / 1000) });
    return { id: savedId, is_show: 0, is_verify: 0 };
  }
  return apiRequest<ProductSaveResult>({ method: "POST", url: id ? `/product/product/${id}` : "/product/product", data });
}

export interface ProductSkuRetirementResult {
  changed: number;
  verified: boolean;
  dependencies: Record<string, number>;
}

async function changePreviewProductSkus(
  action: "retire" | "restore",
  productId: number,
  skuIds: number[],
): Promise<ProductSkuRetirementResult> {
  const detail = previewProductDetails.get(productId) ?? defaultPreviewDetail(productId);
  const source = action === "retire" ? detail.attrs : detail.retired_attrs ?? [];
  const destination = action === "retire" ? detail.retired_attrs ?? [] : detail.attrs;
  const selected = source.filter((sku) => sku.id && skuIds.includes(sku.id));
  if (selected.length !== skuIds.length) throw new Error("SKU状态已变化，请刷新后重试");
  const selectedIds = new Set(skuIds);
  const remaining = source.filter((sku) => !sku.id || !selectedIds.has(sku.id));
  const moved = selected.map((sku) => ({ ...sku, is_retired: action === "retire" ? 1 : 0 } as const));
  if (action === "retire") {
    if (!remaining.length) throw new Error("商品必须保留至少一个可售SKU");
    detail.attrs = remaining;
    detail.retired_attrs = [...destination, ...moved];
  } else {
    detail.retired_attrs = remaining;
    detail.attrs = [...destination, ...moved];
  }
  previewProductDetails.set(productId, detail);
  return { changed: skuIds.length, verified: true, dependencies: {} };
}

export function retireProductSkus(
  productId: number,
  skuIds: number[],
  reason: string,
): Promise<ProductSkuRetirementResult> {
  if (previewMode) return changePreviewProductSkus("retire", productId, skuIds);
  return apiRequest<ProductSkuRetirementResult>({
    method: "POST",
    url: "/product/product/sku/retire",
    data: { product_id: productId, sku_ids: skuIds, reason },
  });
}

export function restoreProductSkus(
  productId: number,
  skuIds: number[],
  reason: string,
): Promise<ProductSkuRetirementResult> {
  if (previewMode) return changePreviewProductSkus("restore", productId, skuIds);
  return apiRequest<ProductSkuRetirementResult>({
    method: "POST",
    url: "/product/product/sku/restore",
    data: { product_id: productId, sku_ids: skuIds, reason },
  });
}

export async function recycleProduct(id: number) {
  if (previewMode) {
    const index = previewProducts.findIndex((item) => item.id === id);
    if (index >= 0) previewProducts.splice(index, 1);
    previewProductDetails.delete(id);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/product/product/${id}` });
}

export async function batchSetProductShow(ids: number[], isShow: number): Promise<ProductBatchResult> {
  if (previewMode) {
    let updated = 0;
    const skipped: number[] = [];
    for (const id of ids) {
      const row = previewProducts.find((item) => item.id === id);
      if (!row || (isShow === 1 && row.is_verify !== 1)) skipped.push(id);
      else { row.is_show = isShow; updated += 1; }
    }
    return { updated, skipped, skipped_count: skipped.length };
  }
  return apiRequest<ProductBatchResult>({ method: "PUT", url: `/product/product/batch_show/${isShow}`, data: { ids, is_show: isShow } });
}

export async function adjustProductStock(id: number, attrs: Array<{ unique: string; pm: number; stock: number }>) {
  if (previewMode) {
    const detail = previewProductDetails.get(id) ?? defaultPreviewDetail(id);
    for (const [index, adjustment] of attrs.entries()) {
      const sku =
        detail.attrs.find((item) => item.unique === adjustment.unique) ??
        detail.attrs[index];
      if (sku) sku.stock += adjustment.pm === 1 ? adjustment.stock : -adjustment.stock;
    }
    previewProductDetails.set(id, detail);
    const stock = detail.attrs.reduce((sum, item) => sum + item.stock, 0);
    const row = previewProducts.find((item) => item.id === id);
    if (row) row.stock = stock;
    return { stock };
  }
  return apiRequest<{ stock: number }>({ method: "PUT", url: `/product/product/saveStocks/${id}`, data: { attrs } });
}

export async function getVirtualInventory(
  id: number,
  params: { attr_unique?: string; status?: string; cursor?: number; limit?: number },
): Promise<VirtualInventoryView> {
  if (previewMode) {
    const allCards: VirtualInventoryView["list"] = [
      { id: 302, attr_unique: "GIFT0001", card_no_masked: "•••••••••0002", password_configured: true, status: "available" },
      { id: 301, attr_unique: "GIFT0001", card_no_masked: "•••••••••0001", password_configured: true, status: "assigned" },
    ];
    const status = params.status ?? "all";
    const list = allCards.filter((card) => status === "all" || card.status === status);
    return {
      product: { id, store_name: "企业礼品兑换码", owner_type: 2, owner_id: 12 },
      summary: { total_cards: 3, available_cards: 2, assigned_cards: 1 },
      skus: [{ unique: "GIFT0001", suk: "100 元面值", stock: 2, sum_stock: 3, sales: 1, disk_info_configured: false, total_cards: 3, available_cards: 2, assigned_cards: 1, unassigned_minus_sellable: 0 }],
      selected_attr_unique: "GIFT0001",
      list: list.slice(0, params.limit ?? 30),
      next_cursor: null,
    };
  }
  return apiRequest<VirtualInventoryView>({ method: "GET", url: `/product/product/virtual/${id}`, params });
}

export async function getVirtualInventoryAlerts(params: {
  threshold?: number;
  level?: "all" | "shortage" | "low_buffer";
  cursor?: number;
  limit?: number;
}): Promise<VirtualInventoryAlertView> {
  if (previewMode) {
    const allRows: VirtualInventoryAlertView["list"] = [
      { sku_id: 901, product_id: 81, store_name: "企业礼品兑换码", owner_type: 2, owner_id: 12, attr_unique: "GIFT0001", suk: "100 元面值", sellable_stock: 24, total_cards: 22, available_cards: 18, assigned_cards: 4, buffer: -6, risk_level: "shortage" },
      { sku_id: 902, product_id: 82, store_name: "在线课程激活码", owner_type: 2, owner_id: 12, attr_unique: "COUR0001", suk: "年度会员", sellable_stock: 12, total_cards: 17, available_cards: 14, assigned_cards: 3, buffer: 2, risk_level: "low_buffer" },
      { sku_id: 903, product_id: 83, store_name: "软件授权序列号", owner_type: 2, owner_id: 12, attr_unique: "SOFT0001", suk: "专业版", sellable_stock: 8, total_cards: 12, available_cards: 10, assigned_cards: 2, buffer: 2, risk_level: "low_buffer" },
    ];
    const threshold = params.threshold ?? 5;
    const level = params.level ?? "all";
    const list = allRows.filter((item) => (level === "all" || item.risk_level === level) && item.sku_id > (params.cursor ?? 0));
    return {
      threshold,
      level,
      summary: { products_scanned: 5, skus_scanned: 7, alert_products: 3, alert_skus: 3, shortage_skus: 1, low_buffer_skus: 2 },
      list: list.slice(0, params.limit ?? 30),
      next_cursor: null,
    };
  }
  return apiRequest<VirtualInventoryAlertView>({ method: "GET", url: "/product/product/virtual-alerts", params });
}

export async function importVirtualInventory(
  id: number,
  data: { attr_unique: string; cards: Array<{ card_no: string; card_pwd: string }> },
): Promise<VirtualInventoryImportResult> {
  return apiRequest<VirtualInventoryImportResult>({
    method: "POST",
    url: `/product/product/virtual/${id}/import`,
    data,
  });
}

export async function createVirtualInventoryExportTicket(
  id: number,
  data: { attr_unique: string; reason: string; confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS" },
): Promise<VirtualInventoryExportTicket> {
  return apiRequest<VirtualInventoryExportTicket>({
    method: "POST",
    url: `/product/product/virtual/${id}/export-ticket`,
    data,
  });
}

export async function consumeVirtualInventoryExportTicket(
  id: number,
  ticket: string,
): Promise<VirtualInventoryExportResult> {
  return apiRequest<VirtualInventoryExportResult>({
    method: "POST",
    url: `/product/product/virtual/${id}/export`,
    data: { ticket },
  });
}

export async function getOrders(params: Record<string, string | number>): Promise<PageResult<OrderRow>> {
  if (previewMode) return { list: previewOrders.map((item) => ({ ...item })), count: previewOrders.length, page: 1, limit: 20 };
  return apiRequest<PageResult<OrderRow>>({ method: "GET", url: "/order/list", params });
}

const previewProductReviews: SupplierProductReview[] = [
  {
    id: 601,
    product_id: 71,
    store_name: "简约便携保温杯 500ml",
    image: "",
    nickname: "企业采购用户",
    account: "企业采购用户",
    comment: "保温效果不错，批量包装也很整齐。",
    sku: "曜石黑 / 500ml",
    product_score: 5,
    service_score: 5,
    delivery_score: 4,
    score: 4,
    pics: [],
    is_reply: 0,
    add_time: "2026-08-09 13:18:00",
    replyComment: null,
  },
  {
    id: 602,
    product_id: 72,
    store_name: "无线蓝牙耳机 Pro",
    image: "",
    nickname: "华东渠道客户",
    account: "华东渠道客户",
    comment: "到货及时，连接稳定。",
    sku: "银色",
    product_score: 5,
    service_score: 5,
    delivery_score: 5,
    score: 5,
    pics: [],
    is_reply: 1,
    add_time: "2026-08-08 16:20:00",
    replyComment: { id: 701, content: "感谢认可，我们会继续做好履约。", add_time: "2026-08-08 17:00:00", update_time: "2026-08-08 17:00:00" },
  },
];

export async function getProductReviews(
  params: Record<string, string | number>,
): Promise<PageResult<SupplierProductReview>> {
  if (previewMode) {
    const isReply = String(params.is_reply ?? "");
    const productKeyword = String(params.store_name ?? "").trim().toLowerCase();
    const account = String(params.account ?? "").trim().toLowerCase();
    const list = previewProductReviews
      .filter((row) => !isReply || row.is_reply === Number(isReply))
      .filter((row) => !productKeyword || row.store_name.toLowerCase().includes(productKeyword) || String(row.product_id).includes(productKeyword))
      .filter((row) => !account || row.nickname.toLowerCase().includes(account))
      .map((row) => ({ ...row, pics: [...row.pics], replyComment: row.replyComment ? { ...row.replyComment } : null }));
    return { list, count: list.length, page: 1, limit: 15 };
  }
  return apiRequest<PageResult<SupplierProductReview>>({ method: "GET", url: "/product/reply", params });
}

export async function replyProductReview(id: number, content: string) {
  if (previewMode) {
    const row = previewProductReviews.find((item) => item.id === id);
    if (row) {
      row.is_reply = 1;
      row.replyComment = {
        id: row.replyComment?.id ?? 700 + id,
        content,
        add_time: row.replyComment?.add_time ?? "2026-08-09 14:00:00",
        update_time: "2026-08-09 14:00:00",
      };
    }
    return { id, comment_id: row?.replyComment?.id ?? 0, is_reply: 1 as const };
  }
  return apiRequest<{ id: number; comment_id: number; is_reply: 1 }>({
    method: "PUT",
    url: `/product/reply/set_reply/${id}`,
    data: { content },
  });
}

function previewManifest(
  filename: string,
  header: string[],
  filekey: string[],
  rows: LegacyExportManifest["export"],
): LegacyExportManifest {
  return { header, filekey, export: rows, filename, bounded: true, has_more: false, page: 1, limit: 250 };
}

export async function exportSupplierOrders(
  params: Record<string, string | number>,
): Promise<LegacyExportManifest> {
  if (previewMode) {
    const selected = String(params.ids ?? "")
      .split(",")
      .map(Number)
      .filter((id) => Number.isSafeInteger(id));
    const list = previewOrders.filter((row) => !selected.length || selected.includes(row.id));
    return previewManifest(
      Number(params.type ?? 0) === 1 ? "供应商发货单_预览" : "供应商订单_预览",
      ["订单号", "客户", "手机号", "订单金额", "状态"],
      ["order_id", "real_name", "user_phone", "pay_price", "status"],
      list.map((row) => ({
        order_id: row.order_id,
        real_name: row.real_name,
        user_phone: row.user_phone,
        pay_price: row.pay_price,
        status: row.status,
      })),
    );
  }
  return apiRequest<LegacyExportManifest>({ method: "GET", url: "/export/storeOrder", params });
}

export async function exportSupplierExpressList(): Promise<LegacyExportManifest> {
  if (previewMode) {
    return previewManifest(
      "物流公司对照表_预览",
      ["物流公司", "编码"],
      ["name", "code"],
      [{ name: "顺丰速运", code: "SF" }, { name: "中通快递", code: "ZTO" }],
    );
  }
  return apiRequest<LegacyExportManifest>({ method: "GET", url: "/export/expressList" });
}

export async function exportSupplierBatchDelivery(
  id: number,
  queueType: number,
  cacheType: number,
): Promise<LegacyExportManifest> {
  if (previewMode) {
    return previewManifest(
      `批量发货记录_${id}`,
      ["订单号", "物流公司", "物流单号", "状态"],
      ["order_id", "delivery_name", "delivery_id", "status"],
      [{ order_id: "SUP202608080001", delivery_name: "顺丰速运", delivery_id: "SF000001", status: "成功" }],
    );
  }
  return apiRequest<LegacyExportManifest>({
    method: "GET",
    url: `/export/batchOrderDelivery/${id}/${queueType}/${cacheType}`,
  });
}

export async function exportSupplierFinance(ids: number[]): Promise<LegacyExportManifest> {
  if (previewMode) {
    const list = previewFinanceFlows.filter((row) => ids.includes(row.id));
    return previewManifest(
      "供应商资金流水_预览",
      ["交易单号", "关联订单", "金额", "备注"],
      ["order_id", "link_id", "number", "mark"],
      list.map((row) => ({ order_id: row.orderId, link_id: row.linkId, number: row.number, mark: row.mark })),
    );
  }
  return apiRequest<LegacyExportManifest>({
    method: "GET",
    url: "/export/financeRecord",
    params: { ids: ids.join(",") },
  });
}

export async function getSupplierQueueHistory(
  params: Record<string, string | number>,
): Promise<SupplierQueueHistoryResult<SupplierQueueHistoryRow>> {
  if (previewMode) {
    return {
      list: [{
        id: 8801,
        type: 7,
        title: "批量手动发货",
        status: 2,
        status_cn: "完成",
        first_time: "2026-08-08 10:00:00",
        again_time: "",
        finish_time: "2026-08-08 10:01:12",
        add_time: "2026-08-08 10:00:00",
        total_num: 12,
        success_num: 11,
        surplus_num: 1,
        cache_type: 3,
        is_show_log: true,
        actions_available: [],
      }],
      count: 1,
      history_authority: "legacy_history_only",
      runtime_authority: "supplier_scoped_job_ledgers",
      read_only: true,
      mutation_routes_retired: true,
    };
  }
  return apiRequest<SupplierQueueHistoryResult<SupplierQueueHistoryRow>>({
    method: "GET",
    url: "/queue/index",
    params,
  });
}

export async function getSupplierQueueDeliveryLog(
  id: number,
  cacheType: number,
  params: Record<string, string | number>,
): Promise<SupplierQueueHistoryResult<SupplierQueueDeliveryLogRow>> {
  if (previewMode) {
    return {
      list: [{
        id: 9901,
        binding_id: id,
        relation_id: 801,
        type: cacheType as 3 | 4 | 5 | 6,
        order_id: "SUP202608080001",
        delivery_name: "顺丰速运",
        delivery_id: "SF000001",
        fictitious_content: "",
        status: 1,
        status_cn: "成功",
        error: "无",
        update_time: "2026-08-08 10:01:12",
        add_time: "2026-08-08 10:00:02",
      }],
      count: 1,
      history_authority: "legacy_history_only",
      runtime_authority: "supplier_scoped_job_ledgers",
      read_only: true,
      mutation_routes_retired: true,
    };
  }
  return apiRequest<SupplierQueueHistoryResult<SupplierQueueDeliveryLogRow>>({
    method: "GET",
    url: `/queue/delivery/log/${id}/${cacheType}`,
    params,
  });
}

export async function getOrderDetail(id: number): Promise<OrderRow & { cart_info: unknown[] }> {
  if (previewMode) {
    const order = previewOrders.find((item) => item.id === id) ?? previewOrders[0];
    return { ...order, cart_info: previewOrderCarts.get(order.id) ?? [] };
  }
  return apiRequest<OrderRow & { cart_info: unknown[] }>({ method: "GET", url: `/order/info/${id}` });
}

export async function getPickingSheets(ids: number[]): Promise<PickingSheetResult> {
  if (previewMode) {
    const list = ids.map((id) => {
      const order = previewOrders.find((item) => item.id === id);
      if (!order) throw new Error("部分订单不存在或不属于当前供应商");
      const items = (previewOrderCarts.get(id) ?? []).map((item, index) => {
        const unitPrice = index === 0 ? 89 : 159;
        return {
          index: index + 1,
          product_name: item.product_name,
          sku: item.sku,
          unit_price: unitPrice.toFixed(2),
          quantity: item.cart_num,
          subtotal: (unitPrice * item.cart_num).toFixed(2),
        };
      });
      return {
        id: order.id,
        order_id: order.order_id,
        real_name: order.real_name,
        user_phone: order.user_phone,
        user_address: "浙江省杭州市滨江区示例路 88 号",
        pay_time: order.pay_time,
        pay_type: order.pay_type,
        freight_price: "0.00",
        coupon_price: "20.00",
        vip_true_price: "5.00",
        deduction_price: "0.00",
        use_integral: "0.00",
        pay_price: order.pay_price,
        mark: order.remark,
        supplier_remark: "",
        items,
      };
    });
    return {
      supplier: { name: "优选贸易有限公司", phone: "0571-88888888", address: "浙江省杭州市滨江区供应商园区" },
      list,
    };
  }
  return apiRequest<PickingSheetResult>({
    method: "GET",
    url: "/order/distribution_info",
    params: { ids: ids.join(",") },
  });
}

export async function getSplitCartInfo(id: number): Promise<SplitCartItem[]> {
  if (previewMode) return (previewOrderCarts.get(id) ?? []).map((item) => ({ ...item }));
  return apiRequest<SplitCartItem[]>({ method: "GET", url: `/order/split_cart_info/${id}` });
}

export async function getSplitOrders(id: number): Promise<SplitOrder[]> {
  if (previewMode) {
    const order = previewOrders.find((item) => item.id === id) ?? previewOrders[0];
    return [{
      id: order.id,
      pid: order.pid ?? 0,
      order_id: order.order_id,
      total_num: order.total_num,
      pay_price: order.pay_price,
      paid: order.paid,
      status: order.status,
      refund_status: order.refund_status,
      delivery_type: order.delivery_type,
      delivery_name: order.delivery_name,
      delivery_code: order.delivery_code,
      delivery_id: order.delivery_id,
      fictitious_content: order.fictitious_content,
      cart_info: (previewOrderCarts.get(order.id) ?? []).map((item) => ({ ...item })),
    }];
  }
  return apiRequest<SplitOrder[]>({ method: "GET", url: `/order/split_order/${id}` });
}

export async function updateOrderRemark(id: number, remark: string) {
  if (previewMode) return null;
  return apiRequest<null>({ method: "PUT", url: `/order/remark/${id}`, data: { remark } });
}

export async function getExpressList(): Promise<ExpressCompany[]> {
  if (previewMode) return [
    { id: 1, code: "SF", name: "顺丰速运" },
    { id: 2, code: "ZTO", name: "中通快递" },
    { id: 3, code: "YTO", name: "圆通速递" },
  ];
  return apiRequest<ExpressCompany[]>({ method: "GET", url: "/order/express_list" });
}

export async function deliverOrder(id: number, data: Record<string, string | number>) {
  if (previewMode) {
    const row = previewOrders.find((item) => item.id === id);
    if (row) {
      row.status = 1;
      row.delivery_type = String(data.delivery_type ?? "express");
      row.delivery_name = String(data.delivery_name ?? "");
      row.delivery_code = String(data.delivery_code ?? "");
      row.delivery_id = String(data.delivery_id ?? "");
      row.fictitious_content = String(data.fictitious_content ?? "");
    }
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/order/delivery/${id}`, data });
}

export async function splitDeliverOrder(
  id: number,
  data: Record<string, unknown>,
): Promise<SplitDeliveryResult> {
  if (previewMode) {
    const row = previewOrders.find((item) => item.id === id);
    const selected = Array.isArray(data.cart_ids) ? data.cart_ids as Array<{ cart_id: string; cart_num: number }> : [];
    if (row) {
      const shipped = selected.reduce((sum, item) => sum + Number(item.cart_num || 0), 0);
      row.pid = -1;
      row.total_num = Math.max(0, row.total_num - shipped);
    }
    return { split: true, order_id: 9501, remaining_order_id: id };
  }
  return apiRequest<SplitDeliveryResult>({ method: "PUT", url: `/order/split_delivery/${id}`, data });
}

export async function confirmOrderTake(id: number) {
  if (previewMode) {
    const row = previewOrders.find((item) => item.id === id);
    if (row) row.status = 2;
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/order/take/${id}` });
}

export async function getOrderStatus(id: number): Promise<OrderStatusLog[]> {
  if (previewMode) {
    const row = previewOrders.find((item) => item.id === id);
    return row?.status
      ? [{ id: 1, oid: id, changeType: "delivery_goods", changeMessage: `已发货：${row.delivery_name} ${row.delivery_id}`, changeTime: row.pay_time + 3600 }]
      : [];
  }
  return apiRequest<OrderStatusLog[]>({ method: "GET", url: `/order/status/${id}` });
}

export async function getRefunds(params: Record<string, string | number>): Promise<PageResult<RefundRow>> {
  if (previewMode) return { list: previewRefunds.map((item) => ({ ...item })), count: previewRefunds.length, page: 1, limit: 20 };
  return apiRequest<PageResult<RefundRow>>({ method: "GET", url: "/refund/list", params });
}

export async function getRefundReasons(): Promise<string[]> {
  if (previewMode) {
    return [...new Set(previewRefunds.map((item) => item.refund_reason).filter(Boolean))];
  }
  return apiRequest<string[]>({ method: "GET", url: "/refund/reason" });
}

export async function getRefundDetail(id: number): Promise<RefundDetail> {
  if (previewMode) {
    const refund = previewRefunds.find((item) => item.id === id) ?? previewRefunds[0];
    const order = previewOrders.find((item) => item.id === refund.store_order_id) ?? previewOrders[0];
    return { ...refund, cartInfo: null, orderInfo: order };
  }
  return apiRequest<RefundDetail>({ method: "GET", url: `/refund/detail/${id}` });
}

export async function updateRefundRemark(id: number, remark: string) {
  if (previewMode) {
    const row = previewRefunds.find((item) => item.id === id);
    if (row) row.remark = remark;
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/refund/remark/${id}`, data: { remark } });
}

export async function agreeRefundReturn(id: number) {
  if (previewMode) {
    const row = previewRefunds.find((item) => item.id === id);
    if (row) row.refund_type = 4;
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/refund/agree/${id}` });
}

export async function refuseRefund(id: number, refuseReason: string) {
  if (previewMode) {
    const row = previewRefunds.find((item) => item.id === id);
    if (row) { row.refund_type = 3; row.refuse_reason = refuseReason; }
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/refund/refuse/${id}`, data: { refuse_reason: refuseReason } });
}

export async function refundOrder(id: number, refundPrice: string) {
  if (previewMode) {
    const row = previewRefunds.find((item) => item.id === id);
    if (row?.pay_type === "yue") {
      row.refund_type = 6;
      row.refunded_price = row.refund_price;
      return { completed: true, status: "BALANCE_SUCCESS" } satisfies RefundExecutionResult;
    }
    if (row) {
      row.refund_provider = row.pay_type === "weixin" ? "wechat" : "alipay";
      row.provider_status = "PROCESSING";
      row.out_refund_no = `CNSR${row.id}`;
      row.provider_update_time = Math.floor(Date.now() / 1000);
    }
    return { completed: false, status: "PROCESSING" } satisfies RefundExecutionResult;
  }
  return apiRequest<RefundExecutionResult>({
    method: "PUT",
    url: `/refund/refund/${id}`,
    data: { type: 1, refund_price: refundPrice },
  });
}

export async function getFinanceInfo(): Promise<FinanceInfo> {
  if (previewMode) return { ...previewFinanceInfo };
  return apiRequest<FinanceInfo>({ method: "GET", url: "/finance/info" });
}

export async function updateFinanceInfo(data: FinanceInfo) {
  if (previewMode) { Object.assign(previewFinanceInfo, data); return null; }
  return apiRequest<null>({ method: "POST", url: "/finance/info", data });
}

export async function getFinanceSummary(): Promise<FinanceSummary> {
  if (previewMode) return { ...previewFinanceSummary };
  return apiRequest<FinanceSummary>({ method: "GET", url: "/finance/summary" });
}

export async function getFinanceFlows(params: Record<string, string | number>): Promise<PageResult<FinanceFlow>> {
  if (previewMode) return { list: previewFinanceFlows, count: previewFinanceFlows.length, page: 1, limit: 20 };
  return apiRequest<PageResult<FinanceFlow>>({ method: "GET", url: "/finance/supplier_flowing_water/list", params });
}

export async function getExtracts(params: Record<string, string | number>): Promise<ExtractPageResult> {
  if (previewMode) {
    return { list: [{ id: 1001, extractType: "bank", extractPrice: "10000.00", status: 0, payStatus: 0, supplierMark: "季度结算", failMsg: "", voucherTitle: "", addTime: 1786240000 }], count: 1, page: 1, limit: 20, extract_statistics: { ...previewFinanceSummary } };
  }
  return apiRequest<ExtractPageResult>({ method: "GET", url: "/finance/supplier_extract/list", params });
}

export async function applyExtract(extractType: string, money: string, mark: string) {
  if (previewMode) return null;
  return apiRequest<null>({ method: "POST", url: "/finance/supplier_extract/cash", data: { extract_type: extractType, money, mark } });
}

export async function getProfile(): Promise<SupplierProfile> {
  if (previewMode) {
    return {
      id: 1,
      supplier_name: "优选贸易有限公司",
      avatar: "",
      name: "陈经理",
      phone: "13800138000",
      email: "supplier@example.com",
      address: "广东省深圳市南山区",
      province: 44,
      city: 4403,
      area: 440305,
      street: 0,
      detailed_address: "科技园南区 8 号",
      sort: 0,
      is_show: 1,
      mark: "",
      account: "supplier-demo",
    };
  }
  return apiRequest<SupplierProfile>({ method: "GET", url: "/supplier" });
}

export async function updateProfile(profile: SupplierProfile) {
  if (previewMode) return null;
  return apiRequest<null>({ method: "PUT", url: "/supplier", data: profile });
}

export async function updatePassword(input: { pwd: string; new_pwd: string; conf_pwd: string }) {
  if (previewMode) return null;
  return apiRequest<null>({ method: "PUT", url: "/updatePwd", data: input });
}

export async function getSupplierAdministrators(
  params: Record<string, string | number> = {},
): Promise<PageResult<SupplierAdministrator>> {
  if (previewMode) {
    return { list: previewSupplierAdmins.map((item) => ({ ...item })), count: previewSupplierAdmins.length, page: 1, limit: 20 };
  }
  return apiRequest<PageResult<SupplierAdministrator>>({ method: "GET", url: "/admin", params });
}

export async function getSupplierAdministratorForm(id?: number): Promise<SupplierAdminFormDefinition> {
  if (previewMode) {
    const info = id ? previewSupplierAdmins.find((item) => item.id === id) ?? null : null;
    return {
      title: info ? "管理员修改" : "管理员添加",
      action: `/supplierapi/admin${info ? `/${info.id}` : ""}`,
      method: info ? "PUT" : "POST",
      rules: [],
      role_options: previewSupplierRoleOptions(),
      info: info ? { ...info } : null,
    };
  }
  return apiRequest<SupplierAdminFormDefinition>({
    method: "GET",
    url: id ? `/admin/${id}/edit` : "/admin/create",
  });
}

export async function saveSupplierAdministrator(id: number, data: SupplierAdminPayload) {
  if (previewMode) {
    const existing = previewSupplierAdmins.find((item) => item.id === id);
    const roleNames = previewSupplierRoles.filter((role) => data.roles.includes(role.id)).map((role) => role.role_name);
    if (existing) {
      Object.assign(existing, { ...data, role_names: roleNames });
      return { id: existing.id };
    }
    const created: SupplierAdministrator = {
      id: Math.max(20, ...previewSupplierAdmins.map((item) => item.id)) + 1,
      account: data.account,
      real_name: data.real_name,
      phone: data.phone,
      head_pic: data.head_pic,
      roles: data.roles,
      role_names: roleNames,
      status: data.status,
      level: 1,
      add_time: Math.floor(Date.now() / 1000),
      last_time: 0,
      login_count: 0,
      _add_time: "刚刚",
      _last_time: "",
    };
    previewSupplierAdmins.unshift(created);
    return { id: created.id };
  }
  return apiRequest<{ id: number }>({
    method: id ? "PUT" : "POST",
    url: id ? `/admin/${id}` : "/admin",
    data,
  });
}

export async function setSupplierAdministratorStatus(id: number, status: 0 | 1) {
  if (previewMode) {
    const row = previewSupplierAdmins.find((item) => item.id === id);
    if (row) row.status = status;
    return null;
  }
  return apiRequest<null>({ method: "PUT", url: `/admin/set_status/${id}/${status}` });
}

export async function deleteSupplierAdministrator(id: number) {
  if (previewMode) {
    const index = previewSupplierAdmins.findIndex((item) => item.id === id);
    if (index >= 0) previewSupplierAdmins.splice(index, 1);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/admin/${id}` });
}

export async function getSupplierRoles(): Promise<SupplierRoleListResult> {
  if (previewMode) {
    return {
      list: previewSupplierRoles.map((role) => ({ ...role, rules: [...role.rules] })),
      permission_tree: previewSupplierPermissionTree,
    };
  }
  return apiRequest<SupplierRoleListResult>({ method: "GET", url: "/admin/roles" });
}

export async function saveSupplierRole(id: number, data: SupplierRolePayload) {
  if (previewMode) {
    const existing = previewSupplierRoles.find((role) => role.id === id);
    if (existing) {
      Object.assign(existing, { ...data, rules: [...data.rules] });
      return { id: existing.id };
    }
    const created: SupplierRole = {
      id: Math.max(300, ...previewSupplierRoles.map((role) => role.id)) + 1,
      role_name: data.role_name,
      rules: [...data.rules],
      level: 1,
      status: data.status,
    };
    previewSupplierRoles.push(created);
    return { id: created.id };
  }
  return apiRequest<{ id: number }>({
    method: id ? "PUT" : "POST",
    url: id ? `/admin/roles/${id}` : "/admin/roles",
    data,
  });
}

export async function deleteSupplierRole(id: number) {
  if (previewMode) {
    const index = previewSupplierRoles.findIndex((role) => role.id === id);
    if (index >= 0) previewSupplierRoles.splice(index, 1);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/admin/roles/${id}` });
}

export async function getStoreConfig(type = "third"): Promise<SupplierConfigView> {
  if (previewMode) return JSON.parse(JSON.stringify(previewSupplierConfig)) as SupplierConfigView;
  return apiRequest<SupplierConfigView>({ method: "GET", url: `/config/store/${type}` });
}

export async function saveStoreConfig(
  type: SupplierConfigView["groups"][number]["key"],
  values: Record<string, string | number>,
) {
  if (previewMode) {
    const group = previewSupplierConfig.groups.find((item) => item.key === type);
    for (const field of group?.fields ?? []) {
      if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
      const value = values[field.key];
      if (field.input_type === "password" && value === "") continue;
      field.value = field.input_type === "password" ? "" : value;
      field.configured = true;
    }
    return { updated: Object.keys(values).length };
  }
  return apiRequest<{ updated: number }>({
    method: "POST",
    url: "/config",
    data: { type, values },
  });
}

function refreshPreviewPrintReadiness(document: PrintDocumentView) {
  document.provider_ready = document.times > 0 && (document.type === 1
    ? !!(document.yly_user_id && document.yly_app_id && document.yly_app_secret_configured && document.yly_sn)
    : !!(document.fey_user && document.fey_ukey_configured && document.fey_sn));
  document.content_configured = previewPrintContents.has(document.id);
  document.content_valid = true;
  document.ready = document.provider_ready && document.content_configured;
}

export async function getPrintDocuments(
  params: Record<string, string | number> = {},
): Promise<PageResult<PrintDocumentView>> {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim().toLowerCase();
    const type = Number(params.type ?? 0);
    const list = previewPrintDocuments
      .filter((item) => !keyword || item.print_name.toLowerCase().includes(keyword))
      .filter((item) => !type || item.type === type)
      .map((item) => ({ ...item }));
    return { list, count: list.length, page: 1, limit: 20 };
  }
  return apiRequest<PageResult<PrintDocumentView>>({
    method: "GET",
    url: "/print/list",
    params,
  });
}

export async function getPrintDocument(id: number): Promise<PrintDocumentView> {
  if (previewMode) {
    const existing = previewPrintDocuments.find((item) => item.id === id);
    if (existing) return { ...existing };
    return {
      id: 0,
      type: 1,
      supplier_id: 1,
      print_name: "",
      yly_user_id: "",
      yly_app_id: "",
      yly_app_secret: "",
      yly_app_secret_configured: false,
      yly_sn: "",
      fey_user: "",
      fey_ukey: "",
      fey_ukey_configured: false,
      fey_sn: "",
      times: 1,
      print_type: 1,
      add_time: 0,
      status: 0,
      is_del: 0,
      provider_ready: false,
      content_configured: false,
      content_valid: true,
      ready: false,
    };
  }
  return apiRequest<PrintDocumentView>({ method: "GET", url: `/print/form/${id}` });
}

export async function savePrintDocument(
  id: number,
  data: Record<string, string | number>,
): Promise<PrintDocumentView> {
  if (previewMode) {
    let document = previewPrintDocuments.find((item) => item.id === id);
    if (!document) {
      document = await getPrintDocument(0);
      document.id = Math.max(30, ...previewPrintDocuments.map((item) => item.id)) + 1;
      document.add_time = Math.floor(Date.now() / 1000);
      previewPrintDocuments.unshift(document);
    }
    document.print_name = String(data.print_name ?? document.print_name);
    document.type = Number(data.type ?? document.type) as 1 | 2;
    document.yly_user_id = String(data.yly_user_id ?? document.yly_user_id);
    document.yly_app_id = String(data.yly_app_id ?? document.yly_app_id);
    document.yly_sn = String(data.yly_sn ?? document.yly_sn);
    document.fey_user = String(data.fey_user ?? document.fey_user);
    document.fey_sn = String(data.fey_sn ?? document.fey_sn);
    document.times = Number(data.times ?? document.times);
    document.print_type = Number(data.print_type ?? document.print_type) as 1 | 2;
    if (String(data.yly_app_secret ?? "")) document.yly_app_secret_configured = true;
    if (String(data.fey_ukey ?? "")) document.fey_ukey_configured = true;
    refreshPreviewPrintReadiness(document);
    return { ...document };
  }
  return apiRequest<PrintDocumentView>({
    method: "POST",
    url: `/print/save/${id}`,
    data,
  });
}

export async function setPrintDocumentStatus(id: number, status: 0 | 1) {
  if (previewMode) {
    const document = previewPrintDocuments.find((item) => item.id === id);
    if (!document) throw new Error("打印机不存在");
    refreshPreviewPrintReadiness(document);
    if (status === 1 && !document.ready) throw new Error("启用前请完整配置平台凭据和打印内容");
    document.status = status;
    return { ...document };
  }
  return apiRequest<PrintDocumentView>({
    method: "PUT",
    url: `/print/set_status/${id}/${status}`,
  });
}

export async function deletePrintDocument(id: number) {
  if (previewMode) {
    const index = previewPrintDocuments.findIndex((item) => item.id === id);
    if (index >= 0) previewPrintDocuments.splice(index, 1);
    previewPrintContents.delete(id);
    return null;
  }
  return apiRequest<null>({ method: "DELETE", url: `/print/del/${id}` });
}

export async function getPrintContent(id: number): Promise<PrintContent> {
  if (previewMode) {
    return JSON.parse(JSON.stringify(previewPrintContents.get(id) ?? defaultPrintContent)) as PrintContent;
  }
  return apiRequest<PrintContent>({ method: "GET", url: `/print/content/${id}` });
}

export async function savePrintContent(id: number, content: PrintContent) {
  if (previewMode) {
    previewPrintContents.set(id, JSON.parse(JSON.stringify(content)) as PrintContent);
    const document = previewPrintDocuments.find((item) => item.id === id);
    if (document) refreshPreviewPrintReadiness(document);
    return document ? { ...document } : null;
  }
  return apiRequest<PrintDocumentView>({
    method: "POST",
    url: `/print/save_content/${id}`,
    data: content,
  });
}

export function getPrintJobs(params: Record<string, string | number> = {}): Promise<PrintJobListResult> {
  if (previewMode) {
    return Promise.resolve({
      list: [],
      next_cursor: null,
      summary: { pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 },
    });
  }
  return apiRequest<PrintJobListResult>({ method: "GET", url: "/print/jobs", params });
}

export function createManualPrintJobs(orderId: number, printerId?: number) {
  if (previewMode) return Promise.resolve({ duplicate: false, jobs: [] });
  return apiRequest<{ duplicate: boolean; jobs: Array<{ id: number; status: string }> }>({
    method: "POST",
    url: `/order/print/${orderId}`,
    data: { request_key: crypto.randomUUID(), printer_id: printerId },
  });
}

export function operatePrintJob(
  id: number,
  action: "confirm-sent" | "confirm-retry" | "close",
  reason: string,
  providerReference = "",
) {
  if (previewMode) return Promise.resolve({ duplicate: false });
  return apiRequest<{ duplicate: boolean }>({
    method: "POST",
    url: `/print/jobs/${id}/${action}`,
    data: {
      request_key: crypto.randomUUID(),
      reason,
      provider_reference: providerReference,
    },
  });
}

export function createWaybillJob(orderId: number, data: Record<string, unknown>) {
  if (previewMode) {
    return Promise.resolve({
      duplicate: false,
      job: {
        id: 901,
        event_key: `order.waybill:${String(data.request_key ?? "preview")}`,
        status: "PENDING",
      },
    });
  }
  return apiRequest<{ duplicate: boolean; job: { id: number; event_key: string; status: string } }>({
    method: "POST",
    url: `/order/waybill/${orderId}`,
    data,
  });
}

export function getWaybillJobs(
  params: Record<string, string | number> = {},
): Promise<WaybillJobListResult> {
  if (previewMode) {
    return Promise.resolve({
      list: [],
      next_cursor: null,
      summary: { pending: 1, sent: 4, unknown: 0, dead: 0, closed: 0 },
    });
  }
  return apiRequest<WaybillJobListResult>({ method: "GET", url: "/waybill/jobs", params });
}

export function operateWaybillJob(
  id: number,
  action: "apply-existing" | "confirm-issued" | "confirm-retry" | "close",
  data: Record<string, unknown>,
) {
  if (previewMode) return Promise.resolve(null);
  return apiRequest({ method: "POST", url: `/waybill/jobs/${id}/${action}`, data });
}

export function previewOrderRows() {
  return previewOrders;
}

export function previewProductRows() {
  return previewProducts;
}
