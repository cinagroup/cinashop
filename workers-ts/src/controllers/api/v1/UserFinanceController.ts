/**
 * 分销 + 发票控制器
 *
 * 对应原版端点:
 *   - /api/user/spread (绑定推广)
 *   - /api/spread/people (推广人)
 *   - /api/commission (佣金首页)
 *   - /api/spread/commission/:type (佣金明细)
 *   - /api/extract/cash (提现)
 *   - /api/invoice* (发票 CRUD)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { normalizeWithdrawalBody } from "@/services/user/UserWithdrawalService";
import { UserFinanceReadService } from "@/services/user/UserFinanceReadService";
import { CapitalFlowService } from "@/services/finance/CapitalFlowService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

// ═══ 分销 ═══════════════════════════════════════════════════

/** POST /api/user/spread — 静默绑定推广关系 */
export async function bindSpread(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as { spread_uid?: number };
  const svc = new UserFinanceService(c.get("container"));
  await svc.bindSpread(uid, body.spread_uid ?? 0);
  return jsonOk(c, null, "绑定成功");
}

/** GET /api/commission — 佣金中心 */
export async function commission(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceReadService(c.get("container"), c.env);
  return jsonOk(c, await svc.commission(uid));
}

/** POST /api/spread/people — 推广人列表 */
export async function spreadPeople(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const raw: unknown = await c.req.json().catch(() => ({}));
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return jsonOk(c, await new UserFinanceReadService(c.get("container"), c.env).spreadPeople(uid, body));
}

/** GET /api/spread/commission/:type — 佣金明细 */
export async function commissionList(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await new UserFinanceReadService(c.get("container"), c.env)
    .legacyCommissionList(uid, Number(c.req.param("type")), c.req.query()));
}

/** GET /api/user/commission/list/:type — explicitly versioned new-client classification. */
export async function commissionItems(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const type = Number(c.req.param("type") ?? "0");
  const q = c.req.query();
  const svc = new UserFinanceService(c.get("container"));
  const list = await svc.commissionList(
    uid,
    type,
    Number(q.page ?? 1),
    Number(q.limit ?? 10),
  );
  return jsonOk(c, list);
}

/** POST /api/extract/cash — 提现申请 */
export async function extractCash(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const raw: unknown = await c.req.json().catch(() => ({}));
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const svc = new UserFinanceService(c.get("container"));
  try {
    const result = await svc.extractCash(uid, normalizeWithdrawalBody(body, c.req.header("Idempotency-Key")));
    // The money transaction has already committed. Lost dispatches are recovered by the scanner.
    c.executionCtx.waitUntil(new OrderOutboxService(c.get("container"), c.env)
      .dispatchEventKey(`withdrawal.applied.notice:${result.id}`).catch((error: unknown) => {
        emitOperationalEvent("error", { event: "withdrawal_application_dispatch_failed", component: "queue",
          operation: "notification_outbox", outcome: "retry", errorCode: operationalErrorCode(error) });
      }));
    return jsonOk(c, result, "提现申请已提交");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/user/extract/list — 我的提现记录 (M17) */
export async function extractList(c: C) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.extractList(uid, c.req.query("request_id") ?? ""));
}

// ═══ 发票 ═══════════════════════════════════════════════════

/** GET /api/invoice — 发票列表 */
export async function invoiceList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.invoiceList(uid));
}

/** GET /api/v2/invoice — legacy snake_case contract. */
export async function invoiceListV2(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.invoiceListLegacy(uid, {
    page: c.req.query("page"),
    limit: c.req.query("limit"),
    headerType: c.req.query("header_type"),
    type: c.req.query("type"),
  }));
}

/** GET /api/v2/invoice/detail/:id — ownership-scoped legacy invoice payload. */
export async function invoiceDetail(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, (await svc.invoiceDetailLegacy(uid, Number(c.req.param("id")))) ?? []);
}

async function persistInvoice(c: C, uid: number) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    header_type?: number;
    type?: number;
    name?: string;
    duty_number?: string;
    drawer_phone?: string;
    drawerPhone?: string;
    email?: string;
    tell?: string;
    address?: string;
    bank?: string;
    card_number?: string;
    is_default?: number;
  };
  const svc = new UserFinanceService(c.get("container"));
  return svc.invoiceSave(uid, {
    id: body.id,
    headerType: body.header_type ?? 1,
    type: body.type ?? 1,
    name: body.name ?? "",
    dutyNumber: body.duty_number ?? "",
    drawerPhone: body.drawer_phone ?? body.drawerPhone ?? "",
    email: body.email,
    tell: body.tell,
    address: body.address,
    bank: body.bank,
    cardNumber: body.card_number,
    isDefault: body.is_default,
  });
}

/** POST /api/invoice/save — existing camelCase client response. */
export async function invoiceSave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  try {
    const result = await persistInvoice(c, uid);
    return jsonOk(c, { id: result.id }, "保存成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/v2/invoice/save — PHP add/edit response compatibility. */
export async function invoiceSaveV2(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  try {
    const result = await persistInvoice(c, uid);
    return result.created
      ? jsonOk(c, { id: result.id }, "添加发票成功")
      : jsonOk(c, [], "修改发票成功");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** DELETE /api/invoice/del/:id — 删除发票 */
export async function invoiceDel(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const svc = new UserFinanceService(c.get("container"));
  await svc.invoiceDel(uid, id);
  return jsonOk(c, null, "删除成功");
}

/** POST /api/invoice/set_default/:id — 设置默认 */
export async function invoiceSetDefault(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const id = Number(c.req.param("id") ?? "0");
  const svc = new UserFinanceService(c.get("container"));
  await svc.setDefault(uid, id);
  return jsonOk(c, null, "已设为默认");
}

/** GET /api/invoice/get_default/:type — 默认发票 */
export async function invoiceGetDefault(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  const invoice = await svc.getDefault(uid, Number(c.req.param("type")));
  return invoice ? jsonOk(c, invoice) : jsonOk(c, [], "empty");
}

/** GET /api/v2/invoice/get_default/:type — legacy snake_case contract. */
export async function invoiceGetDefaultV2(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  const invoice = await svc.getDefaultLegacy(uid, Number(c.req.param("type")));
  return invoice ? jsonOk(c, invoice) : jsonOk(c, [], "empty");
}

/** GET /api/user/integral_logs — 积分明细 (user_bill category=integral) */
export async function integralLogs(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 20);
  const container = c.get("container");
  const list = await container.userBillDao.selectList({
    where: { uid, category: "integral" },
    page,
    limit,
  });
  return jsonOk(c, list);
}

/** GET /api/user/balance — 余额明细 (user_bill category=now_money) */
export async function balanceLogs(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 20);
  const container = c.get("container");
  const list = await container.userBillDao.selectList({
    where: { uid, category: "now_money" },
    page,
    limit,
  });
  return jsonOk(c, list);
}

/** GET /api/user/money_list/9 — external cash purchase/membership records. */
export async function capitalLogs(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const service = new CapitalFlowService(c.get("container"));
  return jsonOk(
    c,
    await service.listForUser(
      uid,
      Number(q.start ?? 0),
      Number(q.stop ?? 0),
      Number(q.page ?? 1),
      Number(q.limit ?? 10),
    ),
  );
}
