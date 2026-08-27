import { hash } from "bcryptjs";
import { and, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  systemAdmin,
  systemAttachment,
  systemSupplier,
  systemUserApply,
  user,
} from "@/models/schema";
import { SmsVerificationService } from "@/services/message/SmsVerificationService";
import {
  AttachmentService,
  parseCanonicalAttachmentId,
  R2_IMAGE_TYPE,
} from "@/services/system/AttachmentService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const SUPPLIER_APPLICATION_TYPE = 2;
const SUPPLIER_ADMIN_TYPE = 4;
const APPLICATION_LOCK_NAMESPACE = 505_607;
const APPLICATION_REVIEW_LOCK_NAMESPACE = 505_608;
const ACCOUNT_LOCK_KEY = 0;

function positiveId(value: unknown, label = "ID"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException(`${label}错误`);
  return id;
}

function optionalId(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("申请ID错误");
  return id;
}

function text(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}不能为空`);
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < min) throw new ValidateException(`${label}至少需要${min}个字符`);
  if (length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  return normalized;
}

function phoneNumber(value: unknown): string {
  const phone = String(value ?? "").trim();
  if (!/^1\d{10}$/.test(phone)) throw new ValidateException("手机号格式错误");
  return phone;
}

function imageReferences(value: unknown): string[] {
  let values: unknown = value;
  if (typeof value === "string") {
    try {
      values = JSON.parse(value);
    } catch {
      values = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 9) {
    throw new ValidateException("请提供1至9张资质图片");
  }
  const urls = values.map((item) => {
    if (typeof item !== "string") throw new ValidateException("资质图片地址格式错误");
    const url = item.trim();
    if (!url || url.length > 512 || /[\u0000-\u001f\u007f]/.test(url)) {
      throw new ValidateException("资质图片地址格式错误");
    }
    if (parseCanonicalAttachmentId(url)) return url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.toString();
    } catch {
      // The common validation error below intentionally hides URL parser detail.
    }
    throw new ValidateException("资质图片必须来自站内附件上传，历史 HTTPS 图片只能原样保留");
  });
  if (new Set(urls).size !== urls.length) throw new ValidateException("资质图片不能重复");
  if (JSON.stringify(urls).length > 2000) throw new ValidateException("资质图片地址总长度过长");
  return urls;
}

function parseImages(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function statusLabel(status: number): string {
  return status === 1 ? "已通过" : status === 2 ? "已拒绝" : "待审核";
}

function publicApplication(
  row: typeof systemUserApply.$inferSelect,
  images: string[],
  imageReferences: string[],
  account = "",
  active = false,
) {
  return {
    id: row.id,
    type: row.type,
    relation_id: row.relationId,
    uid: row.uid,
    phone: row.phone,
    system_name: row.systemName,
    name: row.name,
    images,
    image_refs: imageReferences,
    mark: row.mark,
    status: row.status,
    status_label: statusLabel(row.status),
    fail_msg: row.failMsg,
    status_time: row.statusTime,
    add_time: row.addTime,
    account,
    activation_required: row.status === 1 && !active,
    activated: row.status === 1 && active,
  };
}

export class SupplierApplicationService {
  private readonly sms: SmsVerificationService;
  private readonly attachments: AttachmentService;

  constructor(
    private readonly container: Container,
    env: Env,
  ) {
    this.sms = new SmsVerificationService(container, env);
    this.attachments = new AttachmentService(container, env);
  }

  async userList(uid: number, query: Record<string, string>) {
    positiveId(uid, "用户ID");
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(50, Number.parseInt(query.limit ?? "10", 10) || 10));
    const where = and(
      eq(systemUserApply.uid, uid),
      eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
      eq(systemUserApply.isDel, 0),
    );
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(systemUserApply).where(where)
        .orderBy(desc(systemUserApply.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` })
        .from(systemUserApply).where(where),
    ]);
    const identities = await this.identityMap(rows);
    return {
      list: await this.publicApplications(rows, identities),
      count: Number(totals[0]?.count ?? 0),
    };
  }

  async userDetail(uid: number, idValue: unknown) {
    const id = positiveId(idValue, "申请ID");
    const rows = await this.container.db.select().from(systemUserApply).where(and(
      eq(systemUserApply.id, id),
      eq(systemUserApply.uid, uid),
      eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
      eq(systemUserApply.isDel, 0),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("申请不存在");
    return (await this.publicApplications([row], await this.identityMap([row])))[0];
  }

  async assertCanRequestCode(uid: number, phoneValue: unknown, purposeValue: unknown, idValue: unknown) {
    const phone = phoneNumber(phoneValue);
    const purpose = String(purposeValue ?? "apply");
    if (purpose === "apply") return phone;
    if (purpose !== "activate") throw new ValidateException("验证码用途错误");
    const id = positiveId(idValue, "申请ID");
    const rows = await this.container.db.select({ phone: systemUserApply.phone })
      .from(systemUserApply).where(and(
        eq(systemUserApply.id, id),
        eq(systemUserApply.uid, uid),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.status, 1),
        eq(systemUserApply.isDel, 0),
      )).limit(1);
    if (!rows[0] || rows[0].phone !== phone) throw new NotFoundException("待激活申请不存在");
    return phone;
  }

  async submit(uid: number, idValue: unknown, input: Record<string, unknown>) {
    positiveId(uid, "用户ID");
    const id = optionalId(idValue);
    const phone = phoneNumber(input.phone);
    const systemName = text(input.system_name ?? input.systemName, "供应商名称", 4, 30);
    const name = text(input.name, "联系人", 2, 30);
    const requestedImages = imageReferences(input.images);
    await this.sms.verifySupplierCode(uid, phone, input.code);

    const applicationId = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLICATION_LOCK_NAMESPACE}, ${uid})`);
      const users = await tx.select({ uid: user.uid }).from(user).where(and(
        eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0),
      )).for("update").limit(1);
      if (!users[0]) throw new NotFoundException("用户不存在或已停用");

      const existingRows = await tx.select().from(systemUserApply).where(and(
        eq(systemUserApply.uid, uid),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.isDel, 0),
      )).orderBy(desc(systemUserApply.id)).for("update");
      if (existingRows.some((row) => row.status === 1 && row.id !== id)) {
        throw new ValidateException("供应商申请已通过，不能重复提交");
      }

      const editable = id > 0 ? existingRows.find((row) => row.id === id) : undefined;
      if (id > 0 && !editable) throw new NotFoundException("申请不存在");
      const legacyAllowed = new Set(
        (editable ? parseImages(editable.images) : []).filter(
          (reference) => parseCanonicalAttachmentId(reference) === null,
        ),
      );
      const attachmentIds = requestedImages
        .map((reference) => parseCanonicalAttachmentId(reference))
        .filter((attachmentId): attachmentId is number => attachmentId !== null);
      if (requestedImages.some(
        (reference) => parseCanonicalAttachmentId(reference) === null && !legacyAllowed.has(reference),
      )) {
        throw new ValidateException("新提交的资质图片必须通过站内附件上传");
      }
      if (attachmentIds.length > 0) {
        const ownedAttachments = await tx.select({ id: systemAttachment.attId })
          .from(systemAttachment).where(and(
            inArray(systemAttachment.attId, attachmentIds),
            eq(systemAttachment.type, 3),
            eq(systemAttachment.relationId, uid),
            eq(systemAttachment.moduleType, 3),
            eq(systemAttachment.fileType, 1),
            eq(systemAttachment.imageType, R2_IMAGE_TYPE),
          ));
        if (ownedAttachments.length !== attachmentIds.length) {
          throw new ValidateException("一个或多个资质附件不存在或不属于当前用户");
        }
      }
      const images = requestedImages;

      const now = nowEpoch();
      if (id > 0) {
        const existing = editable;
        if (!existing) throw new NotFoundException("申请不存在");
        if (existing.status === 1) throw new ValidateException("已通过的申请不能修改");
        await tx.update(systemUserApply).set({
          phone,
          systemName,
          name,
          images: JSON.stringify(images),
          status: 0,
          failMsg: "",
          statusTime: 0,
        }).where(and(
          eq(systemUserApply.id, id),
          eq(systemUserApply.uid, uid),
          eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
          eq(systemUserApply.isDel, 0),
        ));
        return id;
      }
      if (existingRows.some((row) => row.status === 0)) {
        throw new ValidateException("已有待审核申请，请勿重复提交");
      }
      const inserted = await tx.insert(systemUserApply).values({
        type: SUPPLIER_APPLICATION_TYPE,
        uid,
        phone,
        systemName,
        name,
        images: JSON.stringify(images),
        addTime: now,
      }).returning({ id: systemUserApply.id });
      return inserted[0].id;
    });
    await this.sms.consumeSupplierCode(phone);
    return { id: applicationId };
  }

  async activate(uid: number, idValue: unknown, input: Record<string, unknown>) {
    const id = positiveId(idValue, "申请ID");
    const password = text(input.password, "密码", 12, 72);
    const confirmation = String(input.password_confirmation ?? input.password_confirm ?? "");
    if (password !== confirmation) throw new ValidateException("两次输入的密码不一致");

    const preview = await this.container.db.select({ phone: systemUserApply.phone })
      .from(systemUserApply).where(and(
        eq(systemUserApply.id, id),
        eq(systemUserApply.uid, uid),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.status, 1),
        eq(systemUserApply.isDel, 0),
      )).limit(1);
    if (!preview[0]) throw new NotFoundException("待激活申请不存在");
    const phone = await this.sms.verifySupplierCode(uid, preview[0].phone, input.code);
    const passwordHash = await hash(password, 12);

    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLICATION_LOCK_NAMESPACE}, ${uid})`);
      const applications = await tx.select().from(systemUserApply).where(and(
        eq(systemUserApply.id, id),
        eq(systemUserApply.uid, uid),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.status, 1),
        eq(systemUserApply.isDel, 0),
      )).for("update").limit(1);
      const application = applications[0];
      if (!application || application.phone !== phone || application.relationId <= 0) {
        throw new NotFoundException("待激活申请不存在");
      }
      const suppliers = await tx.select({ adminId: systemSupplier.adminId })
        .from(systemSupplier).where(and(
          eq(systemSupplier.id, application.relationId),
          eq(systemSupplier.isDel, 0),
        )).for("update").limit(1);
      const supplier = suppliers[0];
      if (!supplier || supplier.adminId <= 0) throw new NotFoundException("供应商账号不存在");
      const admins = await tx.select({
        id: systemAdmin.id,
        account: systemAdmin.account,
        status: systemAdmin.status,
      })
        .from(systemAdmin).where(and(
          eq(systemAdmin.id, supplier.adminId),
          eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
          eq(systemAdmin.relationId, application.relationId),
          eq(systemAdmin.isDel, 0),
        )).for("update").limit(1);
      const admin = admins[0];
      if (!admin) throw new NotFoundException("供应商账号不存在");
      if (admin.status === 1) throw new ValidateException("供应商账号已经激活");
      await tx.update(systemAdmin).set({ pwd: passwordHash, status: 1 })
        .where(eq(systemAdmin.id, admin.id));
      return { account: admin.account, activated: true };
    });
    await this.sms.consumeSupplierCode(phone);
    return result;
  }

  async adminList(query: Record<string, string>) {
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? "15", 10) || 15));
    const conditions = [
      eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
      eq(systemUserApply.isDel, 0),
    ];
    if (query.status !== undefined && query.status !== "" && query.status !== "all") {
      const status = Number(query.status);
      if (![0, 1, 2].includes(status)) throw new ValidateException("审核状态错误");
      conditions.push(eq(systemUserApply.status, status));
    }
    const keyword = (query.keyword ?? "").trim().slice(0, 80);
    if (keyword) {
      conditions.push(or(
        ilike(systemUserApply.systemName, `%${keyword}%`),
        ilike(systemUserApply.name, `%${keyword}%`),
        ilike(systemUserApply.phone, `%${keyword}%`),
      )!);
    }
    const where = and(...conditions)!;
    const [rows, totals] = await Promise.all([
      this.container.db.select().from(systemUserApply).where(where)
        .orderBy(desc(systemUserApply.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`count(*)::int` })
        .from(systemUserApply).where(where),
    ]);
    const identities = await this.identityMap(rows);
    return {
      list: await this.publicApplications(rows, identities),
      count: Number(totals[0]?.count ?? 0),
    };
  }

  async adminDetail(idValue: unknown) {
    const id = positiveId(idValue, "申请ID");
    const rows = await this.container.db.select().from(systemUserApply).where(and(
      eq(systemUserApply.id, id),
      eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
      eq(systemUserApply.isDel, 0),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("申请不存在");
    return (await this.publicApplications(rows, await this.identityMap(rows)))[0];
  }

  async review(idValue: unknown, input: Record<string, unknown>) {
    const id = positiveId(idValue, "申请ID");
    const status = Number(input.status);
    if (status !== 1 && status !== 2) throw new ValidateException("审核状态错误");
    const failMsg = status === 2 ? text(input.fail_msg ?? input.failMsg, "拒绝原因", 2, 255) : "";
    const bootstrap = status === 1
      ? await hash(crypto.randomUUID() + crypto.randomUUID(), 12)
      : "";

    return withTx(this.container, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${APPLICATION_REVIEW_LOCK_NAMESPACE}, ${id})`,
      );
      const rows = await tx.select().from(systemUserApply).where(and(
        eq(systemUserApply.id, id),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.isDel, 0),
      )).for("update").limit(1);
      const application = rows[0];
      if (!application) throw new NotFoundException("申请不存在");
      if (application.status !== 0) throw new ValidateException("该申请已经审核，不能重复操作");
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${APPLICATION_LOCK_NAMESPACE}, ${application.uid})`,
      );
      const approved = await tx.select({ id: systemUserApply.id }).from(systemUserApply).where(and(
        eq(systemUserApply.uid, application.uid),
        eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
        eq(systemUserApply.status, 1),
        eq(systemUserApply.isDel, 0),
        ne(systemUserApply.id, id),
      )).limit(1);
      if (approved[0]) throw new ValidateException("该用户已有审核通过的供应商申请");
      const now = nowEpoch();
      if (status === 2) {
        await tx.update(systemUserApply).set({ status: 2, failMsg, statusTime: now })
          .where(eq(systemUserApply.id, id));
        return { id, status: 2 };
      }

      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLICATION_LOCK_NAMESPACE}, ${ACCOUNT_LOCK_KEY})`);
      const candidates = await tx.select({ account: systemAdmin.account })
        .from(systemAdmin).where(or(
          eq(systemAdmin.account, application.phone),
          ilike(systemAdmin.account, `${application.phone}_%`),
        ));
      const occupied = new Set(candidates.map((row) => row.account.toLowerCase()));
      let account = application.phone;
      for (let suffix = 1; occupied.has(account.toLowerCase()); suffix += 1) {
        account = `${application.phone}_${suffix}`;
        if (account.length > 32 || suffix > 100_000) throw new ValidateException("供应商账号分配失败");
      }
      const supplierRows = await tx.insert(systemSupplier).values({
        supplierName: application.systemName,
        name: application.name,
        phone: application.phone,
        mark: "由供应商入驻申请创建，待申请人短信激活账号",
        addTime: now,
        isShow: 1,
      }).returning({ id: systemSupplier.id });
      const supplierId = supplierRows[0].id;
      const adminRows = await tx.insert(systemAdmin).values({
        account,
        adminType: SUPPLIER_ADMIN_TYPE,
        relationId: supplierId,
        pwd: bootstrap,
        realName: [...application.name].slice(0, 16).join(""),
        phone: application.phone,
        level: 1,
        status: 0,
        addTime: now,
      }).returning({ id: systemAdmin.id });
      await tx.update(systemSupplier).set({ adminId: adminRows[0].id })
        .where(eq(systemSupplier.id, supplierId));
      await tx.update(systemUserApply).set({
        status: 1,
        failMsg: "",
        statusTime: now,
        relationId: supplierId,
      }).where(eq(systemUserApply.id, id));
      return { id, status: 1, account, activation_required: true };
    });
  }

  async mark(idValue: unknown, markValue: unknown) {
    const id = positiveId(idValue, "申请ID");
    const mark = typeof markValue === "string" ? markValue.trim() : "";
    if ([...mark].length > 255) throw new ValidateException("备注不能超过255个字符");
    const updated = await this.container.db.update(systemUserApply).set({ mark }).where(and(
      eq(systemUserApply.id, id),
      eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
      eq(systemUserApply.isDel, 0),
    )).returning({ id: systemUserApply.id });
    if (!updated[0]) throw new NotFoundException("申请不存在");
    return { id, mark };
  }

  async delete(idValue: unknown) {
    const id = positiveId(idValue, "申请ID");
    return withTx(this.container, async (tx) => {
      const rows = await tx.select({ status: systemUserApply.status }).from(systemUserApply)
        .where(and(
          eq(systemUserApply.id, id),
          eq(systemUserApply.type, SUPPLIER_APPLICATION_TYPE),
          eq(systemUserApply.isDel, 0),
        )).for("update").limit(1);
      if (!rows[0]) throw new NotFoundException("申请不存在");
      if (rows[0].status === 1) throw new ValidateException("已创建供应商身份的申请不能删除");
      await tx.update(systemUserApply).set({ isDel: 1 }).where(eq(systemUserApply.id, id));
      return { id };
    });
  }

  private async identityMap(rows: Array<typeof systemUserApply.$inferSelect>) {
    const relationIds = [...new Set(rows.map((row) => row.relationId).filter((id) => id > 0))];
    const result = new Map<number, { account: string; active: boolean }>();
    if (!relationIds.length) return result;
    const admins = await this.container.db.select({
      id: systemAdmin.id,
      relationId: systemAdmin.relationId,
      account: systemAdmin.account,
      status: systemAdmin.status,
    }).from(systemAdmin).where(and(
      inArray(systemAdmin.relationId, relationIds),
      eq(systemAdmin.adminType, SUPPLIER_ADMIN_TYPE),
      eq(systemAdmin.isDel, 0),
    )).orderBy(desc(systemAdmin.id));
    for (const admin of admins) {
      if (!result.has(admin.relationId)) result.set(admin.relationId, {
        account: admin.account,
        active: admin.status === 1,
      });
    }
    return result;
  }

  private async publicApplications(
    rows: Array<typeof systemUserApply.$inferSelect>,
    identities: Map<number, { account: string; active: boolean }>,
  ) {
    return Promise.all(rows.map(async (row) => {
      const references = parseImages(row.images);
      const images = await this.attachments.signReferences(references);
      const identity = identities.get(row.relationId);
      return publicApplication(row, images, references, identity?.account, identity?.active);
    }));
  }
}
