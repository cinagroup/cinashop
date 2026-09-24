import { http } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";

export const VISIT_PAGE_SIZE = 20;
export const VISIT_COLLECT_LIMIT = 100;
export const VISIT_RECOMMENDATION_PAGE_SIZE = 10;
export interface VisitRecommendationLabel { id: number; name: string; icon: string; color: string; background: string; border: string }
export interface VisitRecommendation {
  productId: number; name: string; image: string; price: string; stock: number;
  brand: string; labels: VisitRecommendationLabel[];
  offer: { label: string; price: string } | null;
  destination: string | null; navigationHint: string; navigationExpiresAt: number | null;
}
export interface VisitProduct {
  logId: number; productId: number; name: string; image: string; price: string;
  stock: number; visible: boolean; timeKey: string;
}
export interface VisitPage { list: VisitProduct[]; count: number; page: number }
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) throw Error("浏览记录响应无效");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("浏览记录响应无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) throw Error("浏览记录响应无效");
  return value;
}
function image(value: unknown): string {
  const url = text(value, 2048);
  if (/[\u0000-\u0020\\]/.test(url)) return "";
  if (/^\/(?!\/)/.test(url)) return url;
  try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? url : ""; }
  catch { return ""; }
}
function requireOwner() {
  const auth = useAuthStore();
  if (!auth.isLoggedIn || auth.uid <= 0) throw Error("请先登录后查看浏览记录");
}
function optionalText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.length <= maximum ? value.trim() : "";
}
function labelColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : fallback;
}
function recommendationLabels(value: unknown): VisitRecommendationLabel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>(), labels: VisitRecommendationLabel[] = [];
  // Labels are optional decoration; malformed labels must not hide usable products.
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>, name = optionalText(row.label_name, 64);
    if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 2_147_483_647 || seen.has(row.id) || !name) continue;
    seen.add(row.id);
    labels.push({ id: row.id, name, icon: image(optionalText(row.icon, 2048)),
      color: labelColor(row.color, "#855224"), background: labelColor(row.bg_color, "#fff7ec"), border: labelColor(row.border_color, "#eed7b8") });
    if (labels.length === 8) break;
  }
  return labels;
}
function recommendationOffer(row: Record<string, unknown>, price: string): VisitRecommendation["offer"] {
  // vip_price is a shared legacy slot: it can hold a LEVEL price, not just SVIP.
  // An advertised member offer is not proof that this visitor may buy at that price.
  if (typeof row.vip_price !== "string" || !/^\d{1,10}\.\d{2}$/.test(row.vip_price)
    || Number(row.vip_price) <= 0 || Number(row.vip_price) >= Number(price)) return null;
  if (row.price_type === "member" && row.is_vip === 1) return { label: "SVIP参考价", price: row.vip_price };
  if (row.price_type === "level") return { label: "等级参考价", price: row.vip_price };
  return null;
}
type RecommendationNavigation = Pick<VisitRecommendation, "destination" | "navigationHint" | "navigationExpiresAt">;
function resolvedNavigation(value: unknown, id: number, presale = false): RecommendationNavigation {
  const unavailable = { destination: null, navigationHint: presale ? "预售链接待确认，请刷新记录" : "商品链接待确认，请刷新记录", navigationExpiresAt: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
  const target = value as Record<string, unknown>;
  if (target.version !== 1 || target.product_id !== id) return unavailable;
  let expiresAt: number | null = null;
  if (target.ends_at !== null) {
    if (typeof target.ends_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(target.ends_at)) return unavailable;
    expiresAt = Date.parse(target.ends_at);
    if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== target.ends_at) return unavailable;
  }
  if (typeof target.id !== "number" || !Number.isSafeInteger(target.id) || target.id <= 0 || target.id > 2_147_483_647) return unavailable;
  if (presale) return target.kind === 'presale' && target.id === id && expiresAt === null
    ? { destination: `/pages/activity/presaleDetail?id=${id}`, navigationHint: '预售 · 查看购买规则', navigationExpiresAt: null } : unavailable;
  if (target.kind === "product") return target.id === id && expiresAt === null
    ? { destination: `/pages/goods/detail?id=${id}`, navigationHint: "", navigationExpiresAt: null } : unavailable;
  const routes = { seckill: ["seckillDetail", "秒杀"], bargain: ["bargainDetail", "砍价"], combination: ["detail", "拼团"] } as const;
  if (typeof target.kind !== "string" || !Object.hasOwn(routes, target.kind) || target.kind === "seckill" && expiresAt === null) return unavailable;
  const [route, label] = routes[target.kind as keyof typeof routes];
  return { destination: `/pages/activity/${route}?id=${target.id}`, navigationHint: `${label} · 查看活动详情`, navigationExpiresAt: expiresAt };
}
function recommendationNavigation(row: Record<string, unknown>, id: number): RecommendationNavigation {
  if (row.is_presale_product === 1) return resolvedNavigation(row.recommendation_target, id, true);
  if (row.is_presale_product !== 0 || typeof row.activity !== "string" || row.activity.length > 255)
    return { destination: null, navigationHint: "商品链接待确认，请刷新记录", navigationExpiresAt: null };
  // A present but malformed new contract must never fall back to the ordinary/legacy route.
  if (row.recommendation_target !== undefined) return resolvedNavigation(row.recommendation_target, id);
  const priority = row.activity.trim() || "0,1,2,3";
  if (!/^[0-3](?:,[0-3]){0,3}$/.test(priority) || new Set(priority.split(",")).size !== priority.split(",").length)
    return { destination: null, navigationHint: "商品链接待确认，请刷新记录", navigationExpiresAt: null };
  if (priority[0] === "0") return { destination: `/pages/goods/detail?id=${id}`, navigationHint: "", navigationExpiresAt: null };
  // Compatibility with a server deployed before the additive target contract only.
  return { destination: "/pages/activity/index", navigationHint: "活动详情待确认，查看活动专区", navigationExpiresAt: null };
}
export async function apiVisitHistory(page: number): Promise<VisitPage> {
  requireOwner(); integer(page, 1);
  const data = record(await http.get<unknown>("/user/visit_list", { page, limit: VISIT_PAGE_SIZE }));
  if (data.page !== page || data.limit !== VISIT_PAGE_SIZE || !Array.isArray(data.list) || data.list.length > VISIT_PAGE_SIZE) throw Error("浏览记录页码或内容无效");
  const count = integer(data.count), seen = new Set<number>();
  const list = data.list.map(raw => {
    const row = record(raw), productId = integer(row.product_id, 1), logId = integer(row.id, 1);
    if (seen.has(productId)) throw Error("浏览记录重复，请刷新");
    seen.add(productId);
    if (typeof row.product_price !== "string" || !/^\d{1,10}\.\d{2}$/.test(row.product_price)) throw Error("浏览记录价格无效");
    const timeKey = text(row.time_key, 32);
    if (!/^(?:\d{4}年)?\d{2}月\d{2}日$/.test(timeKey) || ![0, 1].includes(row.is_show as number)) throw Error("浏览记录响应无效");
    return { logId, productId, name: text(row.store_name, 512), image: image(row.image), price: row.product_price,
      stock: integer(row.stock), visible: row.is_show === 1, timeKey };
  });
  if (count < list.length) throw Error("浏览记录数量无效");
  return { list, count, page };
}
/** The legacy DELETE contract takes PRODUCT ids, never log row ids. */
export async function apiDeleteVisitHistory(productIds: number[]): Promise<number> {
  requireOwner();
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > 200 || new Set(productIds).size !== productIds.length) throw Error("请选择 1 至 200 件商品");
  productIds.forEach(id => integer(id, 1));
  const data = record(await http.delete<unknown>("/user/visit", { ids: productIds }));
  return integer(data.deleted);
}

export async function apiCollectVisitProducts(productIds: number[]): Promise<number> {
  requireOwner();
  if (!Array.isArray(productIds) || !productIds.length || productIds.length > VISIT_COLLECT_LIMIT || new Set(productIds).size !== productIds.length) throw Error("请选择 1 至 100 件商品");
  productIds.forEach(id => integer(id, 1));
  const data = record(await http.post<unknown>("/collect/add", { id: productIds, category: "product" }));
  const count = integer(data.count);
  if (count > productIds.length) throw Error("收藏结果无效");
  return count;
}

/** The public hot catalogue returns an array, unlike the private history envelope. */
export async function apiVisitRecommendations(page: number): Promise<VisitRecommendation[]> {
  requireOwner(); integer(page, 1);
  const data = await http.get<unknown>("/product/hot", { page, limit: VISIT_RECOMMENDATION_PAGE_SIZE });
  if (!Array.isArray(data) || data.length > VISIT_RECOMMENDATION_PAGE_SIZE) throw Error("推荐商品响应无效，请刷新记录");
  const seen = new Set<number>();
  try {
    return data.map(raw => {
      const row = record(raw), productId = integer(row.id, 1);
      if (seen.has(productId) || typeof row.price !== "string" || !/^\d{1,10}\.\d{2}$/.test(row.price)) throw Error("invalid recommendation");
      seen.add(productId);
      return { productId, name: text(row.store_name, 512), image: image(row.image), price: row.price, stock: integer(row.stock),
        brand: optionalText(row.brand_name, 128), labels: recommendationLabels(row.store_label),
        offer: recommendationOffer(row, row.price), ...recommendationNavigation(row, productId) };
    });
  } catch { throw Error("推荐商品响应无效，请刷新记录"); }
}
