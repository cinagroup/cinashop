/** Translate the legacy minute-resolution picker into inclusive Shanghai Unix seconds. */
function parseShanghaiMinute(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("请选择有效的时间范围");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [yearText, monthText, dayText, hourText, minuteText].map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("请选择有效的时间范围");
  }
  const wallTime = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    wallTime.getUTCFullYear() !== year || wallTime.getUTCMonth() + 1 !== month ||
    wallTime.getUTCDate() !== day || wallTime.getUTCHours() !== hour || wallTime.getUTCMinutes() !== minute
  ) {
    throw new Error("请选择有效的时间范围");
  }
  const seconds = Math.floor(wallTime.getTime() / 1000) - 8 * 60 * 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 2_147_483_647) {
    throw new Error("请选择有效的时间范围");
  }
  return seconds;
}

export function capitalFlowRange(value: readonly string[] | null): { start?: number; stop?: number } {
  if (value === null || value.length === 0) return {};
  if (value.length !== 2) throw new Error("请选择完整的时间范围");
  const start = parseShanghaiMinute(value[0]);
  const endMinute = parseShanghaiMinute(value[1]);
  if (start > endMinute) throw new Error("结束时间不能早于开始时间");
  if (endMinute + 59 > 2_147_483_647) throw new Error("结束时间超出支持范围");
  return { start, stop: endMinute + 59 };
}
