/** Pure money projection shared by H5/Mini Program, independent of request/auth runtime. */
export function estimateWithdrawal(input: { extract_type: string; extract_price: string }, config: { withdraw_fee: string } | null) {
  if (!config || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(input.extract_price)) return null;
  const [whole, decimal = ""] = input.extract_price.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  const rateText = String(config.withdraw_fee);
  if (!/^\d{1,3}(?:\.\d{1,6})?$/.test(rateText)) return null;
  const [rateWhole, rateDecimal = ""] = rateText.split(".");
  const rate = Number(rateWhole) * 100 + Number(rateDecimal.padEnd(2, "0").slice(0, 2));
  if (!Number.isSafeInteger(rate) || rate < 0 || rate >= 10_000) return null;
  // Keep intermediate integer products within Number's safe range on Mini Program engines.
  const fee = input.extract_type === "balance" ? 0 : Math.floor(cents / 10_000) * rate + Math.floor((cents % 10_000) * rate / 10_000);
  return { gross: cents / 100, fee: (fee / 100).toFixed(2), net: ((cents - fee) / 100).toFixed(2) };
}

export function newWithdrawalKey() {
  return `withdrawal-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

/** A single unresolved, user-scoped intent survives reloads; removed after a definitive outcome. */
export const withdrawalStorageKey = (uid: number) => `finance_withdrawal_pending_${uid}`;
