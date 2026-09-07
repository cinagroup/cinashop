import { and, eq, inArray } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeBrand, storeProduct, storeProductCategory } from "@/models/schema";
import { parseCouponScopeIds } from "./ProductCouponService";

interface Name { id: number; name: string | null }
interface Node { id: number; name: string; pid: number; ancestors: string }
interface Definition { productIds: number[]; categoryIds: number[]; brandIds: number[] }

/** Display metadata only. Never use visibility or the display parent chain to decide coupon eligibility. */
export async function describeCouponScope(container: Container, type: number, definition: Definition, vip: boolean, query: { before: number; limit: number }) {
  const all = (type === 1 ? definition.categoryIds : type === 2 ? definition.productIds : type === 3 ? definition.brandIds : []).slice().sort((a, b) => b - a);
  const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([type, all])));
  const scope_version = Array.from(new Uint8Array(fingerprint), byte => byte.toString(16).padStart(2, "0")).join("");
  const remaining = all.filter(id => !query.before || id < query.before), ids = remaining.slice(0, query.limit);
  const nodes = new Map<number, Node>();
  const attempted = new Set<number>();
  let pending = ids;
  // At most 100 roots per page and 32 parent edges per root. Batch each level, never query once per entry.
  for (let depth = 0; pending.length && depth <= 32; depth++) {
    pending.forEach(id => attempted.add(id));
    let rows: Node[];
    if (type === 1) rows = await container.db.select({ id: storeProductCategory.id, name: storeProductCategory.cateName, pid: storeProductCategory.pid, ancestors: storeProductCategory.path })
      .from(storeProductCategory).where(and(inArray(storeProductCategory.id, pending), eq(storeProductCategory.isShow, 1), eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0)));
    else if (type === 3) rows = await container.db.select({ id: storeBrand.id, name: storeBrand.brandName, pid: storeBrand.pid, ancestors: storeBrand.fid })
      .from(storeBrand).where(and(inArray(storeBrand.id, pending), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0)));
    else {
      const where = [inArray(storeProduct.id, pending), eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1)];
      if (!vip) where.push(eq(storeProduct.isVipProduct, 0));
      rows = (await container.db.select({ id: storeProduct.id, name: storeProduct.storeName }).from(storeProduct).where(and(...where)))
        .map(row => ({ ...row, pid: 0, ancestors: "" }));
    }
    rows.forEach(row => nodes.set(row.id, row));
    pending = [...new Set(rows.map(row => row.pid).filter(id => id > 0 && !attempted.has(id)))];
  }
  const nodeName = (id: number): Name => ({ id, name: nodes.get(id)?.name.trim() || null });
  const entries = ids.map(id => {
    const root = nodes.get(id), ancestors: Name[] = [], seen = new Set([id]);
    let parent = root?.pid ?? 0, complete = !!root;
    while (parent > 0) {
      if (seen.has(parent) || ancestors.length >= 32) { complete = false; break; }
      seen.add(parent); ancestors.unshift(nodeName(parent));
      const node = nodes.get(parent);
      if (!node) { complete = false; break; }
      parent = node.pid;
    }
    if (parent < 0) complete = false;
    // Stale path/fid metadata may differ from the parent tree; don't present it as a verified hierarchy.
    if (root && type !== 2) {
      const expected = parseCouponScopeIds(root.ancestors, root.pid);
      if (expected.length !== ancestors.length || expected.some(key => !ancestors.some(node => node.id === key))) complete = false;
    }
    return { ...nodeName(id), ancestors, hierarchy_complete: complete };
  });
  return { entries, total_count: all.length, scope_version, next_cursor: remaining.length > ids.length ? ids[ids.length - 1]! : null };
}
