import { couponProductId } from "./couponProducts";

export interface ScopeName { id: number; name: string | null }
export interface ScopeEntry extends ScopeName { ancestors: ScopeName[]; hierarchyComplete: boolean }
export interface ScopeDescription { couponId: number; title: string; scopeType: number; entries: ScopeEntry[]; total: number; version: string; nextCursor: number | null }
export interface ScopeDescriptionState extends ScopeDescription { loading: boolean; loaded: boolean; error: string }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("优惠券范围说明无效");
  return value as Record<string, unknown>;
};
function name(value: unknown): ScopeName {
  const row = object(value);
  if (typeof row.id !== "number" || (row.name !== null && (typeof row.name !== "string" || !row.name.trim() || row.name.length > 1000))) throw new Error("优惠券范围名称无效");
  return { id: couponProductId(row.id), name: row.name };
}
export function normalizeScopeDescription(value: unknown, couponId: number, before?: number): ScopeDescription {
  couponProductId(couponId); if (before !== undefined) couponProductId(before);
  const row = object(value);
  if (row.coupon_id !== couponId || row.scope_only !== true || typeof row.coupon_title !== "string" || row.coupon_title.length > 1000
    || typeof row.scope_type !== "number" || ![0, 1, 2, 3].includes(row.scope_type) || typeof row.total_count !== "number" || !Number.isSafeInteger(row.total_count) || row.total_count < 0
    || typeof row.scope_version !== "string" || !/^[a-f0-9]{64}$/.test(row.scope_version)
    || !Array.isArray(row.entries) || row.entries.length > 100 || row.entries.length > row.total_count) throw new Error("优惠券范围说明合同不匹配");
  let previous = before ?? Infinity;
  const entries = row.entries.map(value => {
    const entry = object(value), current = name(value);
    if (current.id >= previous || !Array.isArray(entry.ancestors) || entry.ancestors.length > 32 || typeof entry.hierarchy_complete !== "boolean") throw new Error("优惠券范围层级无效");
    previous = current.id;
    const ancestors = entry.ancestors.map(name), ids = [current.id, ...ancestors.map(node => node.id)];
    if (new Set(ids).size !== ids.length) throw new Error("优惠券范围层级重复");
    return { ...current, ancestors, hierarchyComplete: entry.hierarchy_complete };
  });
  const nextCursor = row.next_cursor === null ? null : typeof row.next_cursor === "number" ? couponProductId(row.next_cursor) : (() => { throw new Error("优惠券范围分页无效"); })();
  if (nextCursor !== null && (!entries.length || nextCursor !== previous || entries.length >= row.total_count)) throw new Error("优惠券范围分页不匹配");
  if (row.scope_type === 0 && (row.total_count !== 0 || entries.length || nextCursor !== null)) throw new Error("通用券范围合同不匹配");
  if (row.scope_type === 2 && entries.some(entry => entry.ancestors.length)) throw new Error("商品券范围合同不匹配");
  return { couponId, title: row.coupon_title, scopeType: row.scope_type, total: row.total_count, version: row.scope_version, entries, nextCursor };
}
export const emptyScopeDescription = (): ScopeDescriptionState => ({ couponId: 0, title: "", scopeType: 0, total: 0, version: "", entries: [], nextCursor: null, loading: false, loaded: false, error: "" });
export class ScopeDescriptionSession {
  private generation = 0;
  private state = emptyScopeDescription();
  constructor(private readonly fetch: (couponId: number, before?: number) => Promise<ScopeDescription>, private readonly publish: (state: ScopeDescriptionState) => void) {}
  reset() { this.generation++; this.state = emptyScopeDescription(); this.publish(this.state); }
  async load(couponId: number, append = false) {
    if (append && (this.state.couponId !== couponId || this.state.loading || this.state.nextCursor === null)) return;
    const generation = ++this.generation, prior = append ? this.state : emptyScopeDescription();
    this.state = { ...prior, couponId, loading: true, error: "" }; this.publish(this.state);
    try {
      const page = await this.fetch(couponProductId(couponId), append ? prior.nextCursor! : undefined);
      if (generation !== this.generation) return;
      if (page.couponId !== couponId || (append && (page.title !== prior.title || page.scopeType !== prior.scopeType || page.total !== prior.total || page.version !== prior.version
        || prior.entries.length + page.entries.length > page.total))) throw new Error("优惠券配置范围已变化，请刷新后重试");
      this.state = { ...page, entries: [...prior.entries, ...page.entries], loaded: true, loading: false, error: "" };
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...prior, couponId, loading: false, error: error instanceof Error ? error.message : "范围说明加载失败" };
    }
    this.publish(this.state);
  }
}
