const BUSINESS_TIMEZONE_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

export interface SignDayWindow {
  yesterdayStart: number;
  todayStart: number;
  tomorrowStart: number;
  weekday: number;
  dayOfMonth: number;
}

/**
 * CRMEB's business calendar is Asia/Shanghai. Workers run in UTC, so derive
 * day boundaries from the fixed UTC+8 offset instead of the isolate locale.
 */
export function signDayWindow(nowSeconds = Math.floor(Date.now() / 1000)): SignDayWindow {
  if (!Number.isSafeInteger(nowSeconds)) throw new Error("签到时间无效");
  const localDay = Math.floor((nowSeconds + BUSINESS_TIMEZONE_OFFSET_SECONDS) / DAY_SECONDS);
  const todayStart = localDay * DAY_SECONDS - BUSINESS_TIMEZONE_OFFSET_SECONDS;
  const localDate = new Date((todayStart + BUSINESS_TIMEZONE_OFFSET_SECONDS) * 1000);
  return {
    yesterdayStart: todayStart - DAY_SECONDS,
    todayStart,
    tomorrowStart: todayStart + DAY_SECONDS,
    weekday: localDate.getUTCDay(),
    dayOfMonth: localDate.getUTCDate(),
  };
}

export function nextContinuousSignDays(input: {
  currentDays: number;
  signedYesterday: boolean;
  signMode: number;
  weekday: number;
  dayOfMonth: number;
}): number {
  const cycleReset = (input.signMode === 1 && input.weekday === 1)
    || (input.signMode === 0 && input.dayOfMonth === 1);
  if (!input.signedYesterday || cycleReset) return 1;
  const next = Math.max(0, Math.trunc(input.currentDays)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("连续签到天数超出安全范围");
  return next;
}
