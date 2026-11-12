import { ValidateException } from "@/utils/errors";

export type ManualOrderDeliveryType = "express" | "send" | "fictitious" | "city_delivery";

const PHYSICAL_PRODUCT_TYPE = 0;
const CARD_PRODUCT_TYPE = 1;
const MANUAL_VIRTUAL_PRODUCT_TYPE = 3;

/** Historical type 2 uses generic coupon rewards and manual virtual delivery. */
export function isManualVirtualProductType(type: number): boolean {
  return type === MANUAL_VIRTUAL_PRODUCT_TYPE || type === 2;
}
const SECOND_CARD_PRODUCT_TYPE = 4;

/** PHP treats product types 1/2/3 as non-logistics checkout products. */
export function assertProductCheckoutShippingType(productType: number, shippingType: number): void {
  if (productType === SECOND_CARD_PRODUCT_TYPE && shippingType !== 2) {
    throw new ValidateException("次卡商品只能选择门店自提并到店核销");
  }
  if ([CARD_PRODUCT_TYPE, 2, MANUAL_VIRTUAL_PRODUCT_TYPE].includes(productType) && shippingType === 2) {
    throw new ValidateException("虚拟商品无需到店自提");
  }
}

/**
 * Bind an operator-selected delivery channel to the immutable product type.
 * Card products are delivered by the payment outbox, while second-card orders
 * are completed through write-off. Historical types 2 and 3 use manual virtual content.
 */
export function assertManualOrderDeliveryType(
  productType: number,
  deliveryType: ManualOrderDeliveryType,
): void {
  if (isManualVirtualProductType(productType)) {
    if (deliveryType !== "fictitious") {
      throw new ValidateException("手工虚拟商品只能使用虚拟交付");
    }
    return;
  }
  if (productType === PHYSICAL_PRODUCT_TYPE) {
    if (deliveryType === "fictitious") {
      throw new ValidateException("实物商品不能使用虚拟交付");
    }
    return;
  }
  if (productType === CARD_PRODUCT_TYPE) {
    throw new ValidateException("卡密商品由支付任务自动交付，不能手工发货");
  }
  if (productType === SECOND_CARD_PRODUCT_TYPE) {
    throw new ValidateException("次卡商品必须使用到店核销，不能手工发货");
  }
  throw new ValidateException("当前商品履约类型不支持手工发货");
}
