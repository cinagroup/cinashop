import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { userCard, userEnter, wechatCard } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const MAX_LIMIT = 100;

function integer(
  value: unknown,
  label: string,
  options: { fallback?: number; min?: number; max?: number } = {},
): number {
  if (value === undefined || value === "") return options.fallback ?? 0;
  const parsed = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? 2_147_483_647;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function optionalInteger(value: unknown, label: string, max = 2_147_483_647): number | undefined {
  if (value === undefined || value === "") return undefined;
  return integer(value, label, { min: 0, max });
}

function pageQuery(query: Record<string, string>) {
  return {
    page: integer(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 }),
    limit: integer(query.limit, "每页数量", { fallback: 20, min: 1, max: MAX_LIMIT }),
  };
}

function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function maskIdentifier(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function maskCardCode(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function runtimeMeta() {
  return {
    catalog_authority: "postgresql_imported_history" as const,
    remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
    callback_authority: "disabled" as const,
    pii_display: "masked" as const,
  };
}

export class WechatMemberCardCatalogService {
  constructor(private readonly container: Container) {}

  async summary() {
    const [cards, activeCards, claims, activeClaims, activatedClaims, deletedClaims, legacyApplications] =
      await Promise.all([
        this.container.db.select({ value: count() }).from(wechatCard),
        this.container.db.select({ value: count() }).from(wechatCard)
          .where(and(eq(wechatCard.isDel, 0), eq(wechatCard.status, 1))),
        this.container.db.select({ value: count() }).from(userCard),
        this.container.db.select({ value: count() }).from(userCard).where(eq(userCard.isDel, 0)),
        this.container.db.select({ value: count() }).from(userCard)
          .where(and(eq(userCard.isDel, 0), eq(userCard.isSubmit, 1))),
        this.container.db.select({ value: count() }).from(userCard).where(eq(userCard.isDel, 1)),
        this.container.db.select({ value: count() }).from(userEnter),
      ]);
    return {
      cards: Number(cards[0]?.value ?? 0),
      active_cards: Number(activeCards[0]?.value ?? 0),
      claims: Number(claims[0]?.value ?? 0),
      active_claims: Number(activeClaims[0]?.value ?? 0),
      activated_claims: Number(activatedClaims[0]?.value ?? 0),
      deleted_claims: Number(deletedClaims[0]?.value ?? 0),
      legacy_applications: Number(legacyApplications[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async cards(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const search = (query.keyword ?? "").trim().slice(0, 100);
    const status = optionalInteger(query.status, "状态", 255);
    const isDel = optionalInteger(query.is_del, "删除状态", 1) ?? 0;
    const conditions: SQL[] = [eq(wechatCard.isDel, isDel)];
    if (status !== undefined) conditions.push(eq(wechatCard.status, status));
    if (search) {
      const pattern = like(search);
      conditions.push(or(
        ilike(wechatCard.brandName, pattern),
        ilike(wechatCard.title, pattern),
        ilike(wechatCard.cardType, pattern),
      )!);
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select({
          id: wechatCard.id,
          cardId: wechatCard.cardId,
          cardType: wechatCard.cardType,
          codeType: wechatCard.codeType,
          brandName: wechatCard.brandName,
          title: wechatCard.title,
          color: wechatCard.color,
          notice: wechatCard.notice,
          description: wechatCard.description,
          centerTitle: wechatCard.centerTitle,
          servicePhone: wechatCard.servicePhone,
          logoUrl: wechatCard.logoUrl,
          backgroundPicUrl: wechatCard.backgroundPicUrl,
          status: wechatCard.status,
          isDel: wechatCard.isDel,
          addTime: wechatCard.addTime,
        })
        .from(wechatCard)
        .where(where)
        .orderBy(desc(wechatCard.addTime), desc(wechatCard.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(wechatCard).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        remote_card_id_masked: maskIdentifier(row.cardId),
        card_type: row.cardType,
        code_type: row.codeType,
        brand_name: row.brandName,
        title: row.title,
        color: row.color,
        notice: row.notice,
        description: row.description,
        center_title: row.centerTitle,
        service_phone: row.servicePhone,
        logo_url: row.logoUrl,
        background_pic_url: row.backgroundPicUrl,
        status: row.status,
        is_del: row.isDel,
        add_time: row.addTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }

  async claims(query: Record<string, string>) {
    const { page, limit } = pageQuery(query);
    const isSubmit = optionalInteger(query.is_submit, "激活状态", 1);
    const isDel = optionalInteger(query.is_del, "删除状态", 1) ?? 0;
    const storeId = optionalInteger(query.store_id, "门店 ID");
    const staffId = optionalInteger(query.staff_id, "店员 ID");
    const uid = optionalInteger(query.uid, "用户 UID");
    const conditions: SQL[] = [eq(userCard.isDel, isDel)];
    if (isSubmit !== undefined) conditions.push(eq(userCard.isSubmit, isSubmit));
    if (storeId !== undefined) conditions.push(eq(userCard.storeId, storeId));
    if (staffId !== undefined) conditions.push(eq(userCard.staffId, staffId));
    if (uid !== undefined) conditions.push(eq(userCard.uid, uid));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select({
          id: userCard.id,
          uid: userCard.uid,
          spreadUid: userCard.spreadUid,
          wechatCardId: userCard.wechatCardId,
          cardId: userCard.cardId,
          code: userCard.code,
          storeId: userCard.storeId,
          staffId: userCard.staffId,
          openid: userCard.openid,
          isSubmit: userCard.isSubmit,
          submitTime: userCard.submitTime,
          isDel: userCard.isDel,
          delTime: userCard.delTime,
          addTime: userCard.addTime,
        })
        .from(userCard)
        .where(where)
        .orderBy(desc(userCard.addTime), desc(userCard.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(userCard).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        uid: row.uid,
        spread_uid: row.spreadUid,
        wechat_card_id: row.wechatCardId,
        remote_card_id_masked: maskIdentifier(row.cardId),
        code_masked: maskCardCode(row.code),
        store_id: row.storeId,
        staff_id: row.staffId,
        openid_masked: maskIdentifier(row.openid),
        is_submit: row.isSubmit,
        submit_time: row.submitTime,
        is_del: row.isDel,
        del_time: row.delTime,
        add_time: row.addTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      ...runtimeMeta(),
    };
  }
}
