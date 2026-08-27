import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { userSearch, userVisit } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SEARCH_CACHE_SECONDS = 2 * 60 * 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export function normalizeBehaviorIds(value: unknown): number[] {
  let input: unknown = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(input)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const candidate of input) {
    const id = Number(candidate);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function paging(page: unknown, limit: unknown): [number, number] {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  const safePage = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const safeLimit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  return [safePage, safeLimit];
}

export class UserBehaviorService {
  constructor(private readonly container: Container) {}

  /**
   * PHP UserSearchServices::vicSearch parity: reuse a two-hour keyword result
   * cache, otherwise collect the complete product id set, then persist the
   * search for both anonymous uid=0 and authenticated users.
   */
  async resolveProductSearch(
    uid: number,
    rawKeyword: string,
    productWhere: Record<string, unknown>,
    now = Math.floor(Date.now() / 1000),
  ): Promise<number[]> {
    const keyword = rawKeyword.trim();
    if (!keyword) return [];
    if (keyword.length > 255) throw new ValidateException("搜索关键词不能超过255个字符");

    const cached = await this.container.db
      .select({ result: userSearch.result })
      .from(userSearch)
      .where(and(eq(userSearch.keyword, keyword), gt(userSearch.addTime, now - SEARCH_CACHE_SECONDS)))
      .orderBy(desc(userSearch.addTime), desc(userSearch.id))
      .limit(1);
    let ids = normalizeBehaviorIds(cached[0]?.result);

    if (ids.length > 0) {
      const existing = new Set(await this.container.storeProductDao.filterExistingIds(ids));
      ids = ids.filter((id) => existing.has(id));
    }
    if (ids.length === 0) {
      // Cache the full visible keyword result, not a category/brand/page
      // subset. Remaining request filters stay on the final product query.
      const keywordWhere: Record<string, unknown> = {
        isShow: productWhere.isShow,
        isDel: productWhere.isDel,
        isVerify: productWhere.isVerify,
        status: productWhere.status,
        isVipProduct: productWhere.isVipProduct,
        store_name: keyword,
      };
      const products = await this.container.storeProductDao.getSearchList({ where: keywordWhere });
      ids = normalizeBehaviorIds(products.map((product) => product.id));
    }

    await this.saveSearch(uid, keyword, [], ids, now);
    return ids;
  }

  private async saveSearch(
    uid: number,
    keyword: string,
    vicword: string[],
    result: number[],
    now: number,
  ): Promise<void> {
    const resultJson = JSON.stringify(result);
    const vicwordJson = JSON.stringify(vicword);
    await withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('user_search'), hashtext(${`${uid}:${keyword}`}))`,
      );
      const existing = await tx
        .select({ id: userSearch.id, num: userSearch.num })
        .from(userSearch)
        .where(and(
          eq(userSearch.uid, uid),
          eq(userSearch.keyword, keyword),
          eq(userSearch.isDel, 0),
        ))
        .orderBy(desc(userSearch.addTime), desc(userSearch.id))
        .limit(1)
        .for("update");
      if (existing[0]) {
        await tx
          .update(userSearch)
          .set({
            result: resultJson,
            vicword: vicwordJson,
            addTime: now,
            num: existing[0].num + 1,
          })
          .where(eq(userSearch.id, existing[0].id));
        return;
      }
      await tx.insert(userSearch).values({
        uid,
        keyword,
        vicword: vicwordJson,
        result: resultJson,
        addTime: now,
      });
    });
  }

  async searchHistory(uid: number, page: unknown, limit: unknown) {
    const [safePage, safeLimit] = paging(page, limit);
    const rows = await this.container.db
      .select({ id: userSearch.id, keyword: userSearch.keyword, num: userSearch.num })
      .from(userSearch)
      .where(and(eq(userSearch.uid, uid), eq(userSearch.isDel, 0)))
      .orderBy(desc(userSearch.addTime), desc(userSearch.num), desc(userSearch.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
    return rows;
  }

  async cleanSearchHistory(uid: number): Promise<void> {
    await this.container.db
      .update(userSearch)
      .set({ isDel: 1 })
      .where(and(eq(userSearch.uid, uid), eq(userSearch.isDel, 0)));
  }

  async recordVisit(input: {
    uid: number;
    url: string;
    stayTime?: unknown;
    ip?: string;
    province?: string;
    now?: number;
  }): Promise<void> {
    const url = input.url.trim();
    if (!url) throw new ValidateException("未获取页面路径");
    if (url.length > 255) throw new ValidateException("页面路径不能超过255个字符");
    const user = await this.container.userDao.findForAuth(input.uid);
    if (!user) throw new NotFoundException("数据不存在");

    const parsedStayTime = Number(input.stayTime ?? 0);
    const stayTime = Number.isSafeInteger(parsedStayTime) && parsedStayTime >= 0
      ? Math.min(parsedStayTime, 2_147_483_647)
      : 0;
    await this.container.db.insert(userVisit).values({
      uid: user.uid,
      url,
      ip: String(input.ip ?? "").slice(0, 255),
      stayTime,
      addTime: input.now ?? Math.floor(Date.now() / 1000),
      channelType: user.userType || "h5",
      province: String(input.province || user.province || "").slice(0, 255),
    });
  }

  async recordLoginVisit(uid: number, ip = "", province = ""): Promise<void> {
    await this.recordVisit({ uid, url: "/pages/index/index", ip, province });
  }
}
