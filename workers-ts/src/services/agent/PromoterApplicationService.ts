import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { agreement, promoterApply, user as userTable } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { cacheDelete, cacheGet } from "@/utils/cache";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PROMOTER_APPLY_LOCK_NAMESPACE = 505_601;

function positiveId(value: unknown, label = "ID"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException(`${label}错误`);
  return id;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}不能为空`);
  const text = value.trim();
  if (!text) throw new ValidateException(`${label}不能为空`);
  if ([...text].length > maxLength) {
    throw new ValidateException(`${label}过长`);
  }
  return text;
}

function enabled(value: string): boolean {
  return value === "1" || value.toLowerCase() === "true";
}

function formatEpoch(value: number): string {
  if (!value) return "";
  return new Date(value * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export interface PromoterApplicationInput {
  nickname?: unknown;
  real_name?: unknown;
  realName?: unknown;
  phone?: unknown;
  code?: unknown;
}

export class PromoterApplicationService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async applyInfo(uid: number) {
    const [users, applications, agreements] = await Promise.all([
      this.container.db
        .select({
          uid: userTable.uid,
          nickname: userTable.nickname,
          realName: userTable.realName,
          phone: userTable.phone,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1),
      this.container.db
        .select()
        .from(promoterApply)
        .where(and(eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)))
        .orderBy(desc(promoterApply.id))
        .limit(1),
      this.container.db
        .select()
        .from(agreement)
        .where(and(eq(agreement.type, 2), eq(agreement.status, 1)))
        .orderBy(desc(agreement.sort), desc(agreement.id))
        .limit(1),
    ]);
    const currentUser = users[0];
    if (!currentUser) throw new NotFoundException("用户不存在");
    const current = applications[0];
    return {
      user: {
        id: current?.id ?? 0,
        uid,
        nickname: currentUser.nickname,
        real_name: currentUser.realName,
        phone: currentUser.phone,
        status: current?.status ?? -1,
        add_time: formatEpoch(current?.addTime ?? 0),
        status_time: formatEpoch(current?.statusTime ?? 0),
        refusal_reason: current?.refusalReason ?? "",
      },
      agreement: agreements[0] ?? null,
    };
  }

  async submit(uid: number, idValue: unknown, input: PromoterApplicationInput): Promise<{ id: number }> {
    positiveId(uid, "用户ID");
    const id = Number(idValue ?? 0);
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("申请ID错误");
    const nickname = requiredText(input.nickname, "昵称", 255);
    const realName = requiredText(input.real_name ?? input.realName, "真实姓名", 255);
    const phone = requiredText(input.phone, "手机号", 32);
    if (!/^\+?[0-9]{6,15}$/.test(phone)) throw new ValidateException("手机号格式错误");
    const code = String(input.code ?? "").trim();
    if (!code) throw new ValidateException("验证码不能为空");

    const config = await new SystemConfigService(this.container, this.env).getMany([
      "brokerage_func_status",
      "store_brokerage_statu",
    ]);
    if (!enabled(config.brokerage_func_status ?? "")) {
      throw new ValidateException("未开启推广功能");
    }
    if (config.store_brokerage_statu !== "1") {
      throw new ValidateException("非指定分销模式无需申请推广员");
    }

    const cachedCode = await cacheGet<string | number>(`code_${phone}`, this.env);
    if (cachedCode === null || String(cachedCode) !== code) {
      throw new ValidateException("验证码错误");
    }

    const applicationId = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${uid})`);
      const users = await tx
        .select()
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .for("update")
        .limit(1);
      const currentUser = users[0];
      if (!currentUser) throw new NotFoundException("用户不存在");
      if (currentUser.isPromoter === 1) throw new ValidateException("您已经是推广员");

      if (phone !== currentUser.phone) {
        const phoneOwners = await tx
          .select({ uid: userTable.uid })
          .from(userTable)
          .where(and(eq(userTable.phone, phone), eq(userTable.isDel, 0), ne(userTable.uid, uid)))
          .limit(1);
        if (phoneOwners.length > 0) throw new ValidateException("该手机号已被使用");
      }

      const now = Math.floor(Date.now() / 1000);
      if (id > 0) {
        const rows = await tx
          .select({ id: promoterApply.id, uid: promoterApply.uid })
          .from(promoterApply)
          .where(and(eq(promoterApply.id, id), eq(promoterApply.isDel, 0)))
          .for("update")
          .limit(1);
        const existing = rows[0];
        if (!existing || existing.uid !== uid) throw new NotFoundException("申请不存在");
        await tx
          .update(promoterApply)
          .set({
            nickname,
            realName,
            phone,
            status: 0,
            statusTime: 0,
            refusalReason: "",
          })
          .where(and(eq(promoterApply.id, id), eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)));
        return id;
      }

      await tx
        .update(promoterApply)
        .set({ isDel: 1 })
        .where(and(eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)));
      const rows = await tx
        .insert(promoterApply)
        .values({ uid, nickname, realName, phone, addTime: now })
        .returning({ id: promoterApply.id });
      return rows[0].id;
    });

    await cacheDelete(`code_${phone}`, this.env);
    return { id: applicationId };
  }

  async list(query: Record<string, string>) {
    const page = Math.max(1, Math.min(1_000_000, Number.parseInt(query.page ?? "1", 10) || 1));
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? "15", 10) || 15));
    const keyword = (query.keyword ?? "").trim().slice(0, 100);
    const conditions = [eq(promoterApply.isDel, 0)];
    if (query.status !== undefined && query.status !== "" && query.status !== "all") {
      const status = Number(query.status);
      if (!Number.isInteger(status) || status < 0 || status > 2) {
        throw new ValidateException("申请状态错误");
      }
      conditions.push(eq(promoterApply.status, status));
    }
    if (keyword) {
      conditions.push(
        or(
          sql`CAST(${promoterApply.uid} AS TEXT) ILIKE ${`%${keyword}%`}`,
          ilike(promoterApply.nickname, `%${keyword}%`),
          ilike(promoterApply.realName, `%${keyword}%`),
          ilike(promoterApply.phone, `%${keyword}%`),
        )!,
      );
    }
    const where = and(...conditions)!;
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(promoterApply)
        .where(where)
        .orderBy(desc(promoterApply.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`count(*)` })
        .from(promoterApply)
        .where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        uid: row.uid,
        nickname: row.nickname,
        real_name: row.realName,
        phone: row.phone,
        status: row.status,
        add_time: formatEpoch(row.addTime),
        status_time: formatEpoch(row.statusTime),
        refusal_reason: row.refusalReason,
      })),
      count: Number(totals[0]?.count ?? 0),
    };
  }

  async examine(idValue: unknown, uidValue: unknown, statusValue: unknown, refusalReasonValue: unknown) {
    const id = positiveId(idValue, "申请ID");
    const uid = positiveId(uidValue, "用户ID");
    const status = Number(statusValue);
    if (status !== 1 && status !== 2) throw new ValidateException("审核状态错误");
    const refusalReason =
      status === 2 && refusalReasonValue !== undefined
        ? requiredText(refusalReasonValue, "拒绝原因", 1000)
        : "";

    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${uid})`);
      const rows = await tx
        .select()
        .from(promoterApply)
        .where(and(eq(promoterApply.id, id), eq(promoterApply.isDel, 0)))
        .for("update")
        .limit(1);
      const application = rows[0];
      if (!application || application.uid !== uid) throw new NotFoundException("申请不存在");

      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .for("update")
        .limit(1);
      if (!users[0]) throw new NotFoundException("用户不存在");

      await tx
        .update(promoterApply)
        .set({
          status,
          statusTime: Math.floor(Date.now() / 1000),
          refusalReason,
        })
        .where(and(eq(promoterApply.id, id), eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)));
      if (status === 1) {
        await tx.update(userTable).set({ isPromoter: 1 }).where(eq(userTable.uid, uid));
      }
    });
  }

  async delete(idValue: unknown): Promise<void> {
    const id = positiveId(idValue, "申请ID");
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${id})`);
      const rows = await tx
        .select({ id: promoterApply.id })
        .from(promoterApply)
        .where(and(eq(promoterApply.id, id), eq(promoterApply.isDel, 0)))
        .for("update")
        .limit(1);
      if (!rows[0]) throw new NotFoundException("申请不存在");
      await tx.update(promoterApply).set({ isDel: 1 }).where(eq(promoterApply.id, id));
    });
  }
}
