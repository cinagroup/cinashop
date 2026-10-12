import type { SystemFormInfo } from './systemForm';
export interface CustomerCashierCatalogProduct { id: number; store_name: string; image: string; product_type: 4; system_form_id: number }
export interface CustomerCashierCatalogRow extends CustomerCashierCatalogProduct { sku_count: number }
export interface CustomerCashierReadiness { writes: boolean; reason: string }
export interface CustomerCashierCatalogList { list: CustomerCashierCatalogRow[]; page: number; limit: number; has_more: boolean; readiness: CustomerCashierReadiness }
export interface CustomerCashierCatalogSku { sku_unique: string; sku: string; image: string; price: string; stock: number; write_times: number; write_valid: 1 | 2 | 3; write_days: number; write_start: number; write_end: number }
export interface CustomerCashierCatalogDetail { product: CustomerCashierCatalogProduct; skus: CustomerCashierCatalogSku[]; system_form: SystemFormInfo | null; readiness: CustomerCashierReadiness }
export interface CustomerCashierCatalogEnvelope<T> { version: 'customer-cashier-catalog-v1'; actor_uid: number; principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' }; scope_key: string; consistency_key: string; data: T }
