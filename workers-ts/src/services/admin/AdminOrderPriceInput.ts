import { ValidateException } from "@/utils/errors";
import { parseAdminOrderNumber } from "./AdminMobileOrderReadService";
const MAX_MONEY_CENTS = 999_999_999_999;
const MAX_CHANGE_PRICE_CENTS = 99_999_999;

function parseMoneyCents(value: unknown): number {
  let normalized = "";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new ValidateException("实际支付金额格式错误");
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-7) {
      throw new ValidateException("实际支付金额最多保留两位小数");
    }
    normalized = value.toFixed(2);
  } else if (typeof value === "string") {
    normalized = value.trim();
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new ValidateException("实际支付金额格式错误");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
    throw new ValidateException("实际支付金额超出允许范围");
  }
  return cents;
}

function parseSignedMoneyCents(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ValidateException("历史改价数据异常，请先人工核对");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  const signed = match[1] ? -cents : cents;
  if (!Number.isSafeInteger(signed) || Math.abs(signed) > MAX_CHANGE_PRICE_CENTS) {
    throw new ValidateException("历史改价数据异常，请先人工核对");
  }
  return signed;
}

function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new ValidateException("金额分值错误");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function signedCentsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CHANGE_PRICE_CENTS) {
    throw new ValidateException("改价差额超出允许范围");
  }
  return cents < 0 ? `-${centsToDecimal(-cents)}` : centsToDecimal(cents);
}

export interface AdminOrderPriceInput {
  orderId: string;
  priceCents: number;
}

export function parseAdminOrderPriceInput(input: Record<string, unknown>): AdminOrderPriceInput {
  if (input.price === undefined) throw new ValidateException("请填写实际支付金额");
  return {
    orderId: parseAdminOrderNumber(input.order_id),
    priceCents: parseMoneyCents(input.price),
  };
}

export function computeAdminOrderPrice(
  currentPayPrice: string,
  currentChangePrice: string,
  nextPriceCents: number,
) {
  const currentPayCents = parseMoneyCents(currentPayPrice);
  const originalPriceCents = currentPayCents + parseSignedMoneyCents(currentChangePrice);
  if (!Number.isSafeInteger(originalPriceCents) || originalPriceCents < 0) {
    throw new ValidateException("历史改价数据异常，请先人工核对");
  }
  const payPrice = centsToDecimal(nextPriceCents);
  const changePrice = signedCentsToDecimal(originalPriceCents - nextPriceCents);
  return {
    payPrice,
    changePrice,
    changed: payPrice !== currentPayPrice || changePrice !== currentChangePrice,
  };
}
