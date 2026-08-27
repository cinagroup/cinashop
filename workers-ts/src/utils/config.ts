/** 兼容 PHP system_config 中 JSON 编码的标量，例如 `"10"`。 */
export function normalizeConfigScalar(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized.startsWith('"') || !normalized.endsWith('"')) return normalized;
  try {
    const parsed: unknown = JSON.parse(normalized);
    return typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean"
      ? String(parsed).trim()
      : normalized;
  } catch {
    return normalized;
  }
}

export function parseConfigInteger(value: string | undefined, fallback: number): number {
  const normalized = normalizeConfigScalar(value);
  if (normalized === "") return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
