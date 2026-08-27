/**
 * Admin 商品管理 API
 * 对应后端 /adminapi/product/* (已实现的 CRUD)
 */
import request, { getData } from "@/utils/request";
import type { AdminProduct } from "@/types/admin";

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
  return getData(request.get("/product/list", { params }));
}

/** 商品详情 (GET /adminapi/product/detail/:id) */
export function apiAdminProductDetail(id: number): Promise<AdminProduct> {
  return getData(request.get(`/product/detail/${id}`));
}

/** 创建商品 (POST /adminapi/product/create) */
export function apiAdminProductCreate(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post("/product/create", data));
}

/** 编辑商品 (POST /adminapi/product/update/:id) */
export function apiAdminProductUpdate(
  id: number,
  data: Record<string, unknown>,
): Promise<null> {
  return getData(request.post(`/product/update/${id}`, data));
}

/** 上下架 (POST /adminapi/product/set_show/:id) */
export function apiAdminProductSetShow(id: number, isShow: number): Promise<null> {
  return getData(request.post(`/product/set_show/${id}`, { is_show: isShow }));
}

/** 删除商品 (DELETE /adminapi/product/del/:id) */
export function apiAdminProductDel(id: number): Promise<null> {
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
