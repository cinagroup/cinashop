import {
  apiDiyPage,
  apiDiyVersion,
  DIY_COMPONENT_NAMES,
  type DiyComponent,
  type DiyComponentName,
  type DiyPage,
} from "@/api/diy";
import { resolveRegisteredPageRoute, TAB_ROUTES } from "@/config/navigation";
import { API_BASE, RequestError } from "@/utils/request";
import { diyEditorialMediaCacheUsable } from './diyEditorialMediaLease';
import { ref } from 'vue';

const DIY_CACHE_PREFIX = "cinashop_diy_page_v1_";
const MAX_COMPONENTS = 200;
const ALLOWED_COMPONENTS = new Set<string>(DIY_COMPONENT_NAMES);

interface DiyCacheEntry {
  version: string | null;
  cachedAt: number;
  data: DiyPage | null;
  versionVerified: boolean;
}

export interface DiyPageSnapshot extends DiyCacheEntry {
  source: "network" | "cache" | "offline";
}

export class DiyPageLoadError extends Error {
  constructor(message: string, readonly kind: "invalid" | "closed" | "superseded" | "unstable") {
    super(message); this.name = "DiyPageLoadError";
  }
}

interface PageSlot {
  generation: number;
  pending?: Promise<DiyPageSnapshot>;
  consumers?: Set<() => boolean>;
  completed?: { snapshot: DiyPageSnapshot } | { error: unknown };
}
const pageSlots = new Map<number, PageSlot>();
let stationEpoch = 0, stationClosed = false, stationMessage = "站点暂未开放，请稍后重试";
/** A certain closure must also revoke already mounted public consumers. */
export const diyStationClosure = ref<string | null>(null);
export const diyStationEpoch = () => stationEpoch;
/** Only a fresh successful liveness read from this same station epoch may reopen. */
export function confirmDiyStationOpen(epoch: number): boolean {
  if (epoch !== stationEpoch) return false;
  stationClosed = false; diyStationClosure.value = null;
  return true;
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
  // Micro pages use the last exact pageFoot, independent of body cap/isHide.
  const footer = [...value].reverse().find(raw => asDiyRecord(raw)?.name === 'pageFoot');
  const body = value
    .slice(0, MAX_COMPONENTS)
    .flatMap((raw) => {
      const item = asDiyRecord(raw);
      const name = typeof item?.name === "string" ? item.name : "";
      if (!item || name === 'pageFoot' || !ALLOWED_COMPONENTS.has(name) || isDiyEnabled(item.isHide)) return [];
      return [{ ...item, name: name as DiyComponentName } as DiyComponent];
    })
    .sort((left, right) => componentTimestamp(left) - componentTimestamp(right));
  return footer ? [...body, { ...asDiyRecord(footer), name: 'pageFoot' } as DiyComponent] : body;
}

export function normalizeDiyPage(value: unknown): DiyPage | null {
  const page = asDiyRecord(value);
  if (!page || Array.isArray(value)) return null;
  if (!Array.isArray(page.value) || ![0, 1, "0", "1", false, true, "true", "false"].includes(page.is_show as never)) return null;
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
    if (!entry || !("version" in entry) || !("data" in entry)
      || entry.version !== null && typeof entry.version !== "string") return null;
    const data = entry.data === null ? null : normalizeDiyPage(entry.data);
    if (entry.data !== null && !data) return null;
    return {
      version: entry.version as string | null,
      cachedAt: Number(entry.cachedAt) || 0,
      data,
      versionVerified: entry.versionVerified === true && typeof entry.version === "string",
    };
  } catch {
    return null;
  }
}

function writeCache(id: number, entry: DiyCacheEntry): void {
  try {
    uni.setStorageSync(cacheKey(id), JSON.stringify(entry));
  } catch {
    // Storage quota or private mode must not make the homepage unavailable.
  }
}

/** Only public authored schemas enter this cache; personalized widget reads never do. */
export function closeDiyStation(message = "站点暂未开放，请稍后重试"): void {
  stationClosed = true; stationEpoch++;
  stationMessage = message.slice(0, 400) || "站点暂未开放，请稍后重试";
  diyStationClosure.value = stationMessage;
  for (const [id, slot] of pageSlots) {
    slot.generation++; slot.pending = undefined; slot.consumers = undefined;
    slot.completed = { error: new DiyPageLoadError(stationMessage, "closed") };
    try { uni.removeStorageSync(cacheKey(id)); } catch { /* Known closure also blocks unread cache keys. */ }
  }
}

function versionOf(value: unknown): string | null {
  const row = asDiyRecord(value);
  if (!row || !("version" in row) || row.version !== null && typeof row.version !== "string") {
    throw new DiyPageLoadError("页面版本响应无效，请重试", "invalid");
  }
  return row.version as string | null;
}
const cloneSnapshot = (snapshot: DiyPageSnapshot): DiyPageSnapshot => JSON.parse(JSON.stringify(snapshot));
const closedError = () => new DiyPageLoadError(stationMessage, "closed");
function transient(error: unknown): boolean {
  return error instanceof RequestError && (error.httpStatus !== undefined && error.httpStatus >= 500
    || error.status === undefined && (error.httpStatus === undefined || error.httpStatus === 0));
}

/** Versions are opaque equality tokens. Two bounded before/after checks associate
 * a changed payload; they do not claim an atomic server/database snapshot. */
export async function loadDiyPage(id = 0, force = false, consumer: () => boolean = () => true): Promise<DiyPageSnapshot> {
  if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new DiyPageLoadError("页面编号无效", "invalid");
  const superseded = () => new DiyPageLoadError("页面请求已替换", "superseded");
  if (!consumer()) throw superseded();
  const safeId = id;
  if (stationClosed && !force) throw closedError();
  let slot = pageSlots.get(safeId);
  if (!slot) { slot = { generation: 0 }; pageSlots.set(safeId, slot); }
  const forConsumer = async (work: Promise<DiyPageSnapshot>) => {
    const snapshot = await work;
    if (!consumer()) throw superseded();
    return cloneSnapshot(snapshot);
  };
  if (!force && slot.pending) { slot.consumers?.add(consumer); return forConsumer(slot.pending); }
  const state = slot, generation = ++state.generation, epoch = stationEpoch, cached = stationClosed ? null : readCache(safeId);
  const consumers = new Set([consumer]); state.consumers = consumers;
  const alive = () => [...consumers].some(reader => reader());
  state.completed = undefined;
  const current = () => state.generation === generation && epoch === stationEpoch;
  let pending!: Promise<DiyPageSnapshot>;
  async function latest(): Promise<DiyPageSnapshot> {
    if (!alive()) throw superseded();
    if (epoch !== stationEpoch) throw stationClosed ? closedError() : new DiyPageLoadError("页面请求已替换", "superseded");
    if (state.pending && state.pending !== pending) return state.pending;
    if (state.completed) {
      if ("error" in state.completed) throw state.completed.error;
      return state.completed.snapshot;
    }
    throw new DiyPageLoadError("页面请求已替换", "superseded");
  }
  function complete(snapshot: DiyPageSnapshot): DiyPageSnapshot {
    state.completed = { snapshot: cloneSnapshot(snapshot) };
    return snapshot;
  }
  pending = (async (): Promise<DiyPageSnapshot> => {
    try {
      let version = versionOf(await apiDiyVersion(safeId));
      if (!current()) return latest();
      if (!alive()) throw superseded();
      if (!force && !stationClosed && cached?.versionVerified && version !== null && cached.version === version
        && diyEditorialMediaCacheUsable(cached.data, cached.cachedAt)) {
        return complete({ ...cached, source: "cache" });
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!alive()) throw superseded();
        const raw = await apiDiyPage(safeId);
        if (!current()) return latest();
        if (!alive()) throw superseded();
        const data = normalizeDiyPage(raw);
        if (data === null && !(Array.isArray(raw) && raw.length === 0)) throw new DiyPageLoadError("页面配置响应无效，请重试", "invalid");
        const after = versionOf(await apiDiyVersion(safeId));
        if (!current()) return latest();
        if (!alive()) throw superseded();
        if (after === version) {
          const entry: DiyCacheEntry = { version: after, data, cachedAt: Date.now(), versionVerified: after !== null };
          if (!diyEditorialMediaCacheUsable(data, entry.cachedAt)) throw new DiyPageLoadError("页面素材访问已过期，请重新加载", "invalid");
          writeCache(safeId, entry);
          stationClosed = false;
          diyStationClosure.value = null;
          return complete({ ...entry, source: "network" });
        }
        version = after;
      }
      throw new DiyPageLoadError("页面配置正在更新，请重新加载", "unstable");
    } catch (error) {
      if (!current()) return latest();
      if (!alive()) throw superseded();
      if (error instanceof RequestError && error.status === 410010 && (error.httpStatus === undefined || error.httpStatus < 500)) {
        closeDiyStation(error.message); throw closedError();
      }
      if (!stationClosed && cached && transient(error) && diyEditorialMediaCacheUsable(cached.data, cached.cachedAt)) return complete({ ...cached, source: "offline" });
      state.completed = { error }; throw error;
    }
  })().finally(() => { if (state.pending === pending) { state.pending = undefined; state.consumers = undefined; } });
  state.pending = pending;
  return forConsumer(pending);
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
  if (/^\/(?!\/)/.test(url)) return API_BASE && /^\/api\/assets\/[1-9]\d*(?:\?|#|$)/u.test(url) ? API_BASE + url : url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(url) && url.length <= 262_144) return url;
  return "";
}

export function diyPageStyle(page: DiyPage | null, admitted = true): Record<string, string> {
  if (!page || !admitted || !isDiyEnabled(page.is_show)) return {};
  const result: Record<string, string> = {};
  if (isDiyEnabled(page.is_bg_color)) {
    const color = safeDiyColor(page.color_picker);
    if (color) result.backgroundColor = color;
  }
  if (isDiyEnabled(page.is_bg_pic)) {
    const image = safeDiyImageUrl(page.bg_pic);
    if (image && !/[\u0000-\u0020\u007f\\]/u.test(image) && diyEditorialMediaCacheUsable({is_show: 1, is_bg_pic: 1, bg_pic: image}, Date.now())) {
      result.backgroundImage = `url("${image.replaceAll('"', "%22")}")`;
      result.backgroundSize = String(page.bg_tab_val) === "2" ? "100% 100%" : "100%";
      result.backgroundRepeat = String(page.bg_tab_val) === "1" ? "repeat" : "no-repeat";
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
