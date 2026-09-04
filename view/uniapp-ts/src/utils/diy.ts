import {
  apiDiyPage,
  apiDiyVersion,
  DIY_COMPONENT_NAMES,
  type DiyComponent,
  type DiyComponentName,
  type DiyPage,
} from "@/api/diy";
import { resolveRegisteredPageRoute, TAB_ROUTES } from "@/config/navigation";

const DIY_CACHE_PREFIX = "cinashop_diy_page_v1_";
const MAX_COMPONENTS = 200;
const ALLOWED_COMPONENTS = new Set<string>(DIY_COMPONENT_NAMES);

interface DiyCacheEntry {
  version: string | null;
  cachedAt: number;
  data: DiyPage | null;
}

export function asDiyRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function diyValue(source: unknown, key: string): unknown {
  return asDiyRecord(source)?.[key];
}

export function diyNestedValue(source: unknown, key: string): unknown {
  const value = diyValue(source, key);
  const record = asDiyRecord(value);
  return record?.value ?? record?.val ?? value;
}

export function diyNumber(source: unknown, key: string, fallback = 0): number {
  const value = Number(diyNestedValue(source, key));
  return Number.isFinite(value) ? value : fallback;
}

export function diyText(source: unknown, key: string, fallback = ""): string {
  const value = diyNestedValue(source, key);
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  return String(value).slice(0, 1_000);
}

export function diyList(source: unknown, ...path: string[]): unknown[] {
  let current = source;
  for (const part of path) current = diyValue(current, part);
  return Array.isArray(current) ? current : [];
}

export function isDiyEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return value.trim() === "1" || value.trim().toLowerCase() === "true";
}

function componentTimestamp(component: DiyComponent): number {
  const value = Number(component.timestamp);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function normalizeDiyComponents(value: unknown): DiyComponent[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_COMPONENTS)
    .flatMap((raw) => {
      const item = asDiyRecord(raw);
      const name = typeof item?.name === "string" ? item.name : "";
      if (!item || !ALLOWED_COMPONENTS.has(name) || isDiyEnabled(item.isHide)) return [];
      return [{ ...item, name: name as DiyComponentName } as DiyComponent];
    })
    .sort((left, right) => componentTimestamp(left) - componentTimestamp(right));
}

export function normalizeDiyPage(value: unknown): DiyPage | null {
  const page = asDiyRecord(value);
  if (!page || Array.isArray(value)) return null;
  const title = typeof page.title === "string" ? page.title.trim().slice(0, 100) : "";
  return {
    title: title || "CinaShop",
    value: normalizeDiyComponents(page.value),
    is_show: page.is_show as number | string | boolean,
    is_bg_color: page.is_bg_color as number | string | boolean,
    color_picker: typeof page.color_picker === "string" ? page.color_picker : "",
    bg_pic: typeof page.bg_pic === "string" ? page.bg_pic : "",
    bg_tab_val: typeof page.bg_tab_val === "number" || typeof page.bg_tab_val === "string"
      ? page.bg_tab_val
      : 0,
    is_bg_pic: page.is_bg_pic as number | string | boolean,
    order_status: typeof page.order_status === "number" || typeof page.order_status === "string"
      ? page.order_status
      : 0,
  };
}

function cacheKey(id: number): string {
  return `${DIY_CACHE_PREFIX}${id}`;
}

function readCache(id: number): DiyCacheEntry | null {
  try {
    const raw = uni.getStorageSync(cacheKey(id));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const entry = asDiyRecord(parsed);
    if (!entry || !("version" in entry) || !("data" in entry)) return null;
    const data = entry.data === null ? null : normalizeDiyPage(entry.data);
    return {
      version: typeof entry.version === "string" ? entry.version : null,
      cachedAt: Number(entry.cachedAt) || 0,
      data,
    };
  } catch {
    return null;
  }
}

function writeCache(id: number, version: string | null, data: DiyPage | null): void {
  try {
    const entry: DiyCacheEntry = { version, cachedAt: Date.now(), data };
    uni.setStorageSync(cacheKey(id), JSON.stringify(entry));
  } catch {
    // Storage quota or private mode must not make the homepage unavailable.
  }
}

/**
 * Revalidate the small version endpoint before reusing a page payload. On a
 * transient network error a previously validated cached page remains usable.
 */
export async function loadDiyPage(id = 0, force = false): Promise<DiyPage | null> {
  const safeId = Number.isSafeInteger(id) && id >= 0 ? id : 0;
  const cached = readCache(safeId);
  try {
    const { version } = await apiDiyVersion(safeId);
    if (!force && cached && cached.version === version) return cached.data;
    const data = normalizeDiyPage(await apiDiyPage(safeId));
    writeCache(safeId, version, data);
    return data;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}

export function safeDiyColor(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|hsl)a?\([0-9.,%\s+-]+\)$/i.test(color)) return color;
  if (/^(?:transparent|black|white)$/i.test(color)) return color.toLowerCase();
  return fallback;
}

export function safeDiyImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (!url || url.length > 4_096 || /[\u0000-\u001f\u007f]/.test(url)) return "";
  if (/^https:\/\//i.test(url)) return url;
  if (/^http:\/\//i.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url) && url.length <= 262_144) return url;
  return "";
}

export function diyPageStyle(page: DiyPage | null): Record<string, string> {
  if (!page) return {};
  const result: Record<string, string> = {};
  if (isDiyEnabled(page.is_bg_color)) {
    const color = safeDiyColor(page.color_picker);
    if (color) result.backgroundColor = color;
  }
  if (isDiyEnabled(page.is_bg_pic)) {
    const image = safeDiyImageUrl(page.bg_pic);
    if (image) {
      result.backgroundImage = `url("${image.replaceAll('"', "%22")}")`;
      result.backgroundSize = String(page.bg_tab_val) === "2" ? "cover" : "100% auto";
      result.backgroundRepeat = String(page.bg_tab_val) === "1" ? "repeat-y" : "no-repeat";
    }
  }
  return result;
}

function stringLink(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = asDiyRecord(value);
  if (!record) return "";
  for (const key of ["url", "value", "title", "link"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}

export function diyItemLink(value: unknown): string {
  const record = asDiyRecord(value);
  const info = Array.isArray(record?.info) ? record.info : [];
  return stringLink(info[1]) || stringLink(record?.link) || stringLink(record?.url);
}

export function normalizeDiyLink(value: unknown): string {
  const raw = stringLink(value);
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  if (/^https:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/pages/")) return "";
  const [path, query = ""] = raw.split("?", 2);
  if (!/^\/pages\/[a-z0-9_/-]+$/i.test(path)) return "";
  return resolveRegisteredPageRoute(path, query);
}

export function openDiyLink(value: unknown): void {
  const target = normalizeDiyLink(value);
  if (!target) return;
  if (/^https:\/\//i.test(target)) {
    uni.showToast({ title: "请在浏览器打开外部链接", icon: "none" });
    return;
  }
  const path = target.split("?", 1)[0];
  if (TAB_ROUTES.has(path)) {
    uni.switchTab({ url: path });
    return;
  }
  uni.navigateTo({ url: target });
}
