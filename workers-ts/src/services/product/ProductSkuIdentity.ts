/**
 * All writers that allocate store_product_attr_value.unique must share this
 * transaction lock. The legacy schema only indexes the column, so a global
 * collision check is not race-free unless every allocator serializes here.
 */
export const PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE = 731_602;
export const PRODUCT_SKU_IDENTITY_LOCK_KEY = 0;
