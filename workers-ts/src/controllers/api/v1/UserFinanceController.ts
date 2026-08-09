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
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.commission(uid));
}

/** POST /api/spread/people — 推广人列表 */
export async function spreadPeople(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const q = c.req.query();
  const svc = new UserFinanceService(c.get("container"));
  const list = await svc.spreadPeople(
    uid,
    Number(q.page ?? 1),
    Number(q.limit ?? 10),
  );
  return jsonOk(c, list);
}

/** GET /api/spread/commission/:type — 佣金明细 */
export async function commissionList(c: C) {
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
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    extract_type?: string;
    real_name?: string;
    extract_number?: string;
    extract_price?: string;
    bank_name?: string;
  };
  const svc = new UserFinanceService(c.get("container"));
  try {
    const result = await svc.extractCash(uid, {
      extractType: body.extract_type ?? "bank",
      realName: body.real_name ?? "",
      extractNumber: body.extract_number ?? "",
      extractPrice: body.extract_price ?? "0",
      bankName: body.bank_name,
    });
    return jsonOk(c, result, "提现申请已提交");
  } catch (e) {
    if (e instanceof ValidateException) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/user/extract/list — 我的提现记录 (M17) */
export async function extractList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.extractList(uid));
}

// ═══ 发票 ═══════════════════════════════════════════════════

/** GET /api/invoice — 发票列表 */
export async function invoiceList(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const svc = new UserFinanceService(c.get("container"));
  return jsonOk(c, await svc.invoiceList(uid));
}

/** POST /api/invoice/save — 保存发票 */
export async function invoiceSave(c: C) {
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    header_type?: number;
    type?: number;
    name?: string;
    duty_number?: string;
    email?: string;
    is_default?: number;
  };
  const svc = new UserFinanceService(c.get("container"));
  try {
    const result = await svc.invoiceSave(uid, {
      id: body.id,
      headerType: body.header_type ?? 1,
      type: body.type ?? 1,
      name: body.name ?? "",
      dutyNumber: body.duty_number ?? "",
      email: body.email,
      isDefault: body.is_default,
    });
    return jsonOk(c, result, "保存成功");
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
  return jsonOk(c, await svc.getDefault(uid));
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
