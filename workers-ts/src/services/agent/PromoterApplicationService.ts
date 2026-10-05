import { and, asc, desc, eq, getTableColumns, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { agreement, promoterApply, systemLog, user as userTable } from "@/models/schema";
import { sanitizePublishedArticleHtml } from "@/services/content/ArticleContentPolicy";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PROMOTER_APPLY_LOCK_NAMESPACE = 505_601;

function positiveId(value: unknown, label = "ID"): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException(`${label}错误`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException(`${label}错误`);
  return id;
}

const activeUser = (uid: number) => and(eq(userTable.uid, uid), eq(userTable.isDel, 0),
  isNull(userTable.deleteTime), eq(userTable.status, 1));

export interface PromoterApplicationAdminActor {
  id: number;
  method: "POST" | "GET" | "DELETE";
}

function adminActor(actor: PromoterApplicationAdminActor, methods: readonly string[]) {
  positiveId(actor?.id, "管理员ID");
  if (!methods.includes(actor.method)) throw new ValidateException("审核操作方式错误");
}

async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT set_config('statement_timeout',
    LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true)`);
}

// xmin distinguishes a resubmission even when all material and timestamps are
// unchanged within a second. Clients receive a hash, never transaction IDs/PII.
const applicationColumns = { ...getTableColumns(promoterApply), version: sql<string>`xmin::text` };
type ApplicationRow = typeof promoterApply.$inferSelect & { version: string };

async function revision(row: ApplicationRow): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(row)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function expectedRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException("申请版本无效，请刷新后重新确认");
  return value;
}

function auditAction(id: number, uid: number, previous: number, status: number,
  before: string, after: string, deleted: boolean) {
  return `${deleted ? 'delete' : 'review'};id=${id};uid=${uid};status=${previous}->${status};from=${before};to=${after}`;
}

async function audit(tx: DbClient, actor: PromoterApplicationAdminActor, action: string, deleted = false) {
  await tx.insert(systemLog).values({ adminId: actor.id, method: actor.method,
    path: deleted ? "/promoter/apply/del" : "/promoter/apply/examine", type: "promoter_application",
    action,
    addTime: Math.floor(Date.now() / 1000) });
}

async function recordedReplay(tx: DbClient, action: string) {
  const rows = await tx.select({ id: systemLog.id }).from(systemLog)
    .where(and(eq(systemLog.type, "promoter_application"), eq(systemLog.action, action))).limit(1);
  return rows.length > 0;
}

export function parsePromoterApplicationListQuery(query: URLSearchParams) {
  const allowed = new Set(["page", "limit", "keyword", "status"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ValidateException("不支持或重复的申请查询参数");
  }
  const page = query.has("page") ? positiveId(query.get("page"), "页码") : 1;
  const limit = query.has("limit") ? positiveId(query.get("limit"), "每页数量") : 15;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException("申请分页超出范围");
  // The old clearable status select sends an empty string for "all".
  const status = query.get("status") || "all";
  if (!["all", "0", "1", "2"].includes(status)) throw new ValidateException("申请状态错误");
  const raw = query.get("keyword") ?? "";
  if (raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) throw new ValidateException("申请查询关键词错误");
  const keyword = raw.trim();
  if ([...keyword].length > 100) throw new ValidateException("申请查询关键词过长");
  return { page, limit, offset, status, keyword };
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

function assertActivePromoterAgreement(row: { status: number; content: string | null } | undefined): void {
  if (!row || row.status !== 1 || !row.content?.trim()) {
    throw new ValidateException("分销说明尚未启用");
  }
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
        .where(activeUser(uid))
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
        .where(eq(agreement.type, 2))
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
      agreement: agreements[0]?.status === 1 && agreements[0].content?.trim()
        ? { ...agreements[0], content: sanitizePublishedArticleHtml(agreements[0].content) } : null,
    };
  }

  async submit(uid: number, idValue: unknown, input: PromoterApplicationInput): Promise<{ id: number }> {
    positiveId(uid, "用户ID");
    const id = idValue === undefined || idValue === 0 || idValue === "0" ? 0 : positiveId(idValue, "申请ID");
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

    // Catch normal account, phone and stale-link errors before spending the SMS code.
    // The locked transaction below repeats every check because this read can race.
    const [userRows, applicationRows, agreements] = await Promise.all([
      this.container.db.select({ phone: userTable.phone, isPromoter: userTable.isPromoter })
        .from(userTable).where(activeUser(uid)).limit(1),
      id > 0
        ? this.container.db.select({ id: promoterApply.id, uid: promoterApply.uid })
          .from(promoterApply).where(and(eq(promoterApply.id, id), eq(promoterApply.isDel, 0))).limit(1)
        : Promise.resolve([]),
      this.container.db.select({ status: agreement.status, content: agreement.content }).from(agreement)
        .where(eq(agreement.type, 2)).orderBy(desc(agreement.sort), desc(agreement.id)).limit(1),
    ]);
    const currentUser = userRows[0];
    if (!currentUser) throw new NotFoundException("用户不存在");
    if (currentUser.isPromoter === 1) throw new ValidateException("您已经是推广员");
    if (id > 0 && (!applicationRows[0] || applicationRows[0].uid !== uid)) {
      throw new NotFoundException("申请不存在");
    }
    assertActivePromoterAgreement(agreements[0]);
    if (phone !== currentUser.phone) {
      const phoneOwners = await this.container.db.select({ uid: userTable.uid }).from(userTable)
        .where(and(eq(userTable.phone, phone), eq(userTable.isDel, 0), isNull(userTable.deleteTime), ne(userTable.uid, uid))).limit(1);
      if (phoneOwners.length > 0) throw new ValidateException("该手机号已被使用");
    }

    await new SmsVerificationService(this.container, this.env)
      .consumeUserCode("user_promoter_application", phone, code);

    const applicationId = await withTx(this.container, async (tx) => {
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${uid})`);
      // Admin examine also locks application before user under this advisory key.
      const lockedApplications = await tx.select({ id: promoterApply.id, uid: promoterApply.uid })
        .from(promoterApply).where(and(eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)))
        .orderBy(asc(promoterApply.id)).for("update");
      if (id > 0 && !lockedApplications.some((row) => row.id === id)) throw new NotFoundException("申请不存在");
      const users = await tx
        .select()
        .from(userTable)
        .where(activeUser(uid))
        .for("update")
        .limit(1);
      const currentUser = users[0];
      if (!currentUser) throw new NotFoundException("用户不存在");
      if (currentUser.isPromoter === 1) throw new ValidateException("您已经是推广员");

      if (phone !== currentUser.phone) {
        const phoneOwners = await tx
          .select({ uid: userTable.uid })
          .from(userTable)
          .where(and(eq(userTable.phone, phone), eq(userTable.isDel, 0), isNull(userTable.deleteTime), ne(userTable.uid, uid)))
          .limit(1);
        if (phoneOwners.length > 0) throw new ValidateException("该手机号已被使用");
      }
      const agreements = await tx.select({ status: agreement.status, content: agreement.content })
        .from(agreement).where(eq(agreement.type, 2))
        .orderBy(desc(agreement.sort), desc(agreement.id)).limit(1);
      assertActivePromoterAgreement(agreements[0]);

      const now = Math.floor(Date.now() / 1000);
      if (id > 0) {
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

    return { id: applicationId };
  }

  async list(raw: URLSearchParams) {
    const query = parsePromoterApplicationListQuery(raw);
    const conditions = [eq(promoterApply.isDel, 0)];
    if (query.status !== "all") conditions.push(eq(promoterApply.status, Number(query.status)));
    if (query.keyword) {
      const pattern = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(
        or(
          sql`CAST(${promoterApply.uid} AS TEXT) ILIKE ${pattern}`,
          ilike(promoterApply.nickname, pattern),
          ilike(promoterApply.realName, pattern),
          ilike(promoterApply.phone, pattern),
        )!,
      );
    }
    const where = and(...conditions)!;
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await deadlines(tx);
      const rows = await tx
        .select(applicationColumns)
        .from(promoterApply)
        .where(where)
        .orderBy(desc(promoterApply.id))
        .limit(query.limit)
        .offset(query.offset);
      const totals = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(promoterApply)
        .where(where);
      return {
        list: await Promise.all(rows.map(async (row) => ({
          id: row.id,
          uid: row.uid,
          nickname: row.nickname,
          real_name: row.realName,
          phone: row.phone,
          status: row.status,
          add_time: formatEpoch(row.addTime),
          status_time: formatEpoch(row.statusTime),
          refusal_reason: row.refusalReason,
          revision: await revision(row),
        }))),
        count: Number(totals[0]?.count ?? 0),
        page: query.page,
        limit: query.limit,
      };
    });
  }

  async examine(idValue: unknown, uidValue: unknown, statusValue: unknown, refusalReasonValue: unknown,
    actor: PromoterApplicationAdminActor, revisionValue?: unknown) {
    const id = positiveId(idValue, "申请ID");
    const uid = positiveId(uidValue, "用户ID");
    adminActor(actor, ["GET", "POST"]);
    if (statusValue !== "1" && statusValue !== "2" && statusValue !== 1 && statusValue !== 2) throw new ValidateException("审核状态错误");
    const status = Number(statusValue);
    const expected = actor.method === "POST" ? expectedRevision(revisionValue) : null;
    const refusalReason = status === 2 && !(actor.method === "GET" && refusalReasonValue === undefined)
      ? requiredText(refusalReasonValue, "拒绝原因", 1000) : "";
    if (status === 1 && refusalReasonValue !== undefined) throw new ValidateException("审核通过不接受拒绝原因");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(refusalReason)) throw new ValidateException("拒绝原因包含无效字符");

    await withTx(this.container, async (tx) => {
      await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${uid})`);
      const rows = await tx
        .select(applicationColumns)
        .from(promoterApply)
        .where(and(eq(promoterApply.id, id), eq(promoterApply.isDel, 0)))
        .for("update")
        .limit(1);
      const application = rows[0];
      if (!application || application.uid !== uid) throw new NotFoundException("申请不存在");
      const currentRevision = await revision(application);
      const sameDecision = application.status === status && application.refusalReason === refusalReason;
      if (expected !== null && expected !== currentRevision) {
        if (sameDecision && await recordedReplay(tx,
          auditAction(id, uid, 0, status, expected, currentRevision, false))) return;
        throw new ValidateException("申请已更新，请刷新后重新确认");
      }
      if (application.status !== 0) {
        if (sameDecision) return;
        throw new ValidateException("申请已审核，不能更改审核结果");
      }

      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(activeUser(uid))
        .for("update")
        .limit(1);
      if (!users[0]) throw new NotFoundException("用户不存在");

      const updated = await tx
        .update(promoterApply)
        .set({
          status,
          statusTime: Math.floor(Date.now() / 1000),
          refusalReason,
        })
        .where(and(eq(promoterApply.id, id), eq(promoterApply.uid, uid), eq(promoterApply.isDel, 0)))
        .returning(applicationColumns);
      if (status === 1) {
        await tx.update(userTable).set({ isPromoter: 1 }).where(eq(userTable.uid, uid));
      }
      await audit(tx, actor, auditAction(id, uid, 0, status, currentRevision, await revision(updated[0]), false));
    });
  }

  async delete(idValue: unknown, actor: PromoterApplicationAdminActor, revisionValue: unknown): Promise<void> {
    const id = positiveId(idValue, "申请ID");
    adminActor(actor, ["DELETE"]);
    const expected = revisionValue === null ? null : expectedRevision(revisionValue);
    await withTx(this.container, async (tx) => {
      await deadlines(tx);
      // Resolve the owner without locking; then take the exact applicant key used
      // by submit/examine before the row lock, and recheck identity under it.
      const [owner] = await tx.select({ uid: promoterApply.uid }).from(promoterApply).where(eq(promoterApply.id, id)).limit(1);
      if (!owner) throw new NotFoundException("申请不存在");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PROMOTER_APPLY_LOCK_NAMESPACE}, ${owner.uid})`);
      const rows = await tx
        .select(applicationColumns)
        .from(promoterApply)
        .where(and(eq(promoterApply.id, id), eq(promoterApply.uid, owner.uid)))
        .for("update")
        .limit(1);
      const application = rows[0];
      if (!application) throw new NotFoundException("申请不存在");
      const currentRevision = await revision(application);
      if (expected !== null && expected !== currentRevision) {
        if (application.isDel === 1 && await recordedReplay(tx,
          auditAction(id, owner.uid, application.status, application.status, expected, currentRevision, true))) return;
        throw new ValidateException("申请已更新，请刷新后重新确认");
      }
      if (application.isDel === 1) return;
      const [updated] = await tx.update(promoterApply).set({ isDel: 1 }).where(eq(promoterApply.id, id))
        .returning(applicationColumns);
      await audit(tx, actor, auditAction(id, owner.uid, application.status, application.status,
        currentRevision, await revision(updated), true), true);
    });
  }
}
