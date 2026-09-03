import {
  and,
  desc,
  eq,
  ilike,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { printDocument, systemLog, type PrintDocument } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_REQUEST_KEYS = 24;
const PRINT_DOCUMENT_WRITE_LOCK = 8_214_005;

const DOCUMENT_KEYS = new Set([
  "print_name", "printName", "type",
  "yly_user_id", "ylyUserId", "yly_app_id", "ylyAppId",
  "yly_app_secret", "ylyAppSecret", "yly_sn", "ylySn",
  "fey_user", "feyUser", "fey_ukey", "feyUkey", "fey_sn", "feySn",
  "times", "print_type", "printType", "status",
]);

const CONTENT_KEYS = new Set([
  "header", "delivery", "buyer_remarks", "buyerRemarks", "goods", "freight",
  "preferential", "pay", "custom", "order", "code", "code_url", "codeUrl",
  "show_notice", "showNotice", "notice_content", "noticeContent",
]);

export interface PrintDocumentOwner {
  /** 0 is the platform scope; positive values are authenticated suppliers. */
  supplierId: number;
}

export interface PrintDocumentActor extends PrintDocumentOwner {
  actorType: "admin" | "supplier";
  actorId: number;
  actorName: string;
  ip: string;
}

export interface PrintContent {
  header: number;
  delivery: number;
  buyer_remarks: number;
  goods: number[];
  freight: number;
  preferential: number;
  pay: number[];
  custom: number;
  order: number[];
  code: number;
  code_url: string;
  show_notice: number;
  notice_content: string;
}

export const DEFAULT_PRINT_CONTENT: Readonly<PrintContent> = {
  header: 1,
  delivery: 1,
  buyer_remarks: 1,
  goods: [0],
  freight: 1,
  preferential: 1,
  pay: [0, 1],
  custom: 0,
  order: [0, 1, 2, 3],
  code: 0,
  code_url: "",
  show_notice: 0,
  notice_content: "",
};

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function sourceValue(body: Record<string, unknown>, snake: string, camel?: string): unknown {
  if (Object.prototype.hasOwnProperty.call(body, snake)) return body[snake];
  if (camel && Object.prototype.hasOwnProperty.call(body, camel)) return body[camel];
  return undefined;
}

function assertAllowlist(body: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(body).length > MAX_REQUEST_KEYS) throw new ValidateException("请求字段过多");
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw new ValidateException(`不支持的字段：${unknown}`);
}

function boundedText(
  value: unknown,
  label: string,
  maxLength: number,
  fallback = "",
  required = false,
): string {
  if (value === undefined || value === null) value = fallback;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim();
  if (required && !normalized) throw new ValidateException(`请填写${label}`);
  if (normalized.length > maxLength) {
    throw new ValidateException(`${label}不能超过${maxLength}个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidateException(`${label}包含非法控制字符`);
  }
  return normalized;
}

function integer(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${label}必须是${min}到${max}之间的整数`);
  }
  return parsed;
}

function binary(value: unknown, label: string, fallback: number): number {
  if (value === true) return 1;
  if (value === false) return 0;
  return integer(value, label, fallback, 0, 1);
}

function integerSet(value: unknown, label: string, allowed: readonly number[]): number[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 16) throw new ValidateException(`${label}选项过多`);
  const normalized = values.map((entry) => {
    const parsed = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isSafeInteger(parsed) || !allowed.includes(parsed)) {
      throw new ValidateException(`${label}包含无效选项`);
    }
    return parsed;
  });
  const unique = [...new Set(normalized)];
  if (unique.length > allowed.length) throw new ValidateException(`${label}选项过多`);
  return unique.sort((a, b) => a - b);
}

function scopeSupplierId(owner: PrintDocumentOwner): number {
  if (!Number.isSafeInteger(owner.supplierId) || owner.supplierId < 0) {
    throw new ValidateException("打印配置租户范围错误");
  }
  return owner.supplierId;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("打印机ID错误");
  return value;
}

function queryInteger(value: string | undefined, label: string, fallback: number, min: number, max: number) {
  return integer(value, label, fallback, min, max);
}

function pagination(query: Record<string, string>) {
  const page = queryInteger(query.page, "页码", 1, 1, MAX_PAGE);
  const limit = queryInteger(query.limit, "每页数量", 20, 1, MAX_PAGE_SIZE);
  return { page, limit, offset: (page - 1) * limit };
}

function secretValue(input: unknown, existing: string): string {
  if (input === undefined || input === null) return existing;
  const value = boundedText(input, "打印平台密钥", 255);
  return value || existing;
}

export interface NormalizedPrintDocumentInput {
  type: number;
  printName: string;
  ylyUserId: string;
  ylyAppId: string;
  ylyAppSecret: string;
  ylySn: string;
  feyUser: string;
  feyUkey: string;
  feySn: string;
  times: number;
  printType: number;
  status: number;
}

export function normalizePrintDocumentInput(
  input: unknown,
  existing?: PrintDocument,
): NormalizedPrintDocumentInput {
  const body = objectValue(input);
  assertAllowlist(body, DOCUMENT_KEYS);
  const type = integer(sourceValue(body, "type"), "打印平台", existing?.type ?? 1, 1, 2);
  const printName = boundedText(
    sourceValue(body, "print_name", "printName"),
    "打印机名称",
    255,
    existing?.printName ?? "",
    true,
  );
  const normalized = {
    type,
    printName,
    ylyUserId: boundedText(
      sourceValue(body, "yly_user_id", "ylyUserId"),
      "易联云用户ID",
      255,
      existing?.ylyUserId ?? "",
    ),
    ylyAppId: boundedText(
      sourceValue(body, "yly_app_id", "ylyAppId"),
      "易联云应用ID",
      255,
      existing?.ylyAppId ?? "",
    ),
    ylyAppSecret: secretValue(
      sourceValue(body, "yly_app_secret", "ylyAppSecret"),
      existing?.ylyAppSecret ?? "",
    ),
    ylySn: boundedText(
      sourceValue(body, "yly_sn", "ylySn"),
      "易联云终端号",
      255,
      existing?.ylySn ?? "",
    ),
    feyUser: boundedText(
      sourceValue(body, "fey_user", "feyUser"),
      "飞鹅云账号",
      255,
      existing?.feyUser ?? "",
    ),
    feyUkey: secretValue(
      sourceValue(body, "fey_ukey", "feyUkey"),
      existing?.feyUkey ?? "",
    ),
    feySn: boundedText(
      sourceValue(body, "fey_sn", "feySn"),
      "飞鹅云打印机SN",
      255,
      existing?.feySn ?? "",
    ),
    times: integer(sourceValue(body, "times"), "打印联数", existing?.times ?? 1, 0, 10),
    printType: integer(
      sourceValue(body, "print_type", "printType"),
      "打印时机",
      existing?.printType ?? 1,
      1,
      2,
    ),
    status: binary(sourceValue(body, "status"), "打印开关", existing?.status ?? 0),
  };
  if (normalized.status === 1) assertProviderReady(normalized);
  return normalized;
}

export function normalizePrintContent(input: unknown): PrintContent {
  const body = objectValue(input);
  assertAllowlist(body, CONTENT_KEYS);
  const codeUrl = boundedText(
    sourceValue(body, "code_url", "codeUrl"),
    "二维码路径",
    512,
  );
  if (codeUrl && (!codeUrl.startsWith("/") || codeUrl.startsWith("//"))) {
    throw new ValidateException("二维码路径必须是站内绝对路径");
  }
  const noticeContent = boundedText(
    sourceValue(body, "notice_content", "noticeContent"),
    "小票提示语",
    50,
  );
  if (/[<>&]/.test(noticeContent)) throw new ValidateException("小票提示语不能包含打印控制标记");
  const content = {
    header: binary(sourceValue(body, "header"), "小票标题", 0),
    delivery: binary(sourceValue(body, "delivery"), "配送信息", 0),
    buyer_remarks: binary(sourceValue(body, "buyer_remarks", "buyerRemarks"), "买家备注", 0),
    goods: integerSet(sourceValue(body, "goods"), "商品信息", [0, 1]),
    freight: binary(sourceValue(body, "freight"), "运费信息", 0),
    preferential: binary(sourceValue(body, "preferential"), "优惠信息", 0),
    pay: integerSet(sourceValue(body, "pay"), "支付信息", [0, 1]),
    custom: binary(sourceValue(body, "custom"), "自定义内容", 0),
    order: integerSet(sourceValue(body, "order"), "订单信息", [0, 1, 2, 3]),
    code: binary(sourceValue(body, "code"), "二维码", 0),
    code_url: codeUrl,
    show_notice: binary(sourceValue(body, "show_notice", "showNotice"), "提示语", 0),
    notice_content: noticeContent,
  };
  if (content.goods.includes(1) && !content.goods.includes(0)) {
    throw new ValidateException("启用规格编码前必须启用商品明细");
  }
  if (content.code === 1 && !content.code_url) {
    throw new ValidateException("启用二维码时必须选择站内路径");
  }
  if (content.show_notice === 1 && !content.notice_content) {
    throw new ValidateException("启用底部提示时必须填写提示语");
  }
  return content;
}

function parseStoredContent(value: string | null): {
  configured: boolean;
  valid: boolean;
  content: PrintContent | null;
} {
  if (!value) return { configured: false, valid: true, content: null };
  try {
    return { configured: true, valid: true, content: normalizePrintContent(JSON.parse(value)) };
  } catch {
    return { configured: true, valid: false, content: null };
  }
}

function assertProviderReady(document: Pick<
  NormalizedPrintDocumentInput,
  "type" | "times" | "ylyUserId" | "ylyAppId" | "ylyAppSecret" | "ylySn" |
  "feyUser" | "feyUkey" | "feySn"
>): void {
  if (document.times < 1) throw new ValidateException("启用打印前请设置至少1联");
  if (document.type === 1) {
    if (!document.ylyUserId || !document.ylyAppId || !document.ylyAppSecret || !document.ylySn) {
      throw new ValidateException("启用易联云前请完整填写用户ID、应用ID、应用密钥和终端号");
    }
    return;
  }
  if (document.type !== 2) throw new ValidateException("打印平台类型无效");
  if (!document.feyUser || !document.feyUkey || !document.feySn) {
    throw new ValidateException("启用飞鹅云前请完整填写账号、UKEY和打印机SN");
  }
}

export function printDocumentReadiness(document: PrintDocument) {
  const parsed = parseStoredContent(document.printContent);
  let providerReady = true;
  try {
    assertProviderReady(document);
  } catch {
    providerReady = false;
  }
  return {
    provider_ready: providerReady,
    content_configured: parsed.configured,
    content_valid: parsed.valid,
    ready: providerReady && parsed.configured && parsed.valid,
  };
}

export function buildPrintDocumentView(document: PrintDocument) {
  return {
    id: document.id,
    type: document.type,
    supplier_id: document.supplierId,
    print_name: document.printName,
    yly_user_id: document.ylyUserId,
    yly_app_id: document.ylyAppId,
    yly_app_secret: "",
    yly_app_secret_configured: document.ylyAppSecret.length > 0,
    yly_sn: document.ylySn,
    fey_user: document.feyUser,
    fey_ukey: "",
    fey_ukey_configured: document.feyUkey.length > 0,
    fey_sn: document.feySn,
    times: document.times,
    print_type: document.printType,
    add_time: document.addTime,
    status: document.status,
    is_del: document.isDel,
    ...printDocumentReadiness(document),
  };
}

function emptyDocument(supplierId: number): PrintDocument {
  return {
    id: 0,
    type: 1,
    supplierId,
    printName: "",
    ylyUserId: "",
    ylyAppId: "",
    ylyAppSecret: "",
    ylySn: "",
    feyUser: "",
    feyUkey: "",
    feySn: "",
    times: 1,
    printType: 1,
    printContent: null,
    addTime: 0,
    status: 0,
    isDel: 0,
  };
}

async function scopedDocument(
  db: DbClient,
  supplierId: number,
  id: number,
  lock = false,
): Promise<PrintDocument> {
  let query = db.select().from(printDocument).where(and(
    eq(printDocument.id, positiveId(id)),
    eq(printDocument.supplierId, supplierId),
    eq(printDocument.isDel, 0),
  ));
  const rows = lock ? await query.for("update") : await query;
  if (!rows[0]) throw new NotFoundException("打印机不存在");
  return rows[0];
}

function assertWriteActor(actor: PrintDocumentActor): void {
  scopeSupplierId(actor);
  if (!Number.isSafeInteger(actor.actorId) || actor.actorId <= 0) {
    throw new ValidateException("打印配置操作身份无效");
  }
  if (actor.actorType === "admin" && actor.supplierId !== 0) {
    throw new ValidateException("平台打印配置作用域无效");
  }
  if (actor.actorType === "supplier" && actor.supplierId <= 0) {
    throw new ValidateException("供应商打印配置作用域无效");
  }
}

async function configureWriteTx(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
}

async function writeAudit(
  tx: DbClient,
  actor: PrintDocumentActor,
  method: "POST" | "PUT" | "DELETE",
  operation: string,
  id: number,
): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.actorId,
    adminName: actor.actorName.slice(0, 64),
    path: `${actor.actorType === "admin" ? "/adminapi" : "/supplierapi"}/print/${operation}/${id}`,
    page: actor.actorType === "admin" ? "/setting/print" : "/print",
    method,
    action: `print_document.${operation};id=${id};supplier_id=${actor.supplierId}`,
    ip: actor.ip.slice(0, 45),
    type: actor.actorType === "admin" ? "admin_print" : "supplier_print",
    addTime: Math.floor(Date.now() / 1_000),
  });
}

function assertDocumentReadback(
  row: PrintDocument,
  expected: NormalizedPrintDocumentInput,
): void {
  if (
    row.type !== expected.type ||
    row.printName !== expected.printName ||
    row.ylyUserId !== expected.ylyUserId ||
    row.ylyAppId !== expected.ylyAppId ||
    row.ylyAppSecret !== expected.ylyAppSecret ||
    row.ylySn !== expected.ylySn ||
    row.feyUser !== expected.feyUser ||
    row.feyUkey !== expected.feyUkey ||
    row.feySn !== expected.feySn ||
    row.times !== expected.times ||
    row.printType !== expected.printType ||
    row.status !== expected.status
  ) {
    throw new Error("打印机配置回读不一致");
  }
}

export class PrintDocumentManagementService {
  constructor(private readonly container: Container) {}

  async list(owner: PrintDocumentOwner, query: Record<string, string>) {
    const supplierId = scopeSupplierId(owner);
    const { page, limit, offset } = pagination(query);
    const conditions: SQL[] = [
      eq(printDocument.supplierId, supplierId),
      eq(printDocument.isDel, 0),
    ];
    const keyword = boundedText(query.keyword, "关键词", 100);
    if (keyword) conditions.push(ilike(printDocument.printName, `%${keyword}%`));
    const type = queryInteger(query.type, "打印平台", 0, 0, 2);
    if (type) conditions.push(eq(printDocument.type, type));
    if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(printDocument.status, queryInteger(query.status, "打印状态", 0, 0, 1)));
    }
    if (query.print_type !== undefined && query.print_type !== "") {
      conditions.push(eq(
        printDocument.printType,
        queryInteger(query.print_type, "打印时机", 1, 1, 2),
      ));
    }
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db.select().from(printDocument)
        .where(where).orderBy(desc(printDocument.id)).limit(limit).offset(offset),
      this.container.db.select({ count: sql<number>`count(*)::int` })
        .from(printDocument).where(where),
    ]);
    return {
      list: rows.map(buildPrintDocumentView),
      count: Number(countRows[0]?.count ?? 0),
      page,
      limit,
    };
  }

  async detail(owner: PrintDocumentOwner, id: number) {
    const supplierId = scopeSupplierId(owner);
    const row = id === 0
      ? emptyDocument(supplierId)
      : await scopedDocument(this.container.db, supplierId, id);
    return buildPrintDocumentView(row);
  }

  async save(actor: PrintDocumentActor, id: number, input: unknown) {
    assertWriteActor(actor);
    const supplierId = scopeSupplierId(actor);
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("打印机ID错误");
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRINT_DOCUMENT_WRITE_LOCK}, ${supplierId})`);
      const existing = id > 0 ? await scopedDocument(tx, supplierId, id, true) : undefined;
      const normalized = normalizePrintDocumentInput(input, existing);
      if (existing) {
        const updated = await tx.update(printDocument).set(normalized).where(and(
          eq(printDocument.id, existing.id),
          eq(printDocument.supplierId, supplierId),
          eq(printDocument.isDel, 0),
        )).returning();
        if (!updated[0]) throw new NotFoundException("打印机不存在");
        const verified = await scopedDocument(tx, supplierId, existing.id);
        assertDocumentReadback(verified, normalized);
        await writeAudit(tx, actor, "POST", "save", verified.id);
        return buildPrintDocumentView(verified);
      }
      const inserted = await tx.insert(printDocument).values({
        ...normalized,
        supplierId,
        addTime: Math.floor(Date.now() / 1000),
        isDel: 0,
      }).returning();
      if (!inserted[0]) throw new Error("打印机保存失败");
      const verified = await scopedDocument(tx, supplierId, inserted[0].id);
      assertDocumentReadback(verified, normalized);
      await writeAudit(tx, actor, "POST", "save", verified.id);
      return buildPrintDocumentView(verified);
    });
  }

  async setStatus(
    actor: PrintDocumentActor,
    id: number,
    value: unknown,
    method: "POST" | "PUT" = "PUT",
  ) {
    assertWriteActor(actor);
    const supplierId = scopeSupplierId(actor);
    const status = binary(value, "打印开关", 0);
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRINT_DOCUMENT_WRITE_LOCK}, ${supplierId})`);
      const existing = await scopedDocument(tx, supplierId, id, true);
      if (status === 1) {
        assertProviderReady(existing);
        const parsed = parseStoredContent(existing.printContent);
        if (!parsed.configured) throw new ValidateException("启用打印前请先配置打印内容");
        if (!parsed.valid) throw new ValidateException("历史打印内容JSON无效，请重新保存打印内容");
      }
      const updated = await tx.update(printDocument).set({ status }).where(and(
        eq(printDocument.id, existing.id),
        eq(printDocument.supplierId, supplierId),
        eq(printDocument.isDel, 0),
      )).returning();
      if (!updated[0]) throw new NotFoundException("打印机不存在");
      const verified = await scopedDocument(tx, supplierId, existing.id);
      if (verified.status !== status) throw new Error("打印机状态回读不一致");
      await writeAudit(tx, actor, method, "set_status", verified.id);
      return buildPrintDocumentView(verified);
    });
  }

  async delete(actor: PrintDocumentActor, id: number): Promise<void> {
    assertWriteActor(actor);
    const supplierId = scopeSupplierId(actor);
    await withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRINT_DOCUMENT_WRITE_LOCK}, ${supplierId})`);
      const existing = await scopedDocument(tx, supplierId, id, true);
      const deleted = await tx.update(printDocument).set({ isDel: 1, status: 0 }).where(and(
        eq(printDocument.id, existing.id),
        eq(printDocument.supplierId, supplierId),
        eq(printDocument.isDel, 0),
      )).returning({ id: printDocument.id });
      if (!deleted[0]) throw new NotFoundException("打印机不存在");
      const verified = await tx.select({ isDel: printDocument.isDel, status: printDocument.status })
        .from(printDocument).where(and(
          eq(printDocument.id, existing.id),
          eq(printDocument.supplierId, supplierId),
        )).limit(1);
      if (verified[0]?.isDel !== 1 || verified[0]?.status !== 0) {
        throw new Error("打印机删除状态回读不一致");
      }
      await writeAudit(tx, actor, "DELETE", "del", existing.id);
    });
  }

  async content(owner: PrintDocumentOwner, id: number): Promise<PrintContent> {
    const supplierId = scopeSupplierId(owner);
    const existing = await scopedDocument(this.container.db, supplierId, id);
    const parsed = parseStoredContent(existing.printContent);
    if (!parsed.configured) return { ...DEFAULT_PRINT_CONTENT };
    if (!parsed.valid || !parsed.content) {
      throw new ValidateException("历史打印内容JSON无效，请重新保存打印内容");
    }
    return parsed.content;
  }

  async saveContent(actor: PrintDocumentActor, id: number, input: unknown) {
    assertWriteActor(actor);
    const supplierId = scopeSupplierId(actor);
    const content = normalizePrintContent(input);
    const encoded = JSON.stringify(content);
    if (encoded.length > 8_192) throw new ValidateException("打印内容过长");
    return withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRINT_DOCUMENT_WRITE_LOCK}, ${supplierId})`);
      const existing = await scopedDocument(tx, supplierId, id, true);
      const updated = await tx.update(printDocument).set({ printContent: encoded }).where(and(
        eq(printDocument.id, existing.id),
        eq(printDocument.supplierId, supplierId),
        eq(printDocument.isDel, 0),
      )).returning();
      if (!updated[0]) throw new NotFoundException("打印机不存在");
      const verified = await scopedDocument(tx, supplierId, existing.id);
      if (verified.printContent !== encoded) throw new Error("打印内容回读不一致");
      await writeAudit(tx, actor, "POST", "save_content", verified.id);
      return buildPrintDocumentView(verified);
    });
  }
}
