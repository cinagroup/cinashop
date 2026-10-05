import { resolveRegisteredPageRoute, TAB_ROUTES } from "@/config/navigation";

export interface FabButton { img: string; url: string }
export interface FabConfig { is_show: 0 | 1; index: 1 | 2 | 3 | 4; shifting: number; main_ago_image: string; main_after_image: string; button: FabButton[] }
export type FabDestination = { kind: "page"; url: string; tab: boolean } | { kind: "external"; url: string } | { kind: "mini"; path: string; appId: string };
const clean = (value: unknown, max: number): value is string => typeof value === "string" && [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value) && ![...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });

/** Check every decoding layer, including URL-normalized dot segments. Encoded spaces are legitimate. */
export function fabAddressLayers(value: string, protocols: string[] = ["http:", "https:"]): string[] | null {
  let layer = value; const layers: string[] = [];
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return null;
    try {
      if (/^\/(?!\/)/u.test(layer)) { if (!/^\/(?!\/)/u.test(new URL(layer, "https://fab.invalid").pathname)) return null; }
      else { const url = new URL(layer); if (!/^https?:\/\//iu.test(layer) || !protocols.includes(url.protocol) || url.username || url.password) return null; }
    } catch { return null; }
    layers.push(layer); if (!/%[a-f0-9]{2}/iu.test(layer)) return layers;
    if (depth === 3) return null;
    try { layer = decodeURIComponent(layer); } catch { return null; }
  }
  return null;
}

export function resolveFabLink(value: unknown): FabDestination | null {
  if (!clean(value, 2048)) return null; const source = value.trim(); if (!source) return null;
  const marker = source.indexOf("@APPID=");
  if (marker >= 0) {
    if (source.indexOf("@APPID=", marker + 1) >= 0) return null;
    const path = source.slice(0, marker), appId = source.slice(marker + 7);
    if (!/^wx[a-f0-9]{16}$/iu.test(appId) || !fabMiniPath(path)) return null;
    return { kind: "mini", path, appId };
  }
  if (!fabAddressLayers(source)) return null;
  if (/^https?:\/\//iu.test(source)) return { kind: "external", url: source };
  const hash = source.indexOf("#"); if (hash >= 0) return null;
  const split = source.indexOf("?"), path = split < 0 ? source : source.slice(0, split), query = split < 0 ? "" : source.slice(split + 1);
  const target = resolveRegisteredPageRoute(path, query); if (!target) return null;
  const targetPath = target.split("?")[0];
  return { kind: "page", url: target, tab: TAB_ROUTES.has(targetPath) };
}

export function fabMiniPath(value: string): boolean {
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    const page = layer.split('?', 1)[0];
    if (!layer || depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer) || /^[a-z][a-z\d+.-]*:/iu.test(layer) || layer.startsWith('//') || layer.includes('#') || !/^\/?[a-z0-9_.%/-]+$/iu.test(page) || page.split('/').some(part => part === '.' || part === '..')) return false;
    try { const parsed = new URL(layer, 'https://fab.invalid/'); if (parsed.origin !== 'https://fab.invalid' || !/^\/(?!\/)/u.test(parsed.pathname)) return false; } catch { return false; }
    if (!/%[a-f0-9]{2}/iu.test(layer)) return true;
    if (depth === 3) return false; try { layer = decodeURIComponent(layer); } catch { return false; }
  }
  return false;
}

/** Public previews may be signed. Never use this function to validate a saved reference. */
export function fabImagePreview(value: unknown): string {
  return clean(value, 8192) && value && fabAddressLayers(value, ["https:"]) ? value : "";
}
export function parseFabConfig(value: unknown): FabConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, show = row.is_show, index = row.index, shifting = row.shifting;
  if (typeof show !== 'number' || typeof index !== 'number' || typeof shifting !== 'number' || ![0, 1].includes(show) || ![1, 2, 3, 4].includes(index) || !Number.isInteger(shifting) || shifting < 0 || shifting > 100
    || !Array.isArray(row.button) || row.button.length > 5 || index >= 3 && row.button.length < 3) return null;
  const before = index === 4 ? '' : fabImagePreview(row.main_ago_image), after = index === 3 ? fabImagePreview(row.main_after_image) : '';
  if (index < 3 && !before || index === 3 && (!before || !after)) return null;
  const button: FabButton[] = [];
  for (const item of row.button) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const img = fabImagePreview(item.img), destination = resolveFabLink(item.url);
    // Preserve each slot and the radial count. Invalid history is an explicitly unavailable control.
    button.push({ img, url: destination && clean(item.url, 2048) ? item.url.trim() : '' });
  }
  return { is_show: show as 0 | 1, index: index as FabConfig["index"], shifting, main_ago_image: before, main_after_image: after, button };
}

/** Position is the centre, bounded by the measured component height, including expanded children. */
export function fabCentre(percent: number, viewport: number, height: number, dragged?: number | null): number {
  const windowHeight = Math.max(0, Number.isFinite(viewport) ? viewport : 0), actualHeight = Math.min(windowHeight, Math.max(0, Number.isFinite(height) ? height : 0));
  const requested = typeof dragged === "number" && Number.isFinite(dragged) ? dragged : Math.min(100, Math.max(0, percent)) / 100 * windowHeight;
  return Math.max(actualHeight / 2, Math.min(windowHeight - actualHeight / 2, requested));
}
export function fabArc(count: number, item: number): { left: number; top: number } {
  const positions: Record<number, Array<[number, number]>> = { 3: [[-35, -93], [-100, 0], [-35, 93]], 4: [[0, -100], [-90, -50], [-90, 50], [0, 100]], 5: [[0, -110], [-76, -76], [-106, 0], [-76, 76], [0, 110]] };
  const pair = positions[count]?.[item]; return pair ? { left: pair[0], top: pair[1] } : { left: 0, top: 0 };
}

export function openFabLink(value: string): boolean {
  const target = resolveFabLink(value);
  if (!target) { uni.showToast({ title: "悬浮按钮目标无效或尚未登记，请联系管理员修改", icon: "none" }); return false; }
  const fail = () => uni.showToast({ title: "目标暂时无法打开，请稍后重试", icon: "none" });
  if (target.kind === "page") {
    if (target.tab) uni.switchTab({ url: target.url.split("?")[0], fail }); else uni.navigateTo({ url: target.url, fail });
    return true;
  }
  if (target.kind === "mini") {
    // #ifdef MP
    uni.navigateToMiniProgram({ appId: target.appId, path: target.path, envVersion: "release", fail });
    return true;
    // #endif
    // #ifndef MP
    uni.showToast({ title: "H5 与 App 不支持跳转外部小程序", icon: "none" }); return false;
    // #endif
  }
  const externalUrl = target.url;
  // #ifdef H5
  const opened = window.open(externalUrl, "_blank", "noopener,noreferrer"); if (opened) opened.opener = null;
  return true;
  // #endif
  // #ifndef H5
  uni.navigateTo({ url: `/pages/common/fabWebView?url=${encodeURIComponent(externalUrl)}`, fail }); return true;
  // #endif
}

/** Uni page query decoding differs between runtimes: accept raw URL or exactly one encoded transport layer. */
export function fabWebViewUrl(value: unknown): string {
  if (!clean(value, 8192)) return "";
  let source = value; if (!/^https?:\/\//iu.test(source)) { try { source = decodeURIComponent(source); } catch { return ""; } }
  const target = resolveFabLink(source); return target?.kind === "external" ? target.url : "";
}
