import { ValidateException } from "@/utils/errors";

export interface PresaleScheduleInput {
  isPresaleProduct: number;
  presaleStartTime: number;
  presaleEndTime: number;
  presaleDay: number;
}

/** PHP presale is full payment for a base product, not deposit/final-payment stages.
 * Its Unix-second start/end are inclusive; do not apply the seckill date-only rule.
 * This read model is not purchase admission. Cart/quote/create must recheck under their own locks.
 */
export function presaleSchedule(product: PresaleScheduleInput, now = new Date()) {
  const { presaleStartTime: start, presaleEndTime: end, presaleDay: days } = product;
  if (product.isPresaleProduct !== 1 || !Number.isFinite(now.getTime()) ||
    [start, end, days].some(value => !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) || end < start) {
    throw new ValidateException("预售时间或发货天数配置无效");
  }
  const clock = Math.floor(now.getTime() / 1_000);
  const status = clock < start ? 1 as const : clock <= end ? 2 as const : 3 as const;
  return { timezone: "Asia/Shanghai" as const,
    state: status === 1 ? "future" as const : status === 2 ? "active" as const : "ended" as const,
    presale_pay_status: status,
    starts_at: new Date(start * 1_000).toISOString(),
    // Exclusive cutoff includes the whole final PHP second, including subsecond requests.
    ends_at: new Date((end + 1) * 1_000).toISOString(),
    start_time: start, stop_time: end, shipping_days_after_end: days };
}
