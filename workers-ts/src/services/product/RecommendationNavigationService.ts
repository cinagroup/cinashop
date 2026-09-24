import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeActivity, storeBargain, storeCombination, storeSeckill, storeSeckillTime } from "@/models/schema";
import { evaluateSeckillSchedule, seckillSlotIds } from "@/services/activity/SeckillScheduleService";
import { ValidateException } from "@/utils/errors";

const MAX_PRODUCTS = 100, MAX_CANDIDATES = 500;
type Kind = "product" | "seckill" | "bargain" | "combination" | "presale" | "unavailable";
export interface RecommendationTarget {
  version: 1; product_id: number; kind: Kind; id: number | null; ends_at: string | null;
}
type Candidate = { id: number; productId: number; kind: "seckill" | "bargain" | "combination"; endsAt: number | null };

function priority(value: unknown): number[] | null {
  if (typeof value !== "string" || value.length > 255) return null;
  const normalized = value.trim() || "0,1,2,3";
  if (!/^[0-3](?:,[0-3]){0,3}$/.test(normalized)) return null;
  const values = normalized.split(",").map(Number);
  return new Set(values).size === values.length ? values : null;
}
function target(productId: number, kind: Kind, id: number | null = productId, endsAt: number | null = null): RecommendationTarget {
  return { version: 1, product_id: productId, kind, id, ends_at: endsAt === null ? null : new Date(endsAt).toISOString() };
}

/** Read-only navigation projection for an already visibility-filtered hot page.
 * No price quote, stock reservation, participation write, or purchase authority.
 * Preserve raw `activity` for existing consumers; explicit versioned IDs are additive.
 */
export class RecommendationNavigationService {
  constructor(private readonly container: Pick<Container, "db">) {}

  async decorate(list: readonly Record<string, unknown>[], now = new Date()): Promise<Record<string, unknown>[]> {
    if (list.length > MAX_PRODUCTS || !Number.isFinite(now.getTime())) throw new ValidateException("推荐导航查询参数无效");
    const seen = new Set<number>();
    const rows = list.map(item => {
      const id = item.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647 || seen.has(id)) {
        throw new ValidateException("推荐商品标识无效");
      }
      seen.add(id);
      return { item, id, order: priority(item.activity) };
    });
    const eligible = rows.filter(row => row.item.is_presale_product === 0 && row.order && row.order[0] !== 0);
    const idsFor = (type: number) => eligible.filter(row => row.order!.includes(type)).map(row => row.id);
    const [seckills, bargains, combinations] = await Promise.all([
      this.seckills(idsFor(1), now), this.bargains(idsFor(2), now), this.combinations(idsFor(3), now),
    ]);
    const byProduct = new Map<number, Map<string, Candidate>>();
    // Each type query has deterministic sort DESC/id DESC; take its first live candidate.
    // PHP's duplicate same-type choice had no ORDER BY, so do not reproduce DB physical order.
    for (const candidate of [...seckills, ...bargains, ...combinations]) {
      const choices = byProduct.get(candidate.productId) ?? new Map<string, Candidate>();
      if (!choices.has(candidate.kind)) choices.set(candidate.kind, candidate);
      byProduct.set(candidate.productId, choices);
    }
    return rows.map(({ item, id, order }) => {
      let selected: RecommendationTarget;
      if (item.is_presale_product === 1) selected = target(id, "presale");
      else if (item.is_presale_product !== 0 || !order) selected = target(id, "unavailable", null);
      else {
        const types = { 1: "seckill", 2: "bargain", 3: "combination" } as const;
        // Only a LEADING zero selects ordinary immediately. Later zeros do not stop PHP's search.
        const match = order[0] === 0 ? undefined : order.flatMap(type => {
          const kind = types[type as keyof typeof types];
          const candidate = kind ? byProduct.get(id)?.get(kind) : undefined;
          return candidate ? [candidate] : [];
        })[0];
        selected = match ? target(id, match.kind, match.id, match.endsAt) : target(id, "product");
      }
      return { ...item, recommendation_target: selected };
    });
  }

  private bounded<T>(rows: T[]): T[] {
    if (rows.length > MAX_CANDIDATES) throw new ValidateException("推荐候选活动超过500项，请先整理活动配置");
    return rows;
  }

  private async bargains(ids: number[], now: Date): Promise<Candidate[]> {
    if (!ids.length) return [];
    const rows = this.bounded(await this.container.db.select({ id: storeBargain.id, productId: storeBargain.productId,
      stopTime: storeBargain.stopTime }).from(storeBargain).where(and(
      inArray(storeBargain.productId, ids), eq(storeBargain.status, 1), eq(storeBargain.isDel, 0),
      or(isNull(storeBargain.startTime), lte(storeBargain.startTime, now)),
      or(isNull(storeBargain.stopTime), gte(storeBargain.stopTime, now)),
    )).orderBy(desc(storeBargain.sort), desc(storeBargain.id)).limit(MAX_CANDIDATES + 1));
    return rows.map(row => ({ id: row.id, productId: row.productId, kind: "bargain",
      // Existing bargain/combination detail contracts include the exact stop timestamp.
      endsAt: row.stopTime ? row.stopTime.getTime() + 1 : null }));
  }

  private async combinations(ids: number[], now: Date): Promise<Candidate[]> {
    if (!ids.length) return [];
    const rows = this.bounded(await this.container.db.select({ id: storeCombination.id, productId: storeCombination.productId,
      stopTime: storeCombination.stopTime }).from(storeCombination).where(and(
      inArray(storeCombination.productId, ids), eq(storeCombination.status, 1), eq(storeCombination.isShow, 1), eq(storeCombination.isDel, 0),
      or(isNull(storeCombination.startTime), lte(storeCombination.startTime, now)),
      or(isNull(storeCombination.stopTime), gte(storeCombination.stopTime, now)),
    )).orderBy(desc(storeCombination.sort), desc(storeCombination.id)).limit(MAX_CANDIDATES + 1));
    return rows.map(row => ({ id: row.id, productId: row.productId, kind: "combination", endsAt: row.stopTime ? row.stopTime.getTime() + 1 : null }));
  }

  private async seckills(ids: number[], now: Date): Promise<Candidate[]> {
    if (!ids.length) return [];
    const rows = this.bounded(await this.container.db.select({
      child: { id: storeSeckill.id, productId: storeSeckill.productId, activityId: storeSeckill.activityId,
        status: storeSeckill.status, isShow: storeSeckill.isShow, isDel: storeSeckill.isDel,
        startTime: storeSeckill.startTime, stopTime: storeSeckill.stopTime, timeId: storeSeckill.timeId },
      parent: { id: storeActivity.id, type: storeActivity.type, status: storeActivity.status, isDel: storeActivity.isDel,
        startDay: storeActivity.startDay, endDay: storeActivity.endDay, timeId: storeActivity.timeId },
    }).from(storeSeckill).leftJoin(storeActivity, eq(storeActivity.id, storeSeckill.activityId)).where(and(
      inArray(storeSeckill.productId, ids), eq(storeSeckill.status, 1), eq(storeSeckill.isShow, 1), eq(storeSeckill.isDel, 0),
      or(isNull(storeSeckill.startTime), lte(storeSeckill.startTime, now)),
      // Coarse bound only. The shared evaluator applies date-only inclusive end and parent/slot rules.
      or(isNull(storeSeckill.stopTime), gte(storeSeckill.stopTime, new Date(now.getTime() - 86_400_000))),
    )).orderBy(desc(storeSeckill.sort), desc(storeSeckill.id)).limit(MAX_CANDIDATES + 1));
    const candidates = rows.map(row => {
      let slotIds: number[] = [];
      try {
        slotIds = seckillSlotIds(row.child.timeId);
        if (row.parent) { const parentIds = new Set(seckillSlotIds(row.parent.timeId)); slotIds = slotIds.filter(id => parentIds.has(id)); }
      } catch (error) { if (!(error instanceof ValidateException)) throw error; }
      return { ...row, slotIds };
    });
    // At most 500 candidates * 64 IDs; one bounded slot read, not one query per product.
    const slotIds = [...new Set(candidates.flatMap(row => row.slotIds))];
    const slots = slotIds.length ? await this.container.db.select({ id: storeSeckillTime.id, status: storeSeckillTime.status,
      startTime: storeSeckillTime.startTime, endTime: storeSeckillTime.endTime }).from(storeSeckillTime)
      .where(inArray(storeSeckillTime.id, slotIds)).orderBy(asc(storeSeckillTime.id)).limit(slotIds.length) : [];
    const byId = new Map(slots.map(slot => [slot.id, slot]));
    return candidates.flatMap(row => {
      const state = evaluateSeckillSchedule({ child: row.child, parent: row.parent,
        slots: row.slotIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) }, now);
      return state.state === "active" ? [{ id: row.child.id, productId: row.child.productId,
        kind: "seckill" as const, endsAt: state.endsAt }] : [];
    });
  }
}
