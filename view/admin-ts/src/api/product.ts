/**
 * Admin 商品管理 API
 * 对应后端 /adminapi/product/* (已实现的 CRUD)
 */
import request, { getData } from "@/utils/request";
import type { AdminProduct } from "@/types/admin";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface ProductEditorOption {
  id: number;
  name: string;
}

export interface ProductEditorParameter extends ProductEditorOption {
  value: string;
  sort: number;
  status: number;
}

export interface ProductEditorParameterTemplate extends ProductEditorOption {
  specs: ProductEditorParameter[];
}

export interface ProductSkuDimension {
  value: string;
  detail: string[];
}

export interface ProductSkuRuleTemplate extends ProductEditorOption {
  dimensions: ProductSkuDimension[];
}

export interface ProductSkuRow {
  id?: number;
  unique?: string;
  suk: string;
  detail: Record<string, string>;
  image: string;
  price: string | number;
  settle_price: string | number;
  cost: string | number;
  ot_price: string | number;
  vip_price: string | number;
  stock: number;
  sales?: number;
  sumStock?: number;
  bar_code: string;
  weight: string | number;
  volume: string | number;
  brokerage: string | number;
  brokerage_two: string | number;
  code: string;
  is_retired?: 0 | 1;
}

export interface ProductEditorOptions {
  categories: ProductEditorOption[];
  brands: ProductEditorOption[];
  product_labels: ProductEditorOption[];
  user_labels: ProductEditorOption[];
  gift_coupons: ProductEditorOption[];
  system_forms: ProductEditorOption[];
  shipping_templates: ProductEditorOption[];
  ensures: ProductEditorOption[];
  parameter_templates: ProductEditorParameterTemplate[];
  sku_rule_templates: ProductSkuRuleTemplate[];
}

export interface AdminProductEditor extends AdminProduct {
  cate_id: number[];
  brand_id: number[];
  store_label_id: number[];
  ensure_id: number[];
  specs_id: number;
  specs: ProductEditorParameter[];
  spec_type: 0 | 1;
  items: ProductSkuDimension[];
  attrs: ProductSkuRow[];
  retired_attrs: ProductSkuRow[];
}

const previewEditorOptions: ProductEditorOptions = {
  categories: [
    { id: 11, name: "家居生活" },
    { id: 12, name: "服饰配件" },
  ],
  brands: [
    { id: 21, name: "CINA SELECT" },
    { id: 22, name: "清风制造" },
  ],
  product_labels: [
    { id: 31, name: "新品" },
    { id: 32, name: "平台推荐" },
  ],
  user_labels: [
    { id: 71, name: "高复购客户" },
    { id: 72, name: "家居偏好" },
  ],
  gift_coupons: [
    { id: 81, name: "下单赠送 10 元券" },
    { id: 82, name: "会员 95 折券" },
  ],
  system_forms: [
    { id: 91, name: "服装尺码信息" },
    { id: 92, name: "礼品寄语" },
  ],
  shipping_templates: [
    { id: 101, name: "全国按件模板" },
    { id: 102, name: "偏远地区模板" },
  ],
  ensures: [
    { id: 41, name: "七天无理由" },
    { id: 42, name: "正品保障" },
  ],
  parameter_templates: [{
    id: 51,
    name: "服装基础参数",
    specs: [
      { id: 511, name: "材质", value: "棉", sort: 30, status: 1 },
      { id: 512, name: "适用季节", value: "四季", sort: 20, status: 1 },
    ],
  }],
  sku_rule_templates: [{
    id: 61,
    name: "服装颜色尺码",
    dimensions: [
      { value: "颜色", detail: ["米白", "藏青"] },
      { value: "尺码", detail: ["S", "M"] },
    ],
  }],
};

const previewProducts: AdminProduct[] = [
  { id: 8, product_type: 0, type: 0, relation_id: 0, store_name: "轻盈通勤衬衫", store_info: "舒适基础款", image: "https://placehold.co/120x120/png?text=Shirt", price: "199.00", ot_price: "239.00", stock: 120, sales: 36, is_show: 1, is_verify: 1, is_del: 0, cate_id: [12], keyword: "通勤,衬衫", unit_name: "件" },
  { id: 7, product_type: 0, type: 0, relation_id: 0, store_name: "亚麻收纳篮", store_info: "家居收纳", image: "https://placehold.co/120x120/png?text=Basket", price: "89.00", ot_price: "109.00", stock: 48, sales: 21, is_show: 1, is_verify: 1, is_del: 0, cate_id: [11], keyword: "收纳", unit_name: "个" },
  { id: 6, product_type: 0, type: 0, relation_id: 0, store_name: "轻量保温杯", store_info: "随行饮水", image: "https://placehold.co/120x120/png?text=Cup", price: "129.00", ot_price: "159.00", stock: 75, sales: 18, is_show: 0, is_verify: 1, is_del: 0, cate_id: [11], keyword: "水杯", unit_name: "只" },
];

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

/** 商品列表 (GET /adminapi/product/list) */
export function apiAdminProductList(params: {
  page?: number;
  limit?: number;
  store_name?: string;
  status?: number;
}): Promise<{ list: AdminProduct[]; page: number; limit: number }> {
  if (previewMode) {
    const page = Number(params.page ?? 1);
    const limit = Number(params.limit ?? 10);
    const keyword = String(params.store_name ?? "").trim().toLowerCase();
    const rows = previewProducts.filter((row) => (
      row.is_del === 0
      && (!keyword || row.store_name.toLowerCase().includes(keyword))
      && (params.status === undefined || row.is_show === Number(params.status))
    ));
    return Promise.resolve({ list: rows.slice((page - 1) * limit, page * limit), page, limit });
  }
  return getData(request.get("/product/list", { params }));
}

/** 商品详情 (GET /adminapi/product/detail/:id) */
export function apiAdminProductDetail(id: number): Promise<AdminProductEditor> {
  if (previewMode) {
    return Promise.resolve({
      id,
      product_type: 0,
      type: 0,
      relation_id: 0,
      store_name: "轻盈通勤衬衫",
      store_info: "适合日常通勤的舒适基础款",
      image: "https://placehold.co/600x600/png?text=Product",
      price: "199.00",
      ot_price: "239.00",
      stock: 120,
      sales: 36,
      is_show: 1,
      is_verify: 1,
      is_del: 0,
      cate_id: [12],
      keyword: "通勤,衬衫",
      unit_name: "件",
      sort: 20,
      is_vip: 1,
      vip_price: "179.00",
      brand_id: [21],
      store_label_id: [31, 32],
      ensure_id: [41, 42],
      specs_id: 51,
      specs: structuredClone(previewEditorOptions.parameter_templates[0].specs),
      spec_type: 1,
      items: structuredClone(previewEditorOptions.sku_rule_templates[0].dimensions),
      attrs: [
        ["米白", "S"], ["米白", "M"], ["藏青", "S"], ["藏青", "M"],
      ].map((parts, index) => ({
        id: 801 + index,
        unique: `pvsku00${index + 1}`,
        suk: parts.join(","),
        detail: { 颜色: parts[0], 尺码: parts[1] },
        image: "",
        price: 199 + index * 10,
        settle_price: 0,
        cost: 80,
        ot_price: 239,
        vip_price: 179,
        stock: 30,
        sales: index * 3,
        sumStock: 30 + index * 3,
        bar_code: `CINA-${index + 1}`,
        weight: 0.3,
        volume: 0,
        brokerage: 0,
        brokerage_two: 0,
        code: `SHIRT-${index + 1}`,
        is_retired: 0,
      })),
      retired_attrs: ["S", "M"].map((size, index) => ({
        id: 901 + index,
        unique: `pvret00${index + 1}`,
        suk: `沙色,${size}`,
        detail: { 颜色: "沙色", 尺码: size },
        image: "",
        price: 199,
        settle_price: 0,
        cost: 80,
        ot_price: 239,
        vip_price: 179,
        stock: 0,
        sales: 8 + index,
        sumStock: 0,
        bar_code: `CINA-RET-${index + 1}`,
        weight: 0.3,
        volume: 0,
        brokerage: 0,
        brokerage_two: 0,
        code: `SHIRT-RET-${index + 1}`,
        is_retired: 1,
      })),
    });
  }
  return getData(request.get(`/product/detail/${id}`));
}

/** 商品表单需要的品牌、标签、保障和参数模板候选。 */
export function apiAdminProductEditorOptions(): Promise<ProductEditorOptions> {
  if (previewMode) return Promise.resolve(structuredClone(previewEditorOptions));
  return getData(request.get("/product/editor/options"));
}

/** 创建商品 (POST /adminapi/product/add) */
export function apiAdminProductCreate(
  data: Record<string, unknown>,
): Promise<{ id: number; associations_verified: boolean; sku_verified: boolean }> {
  if (previewMode) return Promise.resolve({ id: 901, associations_verified: true, sku_verified: true });
  return getData(request.post("/product/add", data));
}

/** 编辑商品 (POST /adminapi/product/edit/:id) */
export function apiAdminProductUpdate(
  id: number,
  data: Record<string, unknown>,
): Promise<{ id: number; associations_verified: boolean; sku_verified: boolean }> {
  if (previewMode) return Promise.resolve({ id, associations_verified: true, sku_verified: true });
  return getData(request.post(`/product/edit/${id}`, data));
}

export interface ProductSkuRetirementResult {
  changed: number;
  verified: boolean;
  dependencies: Record<string, number>;
}

export function apiAdminProductSkuRetire(
  productId: number,
  skuIds: number[],
  reason: string,
): Promise<ProductSkuRetirementResult> {
  if (previewMode) return Promise.resolve({ changed: skuIds.length, verified: true, dependencies: {} });
  return getData(request.post("/product/sku/retire", {
    product_id: productId,
    sku_ids: skuIds,
    reason,
  }));
}

export function apiAdminProductSkuRestore(
  productId: number,
  skuIds: number[],
  reason: string,
): Promise<ProductSkuRetirementResult> {
  if (previewMode) return Promise.resolve({ changed: skuIds.length, verified: true, dependencies: {} });
  return getData(request.post("/product/sku/restore", {
    product_id: productId,
    sku_ids: skuIds,
    reason,
  }));
}

/** 上下架 (POST /adminapi/product/set_show/:id) */
export function apiAdminProductSetShow(id: number, isShow: number): Promise<null> {
  if (previewMode) {
    const row = previewProducts.find((item) => item.id === id);
    if (row) row.is_show = isShow;
    return Promise.resolve(null);
  }
  return getData(request.post(`/product/set_show/${id}`, { is_show: isShow }));
}

export interface ProductBatchResult {
  changed: number;
  relations?: number;
  verified: boolean;
}

export type ProductBatchOperationType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** 批量上下架，最多100个商品，同一事务回读。 */
export function apiAdminProductBatchSetShow(ids: number[], isShow: 0 | 1): Promise<ProductBatchResult> {
  if (previewMode) {
    for (const row of previewProducts) if (ids.includes(row.id)) row.is_show = isShow;
    return Promise.resolve({ changed: ids.length, verified: true });
  }
  return getData(request.post("/product/set_show", { ids, is_show: isShow }));
}

/** 受控批量运营：显式商品集合、确定性替换、整批事务回读。 */
export function apiAdminProductBatchOperation(
  type: ProductBatchOperationType,
  ids: number[],
  data: Record<string, unknown>,
): Promise<ProductBatchResult> {
  if (previewMode) return Promise.resolve({ changed: ids.length, verified: true });
  return getData(request.post("/product/batch_process", { type, ids, data }));
}

/** 批量替换分类或商品标签，type=1分类、type=2商品标签。 */
export function apiAdminProductBatchRelations(
  type: 1 | 2,
  ids: number[],
  relationIds: number[],
): Promise<ProductBatchResult> {
  if (previewMode) {
    if (type === 1) {
      for (const row of previewProducts) if (ids.includes(row.id)) row.cate_id = [...relationIds];
    }
    return Promise.resolve({ changed: ids.length, relations: relationIds.length, verified: true });
  }
  return apiAdminProductBatchOperation(
    type,
    ids,
    type === 1 ? { cate_id: relationIds } : { store_label_id: relationIds },
  );
}

/** 删除商品 (DELETE /adminapi/product/del/:id) */
export function apiAdminProductDel(id: number): Promise<null> {
  if (previewMode) {
    const row = previewProducts.find((item) => item.id === id);
    if (row) row.is_del = 1;
    return Promise.resolve(null);
  }
  return getData(request.delete(`/product/del/${id}`));
}

export function apiAdminProductDraft(): Promise<{ info: Record<string, unknown> | [] }> {
  return getData(request.get("/product/cache"));
}

export function apiAdminProductDraftSave(
  data: Record<string, unknown>,
): Promise<{ info: Record<string, unknown> }> {
  return getData(request.post("/product/cache", data));
}

export function apiAdminProductDraftDelete(): Promise<null> {
  return getData(request.delete("/product/cache"));
}

export function apiAdminVirtualInventory(
  id: number,
  params: { attr_unique?: string; status?: string; cursor?: number; limit?: number },
): Promise<VirtualInventoryView> {
  return getData(request.get(`/product/virtual/${id}`, { params }));
}

export function apiAdminVirtualInventoryAlerts(params: {
  threshold?: number;
  level?: "all" | "shortage" | "low_buffer";
  cursor?: number;
  limit?: number;
}): Promise<VirtualInventoryAlertView> {
  return getData(request.get("/product/virtual-alerts", { params }));
}

export function apiAdminVirtualInventoryImport(
  id: number,
  data: { attr_unique: string; cards: Array<{ card_no: string; card_pwd: string }> },
): Promise<VirtualInventoryImportResult> {
  return getData(request.post(`/product/virtual/${id}/import`, data));
}

export function apiAdminVirtualInventoryCreateExportTicket(
  id: number,
  data: { attr_unique: string; reason: string; confirm: "EXPORT_AVAILABLE_VIRTUAL_CARDS" },
): Promise<VirtualInventoryExportTicket> {
  return getData(request.post(`/product/virtual/${id}/export-ticket`, data));
}

export function apiAdminVirtualInventoryConsumeExportTicket(
  id: number,
  ticket: string,
): Promise<VirtualInventoryExportResult> {
  return getData(request.post(`/product/virtual/${id}/export`, { ticket }));
}
