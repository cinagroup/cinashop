/**
 * Admin 管理接口控制器 (M7+)
 *
 * 对应 PHP app/controller/admin/v1/ 下的:
 *   - product/StoreProduct.php (商品管理)
 *   - order/StoreOrder.php (订单管理)
 *   - user/User.php (用户管理)
 *   - system/config/SystemConfig.php (系统配置)
 *
 * 所有接口需要 admin token (adminAuthMiddleware)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import type { AppVariables, Env } from "@/env";
import {
  AdminPermissionService,
  assertDelegablePermissions,
  normalizeRoleRules,
} from "@/services/admin/AdminPermissionService";
import { ValidateException } from "@/utils/errors";
import { withTx } from "@/lib/di";
import { StoreIntegralOrderService } from "@/services/activity/StoreIntegralOrderService";
import {
  platformMetadataOwner,
  ProductMetadataService,
} from "@/services/product/ProductMetadataService";
import { UserSegmentationService } from "@/services/user/UserSegmentationService";
import {
  SystemMetadataService,
  type SystemFormAdminActor,
} from "@/services/system/SystemMetadataService";
import { SystemSignRewardService } from "@/services/system/SystemSignRewardService";
import { AgentLevelTaskService } from "@/services/agent/AgentLevelTaskService";
import {
  calculateCouponDiscountCents,
  parseCouponScopeIds,
  ProductCouponService,
} from "@/services/activity/ProductCouponService";
import {
  ProductAssociationService,
  type ProductEditorActor,
} from "@/services/product/ProductAssociationService";
import { ProductSkuRetirementService } from "@/services/product/ProductSkuRetirementService";
import { StoreOperationsService } from "@/services/store/StoreOperationsService";
import { generatePickupVerifyCode } from "@/services/order/StoreOrderWriteoffService";
import { enqueueOrderDeliveryNoticeEvent } from "@/services/order/OrderNotificationOutboxService";
import { AdminMobileRefundService } from "@/services/admin/AdminMobileRefundService";
import { AdminMobileProductService } from "@/services/admin/AdminMobileProductService";
import {
  AdminMobileUserService,
  type AdminMobileUserActor,
} from "@/services/admin/AdminMobileUserService";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

async function assertRoleAssignmentsWithinActor(
  c: C,
  roleIds: string | undefined,
  requireEveryRole = true,
): Promise<void> {
  const actor = c.get("adminInfo");
  if (!actor) throw new ValidateException("管理员身份不存在");
  const permissions = new AdminPermissionService(c.get("container"));
  const assignment = await permissions.resolveRoleAssignment(roleIds);
  if (requireEveryRole && assignment.missingRoleIds.length) {
    throw new ValidateException(`角色不存在或已停用: ${assignment.missingRoleIds.join(",")}`);
  }
  if (actor.level !== 0) {
    if (assignment.legacyRuleIds.length) {
      throw new ValidateException("包含旧版数字菜单规则的角色只能由超级管理员委派");
    }
    const granted = await permissions.resolveAdminPermissionKeys(actor);
    assertDelegablePermissions(granted, assignment.keys);
  }
}

async function assertRoleRulesWithinActor(c: C, rules: string): Promise<void> {
  const actor = c.get("adminInfo");
  if (!actor) throw new ValidateException("管理员身份不存在");
  if (actor.level === 0) return;
  if (rules.split(",").some((rule) => /^\d+$/.test(rule.trim()))) {
    throw new ValidateException("旧版数字菜单规则只能由超级管理员迁移");
  }
  const permissions = new AdminPermissionService(c.get("container"));
  const [granted, requested] = await Promise.all([
    permissions.resolveAdminPermissionKeys(actor),
    permissions.resolveRulePermissionKeys(rules),
  ]);
  assertDelegablePermissions(granted, requested);
}

// ═══════════════════════════════════════════════════════════
// 商品管理
// ═══════════════════════════════════════════════════════════

function productMetadata(c: C) {
  return new ProductMetadataService(c.get("container"));
}

function metadataId(c: C, allowZero = false): number {
  const value = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ValidateException("ID错误");
  }
  return value;
}

async function metadataBody(c: C): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

export async function adminProductUnitAll(c: C) {
  return jsonOk(c, await productMetadata(c).allUnits(platformMetadataOwner));
}

export async function adminProductUnitList(c: C) {
  return jsonOk(c, await productMetadata(c).unitList(platformMetadataOwner, c.req.query()));
}

export async function adminProductUnitDetail(c: C) {
  return jsonOk(c, await productMetadata(c).unitDetail(platformMetadataOwner, metadataId(c)));
}

export async function adminProductUnitSave(c: C) {
  const id = metadataId(c, true);
  const result = await productMetadata(c).saveUnit(
    platformMetadataOwner,
    id,
    await metadataBody(c),
  );
  return jsonOk(c, result, id === 0 ? "保存成功" : "修改成功");
}

export async function adminProductUnitDelete(c: C) {
  await productMetadata(c).deleteUnit(platformMetadataOwner, metadataId(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminProductRuleList(c: C) {
  return jsonOk(c, await productMetadata(c).ruleList(platformMetadataOwner, c.req.query()));
}

export async function adminProductRuleTemplates(c: C) {
  return jsonOk(c, await productMetadata(c).ruleTemplates(platformMetadataOwner));
}

export async function adminProductRuleDetail(c: C) {
  return jsonOk(c, await productMetadata(c).ruleDetail(platformMetadataOwner, metadataId(c)));
}

export async function adminProductRuleSave(c: C) {
  const result = await productMetadata(c).saveRule(
    platformMetadataOwner,
    metadataId(c, true),
    await metadataBody(c),
  );
  return jsonOk(c, result, "保存成功");
}

export async function adminProductRuleDelete(c: C) {
  await productMetadata(c).deleteRule(platformMetadataOwner, metadataId(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminProductSpecsList(c: C) {
  return jsonOk(
    c,
    await productMetadata(c).specTemplateList(platformMetadataOwner, c.req.query()),
  );
}

export async function adminProductSpecsAll(c: C) {
  return jsonOk(c, await productMetadata(c).allSpecTemplates(platformMetadataOwner));
}

export async function adminProductSpecsDetail(c: C) {
  return jsonOk(
    c,
    await productMetadata(c).specTemplateDetail(platformMetadataOwner, metadataId(c)),
  );
}

export async function adminProductSpecsSave(c: C) {
  const result = await productMetadata(c).saveSpecTemplate(
    platformMetadataOwner,
    metadataId(c, true),
    await metadataBody(c),
  );
  return jsonOk(c, result, "保存成功");
}

export async function adminProductSpecsDelete(c: C) {
  await productMetadata(c).deleteSpecTemplate(platformMetadataOwner, metadataId(c));
  return jsonOk(c, null, "删除成功");
}

/** GET /api/admin/product/list — 商品列表 */
export async function adminProductList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = {};
  if (q.store_name) where.store_name = q.store_name;
  if (q.status) where.status = Number(q.status);
  if (q.cate_id) where.cateId = q.cate_id;

  // admin 可看所有状态 (不像前台只看上架)
  const list = await container.storeProductDao.getSearchList({
    where: { ...where, isDel: 0 },
    page,
    limit,
  });

  return jsonOk(c, { list, page, limit });
}

function mobileProducts(c: C): AdminMobileProductService {
  return new AdminMobileProductService(c.get("container"));
}

function productAssociations(c: C): ProductAssociationService {
  return new ProductAssociationService(c.get("container"));
}

function productSkuRetirement(c: C): ProductSkuRetirementService {
  return new ProductSkuRetirementService(c.get("container"));
}

function productEditorActor(c: C): ProductEditorActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return {
    id: admin.id,
    name: admin.realName || admin.account,
    ip: c.req.header("CF-Connecting-IP")
      ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      ?? "",
  };
}

/** GET /api/admin/product/editor/options — 商品关联资料的有界候选集。 */
export async function adminProductEditorOptions(c: C) {
  privateNoStore(c);
  return jsonOk(c, await productAssociations(c).editorOptions());
}

/** GET /api/admin/product/category — PHP 移动管理端可选分类树。 */
export async function adminMobileProductCategories(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileProducts(c).categories());
}

/** GET /api/admin/product/admin_list — PHP 移动管理商品列表。 */
export async function adminMobileProductList(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileProducts(c).list(c.req.query()));
}

/** POST /api/admin/product/set_show — 事务化批量上下架。 */
export async function adminMobileProductSetShow(c: C) {
  privateNoStore(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  const parsed = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const result = await mobileProducts(c).setShow(body, productEditorActor(c));
  return jsonOk(c, result, Number(parsed?.is_show) === 1 ? "上架成功" : "下架成功");
}

/** GET /api/admin/product/product_label — 平台可用商品标签树。 */
export async function adminMobileProductLabels(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileProducts(c).labels());
}

/** GET /api/admin/product/get_attr/:id — 当前商品基础 SKU。 */
export async function adminMobileProductAttrs(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileProducts(c).getAttrs(c.req.param("id")));
}

/** POST /api/admin/product/update_attrs/:id — 行锁下更新库存价格。 */
export async function adminMobileProductUpdateAttrs(c: C) {
  privateNoStore(c);
  const body: unknown = await c.req.json().catch(() => null);
  return jsonOk(c, await mobileProducts(c).updateAttrs(c.req.param("id"), body), "修改成功");
}

/** POST /api/admin/product/batch_process — 有界、原子、回读校验的商品批量运营。 */
export async function adminMobileProductBatchProcess(c: C) {
  privateNoStore(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  return jsonOk(c, await mobileProducts(c).batchProcess(body, productEditorActor(c)), "修改成功");
}

/** GET /api/admin/product/detail/:id — 商品详情 */
export async function adminProductDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  privateNoStore(c);
  return jsonOk(c, await productAssociations(c).detail(id));
}

/** GET /api/admin/product/coupons/:id — 支付后赠券关系 */
export async function adminProductCoupons(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const list = await new ProductCouponService(c.get("container")).list(id);
  return jsonOk(c, {
    list,
    coupon_ids: list.map((item) => item.issue_coupon_id),
  });
}

/** PUT /api/admin/product/coupons/:id — 原子替换支付后赠券关系 */
export async function adminProductCouponsReplace(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const hasSnakeCase = Object.prototype.hasOwnProperty.call(body, "coupon_ids");
  const hasCamelCase = Object.prototype.hasOwnProperty.call(body, "couponIds");
  if (!hasSnakeCase && !hasCamelCase) throw new ValidateException("缺少coupon_ids参数");
  const result = await new ProductCouponService(c.get("container")).replace(
    id,
    hasSnakeCase ? body.coupon_ids : body.couponIds,
  );
  return jsonOk(c, result, "保存成功");
}

/** POST /adminapi/product/add — 创建商品 */
export async function adminProductCreate(c: C) {
  privateNoStore(c);
  const result = await productAssociations(c).save(
    0,
    await readBoundedJsonObject(c.req.raw, 64 * 1024),
    productEditorActor(c),
  );
  return jsonOk(c, result, "创建成功");
}

/** POST /adminapi/product/edit/:id — 编辑商品 */
export async function adminProductUpdate(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "参数错误");
  privateNoStore(c);
  const result = await productAssociations(c).save(
    id,
    await readBoundedJsonObject(c.req.raw, 64 * 1024),
    productEditorActor(c),
  );
  return jsonOk(c, result, "修改成功");
}

/** POST /api/admin/product/set_show/:id — 上架/下架 */
export async function adminProductSetShow(c: C) {
  privateNoStore(c);
  const id = Number(c.req.param("id") ?? "0");
  const body = await readBoundedJsonObject(c.req.raw, 1024);
  if (!id) return jsonFail(c, "参数错误");
  const isShow = Number(body.is_show ?? 1);
  await productAssociations(c).setShow(id, isShow, productEditorActor(c));
  return jsonOk(c, null, isShow === 1 ? "已上架" : "已下架");
}

/** POST /adminapi/product/sku/retire — 保留身份的可恢复退役。 */
export async function adminProductSkuRetire(c: C) {
  privateNoStore(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  const result = await productSkuRetirement(c).change("retire", body, productEditorActor(c));
  return jsonOk(c, result, "SKU已退役");
}

/** POST /adminapi/product/sku/restore — 恢复已退役SKU。 */
export async function adminProductSkuRestore(c: C) {
  privateNoStore(c);
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  const result = await productSkuRetirement(c).change("restore", body, productEditorActor(c));
  return jsonOk(c, result, "SKU已恢复");
}

/** DELETE /api/admin/product/del/:id — 删除商品 (软删除) */
export async function adminProductDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  await c.get("container").storeProductDao.update(id, { isDel: 1 });
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 订单管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/order/list — 订单列表 */
export async function adminOrderList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = { isDel: 0 };
  if (q.status !== undefined) where.status = Number(q.status);
  if (q.paid !== undefined) where.paid = Number(q.paid);
  if (q.uid) where.uid = Number(q.uid);
  if (q.order_id) where.orderId = q.order_id;

  const list = await container.storeOrderDao.selectList({ where, page, limit });
  return jsonOk(c, { list, page, limit });
}

/** GET /api/admin/order/detail/:orderId — 订单详情 */
export async function adminOrderDetail(c: C) {
  const orderId = c.req.param("orderId") ?? c.req.param("id") ?? "";
  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(orderId);
  if (!order) return jsonFail(c, "订单不存在");
  const cartInfos = await container.storeOrderCartInfoDao.getByOid(order.id);
  return jsonOk(c, {
    ...order,
    cartInfo: cartInfos.map((ci) => ({
      ...ci,
      cartInfo: ci.cartInfo ? JSON.parse(ci.cartInfo) : null,
    })),
  });
}

/** POST /api/admin/order/remark/:orderId — 订单备注 */
export async function adminOrderRemark(c: C) {
  const orderId = c.req.param("orderId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { remark?: string };
  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(orderId);
  if (!order) return jsonFail(c, "订单不存在");
  await container.storeOrderDao.update(order.id, { remark: body.remark ?? "" });
  await container.storeOrderStatusDao.log(order.id, "remark", `管理员备注: ${body.remark ?? ""}`);
  return jsonOk(c, null, "备注成功");
}

/** POST /api/admin/order/delivery/:orderId — 发货 */
export async function adminOrderDelivery(c: C) {
  const orderId = c.req.param("orderId") ?? c.req.param("id") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const container = c.get("container");
  const rawType = String(body.delivery_type ?? "express").trim().toLowerCase();
  const deliveryType = rawType === "1" ? "send" : rawType;
  if (!["express", "send", "fictitious"].includes(deliveryType)) {
    return jsonFail(c, "发货类型错误");
  }
  let deliveryName = String(body.delivery_name ?? body.sh_delivery_name ?? "").trim();
  let deliveryId = String(body.delivery_id ?? body.sh_delivery_id ?? "").trim();
  let deliveryUid = 0;
  let deliveryServiceId = 0;
  let fictitiousContent = "";
  if (deliveryType === "send") {
    deliveryUid = Number(body.delivery_uid ?? body.sh_delivery_uid ?? 0);
    if (!Number.isSafeInteger(deliveryUid) || deliveryUid <= 0) {
      return jsonFail(c, "请选择配送员");
    }
    const delivery = await new StoreOperationsService(container).requireActiveDelivery(deliveryUid);
    deliveryServiceId = delivery.id;
    deliveryName = delivery.nickname;
    deliveryId = delivery.phone;
  } else if (deliveryType === "express") {
    if (!deliveryName) return jsonFail(c, "请选择快递公司");
    if (!deliveryId) return jsonFail(c, "请输入快递单号");
  } else {
    fictitiousContent = String(body.fictitious_content ?? "").trim();
    deliveryName = "";
    deliveryId = "";
  }
  if (deliveryName.length > 64 || deliveryId.length > 64 || fictitiousContent.length > 500) {
    return jsonFail(c, "发货信息长度超限");
  }
  const { and, eq, sql } = await import("drizzle-orm");
  const { deliveryService, orderWaybillJob, storeOrder, storeOrderStatus, storePink, user } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  const changeMessage = deliveryType === "fictitious"
    ? `虚拟发货: ${fictitiousContent}`
    : `已发货: ${deliveryName} ${deliveryId}`;
  await withTx(container, async (tx) => {
    const rows = await tx
      .select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        uid: storeOrder.uid,
        userAddress: storeOrder.userAddress,
        paid: storeOrder.paid,
        status: storeOrder.status,
        pid: storeOrder.pid,
        type: storeOrder.type,
        pinkId: storeOrder.pinkId,
        shippingType: storeOrder.shippingType,
        supplierAllocationStatus: storeOrder.supplierAllocationStatus,
      })
      .from(storeOrder)
      .where(and(eq(storeOrder.orderId, orderId), eq(storeOrder.isDel, 0)))
      .limit(1)
      .for("update");
    const order = rows[0];
    if (!order) throw new ValidateException("订单不存在");
    if (!order.paid) throw new ValidateException("订单未支付");
    if (order.shippingType === 2) throw new ValidateException("门店自提订单不能发货，请使用核销流程");
    if (order.supplierAllocationStatus === 1) {
      throw new ValidateException("订单正在按供应商分配，请稍后刷新");
    }
    if (order.pid === -1) throw new ValidateException("请从拆分后的履约子单发货");
    if (order.status !== 0) throw new ValidateException("订单状态不允许发货");
    const rootOrderId = order.pid > 0 ? order.pid : order.id;
    const activeWaybill = await tx
      .select({ id: orderWaybillJob.id })
      .from(orderWaybillJob)
      .where(and(
        eq(orderWaybillJob.rootOrderId, rootOrderId),
        sql`${orderWaybillJob.status} IN (
          'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE', 'UNKNOWN', 'DEAD'
        )`,
      ))
      .limit(1)
      .for("key share");
    if (activeWaybill[0]) {
      throw new ValidateException("订单存在进行中的电子面单任务，请先在面单账本中处理");
    }
    if (order.type === 3) {
      const pink = await tx
        .select({ status: storePink.status })
        .from(storePink)
        .where(eq(storePink.id, order.pinkId))
        .limit(1)
        .for("key share");
      if (!pink[0] || pink[0].status !== 2) {
        throw new ValidateException("拼团尚未成功，不能发货");
      }
    }
    let verifyCode = "";
    if (deliveryType === "send") {
      const activeDelivery = await tx
        .select({ id: deliveryService.id })
        .from(deliveryService)
        .innerJoin(user, eq(user.uid, deliveryService.uid))
        .where(and(
          eq(deliveryService.id, deliveryServiceId),
          eq(deliveryService.uid, deliveryUid),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .limit(1)
        .for("update");
      if (!activeDelivery[0]) throw new ValidateException("配送员已停用，请重新选择");
      verifyCode = await generatePickupVerifyCode(tx);
    }
    await tx
      .update(storeOrder)
      .set({
        status: 1,
        deliveryType,
        deliveryName,
        deliveryId,
        deliveryUid,
        verifyCode,
        fictitiousContent,
        isStockUp: 1,
      })
      .where(eq(storeOrder.id, order.id));
    await tx.insert(storeOrderStatus).values({
      oid: order.id,
      changeType: "delivery_goods",
      changeMessage,
      changeTime: now,
    });
    await enqueueOrderDeliveryNoticeEvent(tx, {
      orderId: order.id,
      orderNo: order.orderId,
      userId: order.uid,
      userAddress: order.userAddress,
      deliveryType: deliveryType as "express" | "send" | "fictitious",
      deliveryName,
      deliveryId,
    }, now);
  });
  return jsonOk(c, null, "发货成功");
}

// ═══════════════════════════════════════════════════════════
// 用户管理
// ═══════════════════════════════════════════════════════════

function userSegmentation(c: C) {
  return new UserSegmentationService(c.get("container"));
}

function mobileUsers(c: C): AdminMobileUserService {
  return new AdminMobileUserService(c.get("container"));
}

function mobileUserActor(c: C): AdminMobileUserActor {
  const actor = c.get("adminInfo");
  if (!actor) throw new ValidateException("管理员身份不存在");
  return {
    id: actor.id,
    name: (actor.realName || actor.account).slice(0, 64),
    ip: (c.req.header("CF-Connecting-IP") ?? "").slice(0, 45),
  };
}

/** GET /api/admin/user/label/:uid — PHP 移动管理端用户标签选择器。 */
export async function adminMobileUserLabels(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileUsers(c).labels(c.req.param("uid")));
}

/** GET /api/admin/user/coupon/grant — 可赠券或用户未使用券列表。 */
export async function adminMobileUserCouponGrant(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileUsers(c).couponGrant(c.req.query()));
}

/** GET /api/admin/user/group/list — PHP 移动管理端用户分组。 */
export async function adminMobileUserGroups(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileUsers(c).groups());
}

/** GET /api/admin/user/level/list — PHP 移动管理端可用会员等级。 */
export async function adminMobileUserLevels(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileUsers(c).levels());
}

/** POST /api/admin/user/update_other/:uid — 有流水和幂等保护的余额/积分调整。 */
export async function adminMobileUserUpdateOther(c: C) {
  privateNoStore(c);
  const body: unknown = await c.req.json().catch(() => null);
  return jsonOk(c, await mobileUsers(c).adjustFinance(
    mobileUserActor(c),
    c.req.param("uid"),
    body,
    c.req.header("Idempotency-Key"),
  ), "修改成功");
}

/** POST /api/admin/user/update — 等级、会员、赠券、分组和标签兼容入口。 */
export async function adminMobileUserUpdate(c: C) {
  privateNoStore(c);
  const body: unknown = await c.req.json().catch(() => null);
  return jsonOk(c, await mobileUsers(c).update(
    mobileUserActor(c),
    body,
    c.req.header("Idempotency-Key"),
  ), "修改成功");
}

/** GET /api/admin/user/address/list/:uid — 精确用户的有效地址。 */
export async function adminMobileUserAddresses(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileUsers(c).addresses(c.req.param("uid")));
}

/** GET /api/admin/user/address/default/:uid — 精确用户的默认地址。 */
export async function adminMobileUserDefaultAddress(c: C) {
  privateNoStore(c);
  const address = await mobileUsers(c).defaultAddress(c.req.param("uid"));
  return jsonOk(c, address ?? [], address ? "ok" : "empty");
}

export async function adminUserGroupList(c: C) {
  return jsonOk(c, await userSegmentation(c).groupList(c.req.query()));
}

export async function adminUserGroupSave(c: C) {
  return jsonOk(c, await userSegmentation(c).saveGroup(await metadataBody(c)), "提交成功");
}

export async function adminUserGroupDelete(c: C) {
  await userSegmentation(c).deleteGroup(metadataId(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminUserLabels(c: C) {
  return jsonOk(c, await userSegmentation(c).userLabels(metadataId(c)));
}

export async function adminUserLabelsSet(c: C) {
  await userSegmentation(c).setUserLabels(metadataId(c), await metadataBody(c));
  return jsonOk(c, null, "设置成功");
}

export async function adminUsersSetGroup(c: C) {
  const body = await metadataBody(c);
  await userSegmentation(c).assignGroup(body.uids ?? body.uid, body.group_id);
  return jsonOk(c, null, "设置成功");
}

export async function adminUsersSetLabel(c: C) {
  const body = await metadataBody(c);
  await userSegmentation(c).addUserLabels(body.uids ?? body.uid, body.label_id ?? body.label_ids);
  return jsonOk(c, null, "设置成功");
}

/** GET /api/admin/user/list — 用户列表 */
export async function adminUserList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = { isDel: 0 };
  if (q.uid) where.uid = Number(q.uid);
  if (q.phone) where.phone = q.phone;
  if (q.group_id) where.groupId = Number(q.group_id);

  const list = await container.userDao.selectList({ where, page, limit });
  return jsonOk(c, { list, page, limit });
}

/** GET /api/admin/user/info/:id — 用户详情 */
export async function adminUserInfo(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const user = await c.get("container").userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");
  // 隐藏敏感字段
  const { pwd: _pwd, ...safeUser } = user;
  void _pwd;
  const labels = await userSegmentation(c).userLabels(id);
  return jsonOk(c, { ...safeUser, label_id: labels });
}

/** POST /api/admin/user/update/:id — 编辑用户 */
export async function adminUserUpdate(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const container = c.get("container");
  const user = await container.userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");

  const updateData: Record<string, unknown> = {};
  if (body.nickname !== undefined) updateData.nickname = body.nickname;
  if (body.phone !== undefined) updateData.phone = body.phone;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.level !== undefined) updateData.level = body.level;
  await userSegmentation(c).updateUserAssignments(id, body.group_id, body.label_id);
  if (Object.keys(updateData).length > 0) {
    await container.userDao.update(id, updateData);
  }
  return jsonOk(c, null, "修改成功");
}

/** POST /api/admin/user/money/:id — 修改用户余额 */
export async function adminUserMoney(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as {
    money?: string;
    type?: "add" | "sub";
  };
  if (body.money === undefined) return jsonFail(c, "金额不能为空");

  const container = c.get("container");
  const user = await container.userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");

  const amount = Number(body.money);
  const newMoney = body.type === "sub"
    ? Math.max(0, Number(user.nowMoney) - amount)
    : Number(user.nowMoney) + amount;

  await container.userDao.update(id, { nowMoney: newMoney.toFixed(2) });
  return jsonOk(c, { balance: newMoney.toFixed(2) }, "修改成功");
}

// ═══════════════════════════════════════════════════════════
// 系统配置
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/config/list — 配置列表 (按 tab 分组) */
export async function adminConfigList(c: C) {
  const container = c.get("container");
  const list = await container.systemConfigDao.selectList({
    where: { isStore: 0 },
  });
  return jsonOk(c, list);
}

/** POST /api/admin/config/save — 保存配置 (批量) */
export async function adminConfigSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  const container = c.get("container");
  const configSvc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
    container,
    c.env,
  );

  for (const [key, value] of Object.entries(body)) {
    // 更新 DB
    const existing = await container.systemConfigDao.getOne({ menuName: key });
    if (existing) {
      await container.systemConfigDao.update(existing.id, { value });
    } else {
      await container.systemConfigDao.save({
        menuName: key,
        value,
        info: key,
        isStore: 0,
        type: "text",
        inputType: "input",
      });
    }
    // 失效 KV 缓存
    await configSvc.invalidate(key);
  }
  return jsonOk(c, null, "保存成功");
}

function systemMetadata(c: C) {
  return new SystemMetadataService(c.get("container"));
}

function systemFormActor(c: C): SystemFormAdminActor {
  const actor = c.get("adminInfo");
  if (!actor) throw new ValidateException("管理员身份不存在");
  return {
    id: actor.id,
    name: actor.realName || actor.account,
    ip: c.req.header("CF-Connecting-IP")
      ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      ?? "",
    method: c.req.method,
  };
}

export async function adminConfigTabList(c: C) {
  return jsonOk(c, await systemMetadata(c).configTabList(c.req.query()));
}

export async function adminConfigTabSave(c: C) {
  return jsonOk(
    c,
    await systemMetadata(c).saveConfigTab(0, await metadataBody(c)),
    "添加配置分类成功",
  );
}

export async function adminConfigTabUpdate(c: C) {
  return jsonOk(
    c,
    await systemMetadata(c).saveConfigTab(metadataId(c), await metadataBody(c)),
    "修改成功",
  );
}

export async function adminConfigTabDelete(c: C) {
  await systemMetadata(c).deleteConfigTab(metadataId(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminConfigTabStatus(c: C) {
  await systemMetadata(c).setConfigTabStatus(metadataId(c), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

export async function adminSystemFormList(c: C) {
  privateNoStore(c);
  return jsonOk(c, await systemMetadata(c).formList(c.req.query()));
}

export async function adminSystemFormAll(c: C) {
  privateNoStore(c);
  return jsonOk(c, await systemMetadata(c).allSystemForms());
}

export async function adminSystemFormInfo(c: C) {
  privateNoStore(c);
  const info = await systemMetadata(c).formInfo(
    metadataId(c),
    c.req.query("type") === "1",
  );
  return jsonOk(c, { info });
}

export async function adminSystemFormSave(c: C) {
  privateNoStore(c);
  return jsonOk(
    c,
    await systemMetadata(c).saveForm(
      metadataId(c, true),
      await readBoundedJsonObject(c.req.raw, 1_100_000),
      systemFormActor(c),
    ),
    "保存成功",
  );
}

export async function adminSystemFormRename(c: C) {
  privateNoStore(c);
  await systemMetadata(c).renameForm(
    metadataId(c),
    await readBoundedJsonObject(c.req.raw, 4_096),
    systemFormActor(c),
  );
  return jsonOk(c, null, "修改成功");
}

export async function adminSystemFormDelete(c: C) {
  privateNoStore(c);
  await systemMetadata(c).deleteForm(metadataId(c), systemFormActor(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminSystemFormStatus(c: C) {
  privateNoStore(c);
  await systemMetadata(c).setFormStatus(metadataId(c), c.req.param("is_show"), systemFormActor(c));
  return jsonOk(c, null, "设置成功");
}

export async function adminSystemFormData(c: C) {
  privateNoStore(c);
  return jsonOk(c, await systemMetadata(c).formDataList(metadataId(c), c.req.query()));
}

function signRewards(c: C) {
  return new SystemSignRewardService(c.get("container"));
}

export async function adminSignRewardList(c: C) {
  return jsonOk(c, await signRewards(c).list(c.req.query()));
}

export async function adminSignRewardAdd(c: C) {
  return jsonOk(c, await signRewards(c).form(0, c.req.query("type")));
}

export async function adminSignRewardEdit(c: C) {
  return jsonOk(c, await signRewards(c).form(metadataId(c), undefined));
}

export async function adminSignRewardSave(c: C) {
  return jsonOk(
    c,
    await signRewards(c).save(metadataId(c, true), await metadataBody(c)),
    "编辑成功",
  );
}

export async function adminSignRewardDelete(c: C) {
  await signRewards(c).delete(metadataId(c));
  return jsonOk(c, null, "删除成功");
}

function agentLevelTasks(c: C) {
  return new AgentLevelTaskService(c.get("container"));
}

export async function adminAgentLevelTaskList(c: C) {
  return jsonOk(c, await agentLevelTasks(c).adminList(c.req.query()));
}

export async function adminAgentLevelTaskCreateForm(c: C) {
  return jsonOk(c, await agentLevelTasks(c).form(0, c.req.query("level_id")));
}

export async function adminAgentLevelTaskEditForm(c: C) {
  return jsonOk(c, await agentLevelTasks(c).form(metadataId(c), undefined));
}

export async function adminAgentLevelTaskCreate(c: C) {
  return jsonOk(c, await agentLevelTasks(c).save(0, await metadataBody(c)), "添加等级任务成功");
}

export async function adminAgentLevelTaskUpdate(c: C) {
  return jsonOk(
    c,
    await agentLevelTasks(c).save(metadataId(c), await metadataBody(c)),
    "修改成功",
  );
}

export async function adminAgentLevelTaskDelete(c: C) {
  await agentLevelTasks(c).delete(metadataId(c));
  return jsonOk(c, null, "删除成功");
}

export async function adminAgentLevelTaskStatus(c: C) {
  await agentLevelTasks(c).setStatus(metadataId(c), c.req.param("status"));
  return jsonOk(c, null, "设置成功");
}

// ═══════════════════════════════════════════════════════════
// 退款审核
// ═══════════════════════════════════════════════════════════

function mobileRefunds(c: C): AdminMobileRefundService {
  return new AdminMobileRefundService(c.get("container"));
}

function privateNoStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

/** GET /api/admin/refund_order/list — PHP 移动管理端售后列表兼容接口。 */
export async function adminRefundOrderList(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileRefunds(c).list(c.req.query()));
}

/** GET /api/admin/refund_order/detail/:uni — 按退款 ID 或退款单号查询。 */
export async function adminRefundOrderDetail(c: C) {
  privateNoStore(c);
  return jsonOk(c, await mobileRefunds(c).detail(c.req.param("uni")));
}

/** POST /api/admin/refund_order/remark — 事务化更新售后备注并写入审计状态。 */
export async function adminRefundOrderRemark(c: C) {
  privateNoStore(c);
  const body: unknown = await c.req.json().catch(() => null);
  const adminId = c.get("adminId");
  return jsonOk(
    c,
    await mobileRefunds(c).updateRemark(adminId ?? 0, body),
    "备注成功",
  );
}

/** GET /api/admin/refund/list — 退款申请列表 */
export async function adminRefundList(c: C) {
  const container = c.get("container");
  const list = await container.storeOrderRefundDao.selectList({
    where: { isDel: 0 },
  });
  return jsonOk(c, list);
}

/** GET /api/admin/refund/detail/:id — 退款申请详情 */
export async function adminRefundDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const refund = await c.get("container").storeOrderRefundDao.get(id);
  if (!refund) return jsonFail(c, "退款记录不存在");
  return jsonOk(c, {
    ...refund,
    cartInfo: refund.cartInfo ? JSON.parse(refund.cartInfo) : null,
  });
}

/** POST /api/admin/refund/agree/:id — 同意退款 */
export async function adminRefundAgree(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const { StoreOrderRefundService } = await import("@/services/order/StoreOrderRefundService");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    const result = await svc.agreeRefund(id);
    return jsonOk(c, result, result.completed ? "退款成功" : "退款已受理，等待渠道确认");
  } catch (e) {
    if (e instanceof Error) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/admin/refund/refuse/:id — 拒绝退款 */
export async function adminRefundRefuse(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const body = (await c.req.json().catch(() => ({}))) as { refuse_reason?: string };
  const { StoreOrderRefundService } = await import("@/services/order/StoreOrderRefundService");
  const svc = new StoreOrderRefundService(c.get("container"), c.env);
  try {
    await svc.refuseRefund(id, body.refuse_reason ?? "不满足退款条件");
    return jsonOk(c, null, "已拒绝退款");
  } catch (e) {
    if (e instanceof Error) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/admin/config/:menuName — 取单个配置 */
export async function adminConfigGet(c: C) {
  const menuName = c.req.param("menuName") ?? "";
  const configSvc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
    c.get("container"),
    c.env,
  );
  const value = await configSvc.get(menuName);
  return jsonOk(c, { menuName, value });
}

// ═══════════════════════════════════════════════════════════
// 商品分类管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/category/list — 分类列表 (树形) */
export async function adminCategoryList(c: C) {
  const container = c.get("container");
  const list = await container.storeProductCategoryDao.getTierList({});
  return jsonOk(c, list);
}

/** POST /api/admin/category/save — 新增/编辑分类 */
export async function adminCategorySave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    pid?: number;
    cate_name?: string;
    pic?: string;
    sort?: number;
    is_show?: number;
  };
  const container = c.get("container");
  if (body.id) {
    await container.storeProductCategoryDao.update(body.id, {
      pid: body.pid ?? 0,
      cateName: body.cate_name ?? "",
      pic: body.pic ?? "",
      sort: body.sort ?? 0,
      isShow: body.is_show ?? 1,
    });
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  const row = await container.storeProductCategoryDao.save({
    pid: body.pid ?? 0,
    cateName: body.cate_name ?? "",
    pic: body.pic ?? "",
    sort: body.sort ?? 0,
    isShow: body.is_show ?? 1,
  });
  return jsonOk(c, { id: row.id }, "创建成功");
}

/** DELETE /api/admin/category/del/:id — 删除分类 */
export async function adminCategoryDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.storeProductCategoryDao.delete(id);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 优惠券管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/coupon/list — 优惠券列表 */
export async function adminCouponList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");
  const list = await container.storeCouponIssueDao.selectList({
    where: {},
    page,
    limit,
  });
  return jsonOk(c, list);
}

/** POST /api/admin/coupon/save — 新增/编辑优惠券 */
export async function adminCouponSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    title?: string;
    coupon_price?: string;
    use_min_price?: string;
    type?: number;
    coupon_type?: number;
    product_id?: unknown;
    category_id?: unknown;
    brand_id?: unknown;
    day?: number;
    status?: number;
    sort?: number;
    total_count?: number;
    receive_limit?: number;
    receive_type?: number;
    is_permanent?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeCouponIssue, storeCouponProduct } = await import("@/models/schema");
  const saved = await withTx(container, async (tx) => {
    const existing = body.id
      ? (
          await tx
            .select()
            .from(storeCouponIssue)
            .where(eq(storeCouponIssue.id, body.id))
            .limit(1)
            .for("update")
        )[0] ?? null
      : null;
    if (body.id && !existing) throw new ValidateException("优惠券不存在");

    const scopeType = Number(body.type ?? existing?.couponType ?? 0);
    const discountType = Number(body.coupon_type ?? existing?.type ?? 1);
    if (![0, 1, 2, 3].includes(scopeType)) throw new ValidateException("优惠券适用范围错误");
    if (![1, 2].includes(discountType)) throw new ValidateException("优惠券优惠类型错误");

    const rawProductIds = parseCouponScopeIds(body.product_id ?? existing?.productId);
    const rawCategoryIds = parseCouponScopeIds(body.category_id ?? existing?.category_id);
    const rawBrandIds = parseCouponScopeIds(body.brand_id ?? existing?.brandId);
    const productId = scopeType === 2 ? rawProductIds.join(",") : "0";
    const categoryId = scopeType === 1 ? String(rawCategoryIds.at(-1) ?? 0) : "0";
    const brandId = scopeType === 3 ? String(rawBrandIds.at(-1) ?? 0) : "0";
    if (scopeType === 1 && categoryId === "0") throw new ValidateException("请选择优惠券适用分类");
    if (scopeType === 2 && productId === "") throw new ValidateException("请选择优惠券适用商品");
    if (scopeType === 2 && productId.length > 500) {
      throw new ValidateException("优惠券适用商品数量过多");
    }
    if (scopeType === 3 && brandId === "0") throw new ValidateException("请选择优惠券适用品牌");

    const couponPrice = String(body.coupon_price ?? existing?.couponPrice ?? "0");
    const useMinPrice = String(body.use_min_price ?? existing?.useMinPrice ?? "0");
    if (!/^\d+(?:\.\d{1,2})?$/.test(useMinPrice)) {
      throw new ValidateException("优惠券使用门槛格式错误");
    }
    if (Number(couponPrice) <= 0) throw new ValidateException("优惠券金额或折扣必须大于0");
    calculateCouponDiscountCents({
      discountType,
      couponPrice,
      eligibleSubtotalCents: 10_000,
    });

    const receiveType = Number(body.receive_type ?? existing?.receiveType ?? 1);
    const isPermanent = receiveType === 2
      ? 1
      : Number(body.is_permanent ?? existing?.isPermanent ?? 1);
    const totalCount = receiveType === 2
      ? 0
      : Number(body.total_count ?? existing?.totalCount ?? 0);
    const receiveLimit = Number(body.receive_limit ?? existing?.receiveLimit ?? 1);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new ValidateException("优惠券发行量必须是非负整数");
    }
    if (!Number.isSafeInteger(receiveLimit) || receiveLimit < 0) {
      throw new ValidateException("优惠券限领数量必须是非负整数");
    }
    const claimedCount = existing && !existing.isPermanent
      ? Math.max(0, existing.totalCount - existing.remainCount)
      : 0;
    const remainCount = isPermanent ? totalCount : Math.max(0, totalCount - claimedCount);
    const values = {
      couponType: scopeType,
      couponTitle: body.title ?? existing?.couponTitle ?? "优惠券",
      title: body.title ?? existing?.title ?? "优惠券",
      type: discountType,
      couponPrice,
      useMinPrice,
      productId,
      category_id: categoryId,
      brandId,
      legacyProductIds: productId,
      legacyCategoryId: Number(categoryId),
      legacyBrandId: Number(brandId),
      totalCount,
      remainCount,
      receiveLimit,
      receiveType,
      day: Number(body.day ?? existing?.day ?? 7),
      isPermanent,
      status: Number(body.status ?? existing?.status ?? 1),
      sort: Number(body.sort ?? existing?.sort ?? 0),
    };

    const issueId = body.id
      ? (
          await tx
            .update(storeCouponIssue)
            .set(values)
            .where(eq(storeCouponIssue.id, body.id))
            .returning({ id: storeCouponIssue.id })
        )[0]?.id
      : (
          await tx
            .insert(storeCouponIssue)
            .values({ ...values, addTime: Math.floor(Date.now() / 1000) })
            .returning({ id: storeCouponIssue.id })
        )[0]?.id;
    if (!issueId) throw new Error("优惠券保存失败");

    await tx.delete(storeCouponProduct).where(eq(storeCouponProduct.couponId, issueId));
    if (scopeType === 2) {
      await tx.insert(storeCouponProduct).values(
        rawProductIds.map((item) => ({ couponId: issueId, productId: item })),
      );
    }
    return { id: issueId };
  });
  return jsonOk(c, saved, body.id ? "更新成功" : "创建成功");
}

/** POST /api/admin/coupon/status/:id — 上架/下架 */
export async function adminCouponStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number };
  const container = c.get("container");
  await container.storeCouponIssueDao.update(id, { status: body.status ?? 0 });
  return jsonOk(c, null, "操作成功");
}

/** DELETE /api/admin/coupon/del/:id — 删除优惠券 */
export async function adminCouponDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.storeCouponIssueDao.update(id, { isDel: 1, status: -1 });
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 营销活动管理 (M10)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/seckill — 秒杀活动列表 */
export async function adminSeckillList(c: C) {
  const container = c.get("container");
  const list = await container.storeSeckillDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/combination — 拼团活动列表 */
export async function adminCombinationList(c: C) {
  const container = c.get("container");
  const list = await container.storeCombinationDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/bargain — 砍价活动列表 */
export async function adminBargainList(c: C) {
  const container = c.get("container");
  const list = await container.storeBargainDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/integral — 积分商品列表 */
export async function adminIntegralList(c: C) {
  const container = c.get("container");
  const list = await container.storeIntegralDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** POST /api/admin/activity/status — 活动上下架 (通用) */
export async function adminActivityStatus(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    type: string;
    id: number;
    status: number;
  };
  const container = c.get("container");
  const { type, id, status } = body;
  if (!type || !id) return jsonFail(c, "参数错误");

  switch (type) {
    case "seckill":
      await container.storeSeckillDao.update(id, { status });
      break;
    case "combination":
      await container.storeCombinationDao.update(id, { status });
      break;
    case "bargain":
      await container.storeBargainDao.update(id, { status });
      break;
    case "integral":
      await container.storeIntegralDao.update(id, { status });
      break;
    default:
      return jsonFail(c, "未知活动类型");
  }
  return jsonOk(c, null, "操作成功");
}

// ═══════════════════════════════════════════════════════════
// 商品评价管理 (M11)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/reply/list — 评价列表 */
export async function adminReplyList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");
  const list = await container.replyDao.selectList({ where: {}, page, limit });
  // 解析 pics JSON
  return jsonOk(
    c,
    list.map((item: any) => ({
      ...item,
      pics: (() => {
        try {
          const arr = JSON.parse(item.pics || "[]");
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      })(),
    })),
  );
}

/** POST /api/admin/reply/status/:id — 评价隐藏/显示 */
export async function adminReplyStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number };
  const container = c.get("container");
  await container.replyDao.update(id, { status: body.status ?? 0 });
  return jsonOk(c, null, "操作成功");
}

/** DELETE /api/admin/reply/del/:id — 删除评价 */
export async function adminReplyDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.replyDao.update(id, { isDel: 1 });
  return jsonOk(c, null, "已删除");
}

// ═══════════════════════════════════════════════════════════
// 营销活动详情 (M12)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/pink/:combinationId — 拼团团列表 */
export async function adminPinkList(c: C) {
  const combinationId = Number(c.req.param("combinationId") ?? "0");
  const container = c.get("container");
  const { sql, desc } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const storePink = schema.storePink;
  const rows = await container.db
    .select({
      id: storePink.id,
      uid: storePink.uid,
      nickname: storePink.nickname,
      orderId: storePink.orderId,
      people: storePink.people,
      memberCount: storePink.memberCount,
      totalNum: storePink.totalNum,
      totalPrice: storePink.totalPrice,
      status: storePink.status,
      addTime: storePink.addTime,
    })
    .from(storePink)
    .where(sql`${storePink.combinationId} = ${combinationId}`)
    .orderBy(desc(storePink.addTime))
    .limit(50);
  return jsonOk(c, rows);
}

// ═══════════════════════════════════════════════════════════
// 营销细分管理 (M13)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/bargain_users/:bargainId — 砍价参与记录 */
export async function adminBargainUsers(c: C) {
  const bargainId = Number(c.req.param("bargainId") ?? "0");
  const container = c.get("container");
  const schema = await import("@/models/schema");
  const { eq, desc } = await import("drizzle-orm");
  const rows = await container.db
    .select()
    .from(schema.storeBargainUser)
    .where(eq(schema.storeBargainUser.bargainId, bargainId))
    .orderBy(desc(schema.storeBargainUser.addTime))
    .limit(50);
  return jsonOk(c, rows);
}

/** GET /api/admin/activity/seckill_times — 秒杀时段列表 */
export async function adminSeckillTimes(c: C) {
  const container = c.get("container");
  const list = await container.storeSeckillTimeDao.selectList({ where: {}, limit: 50 });
  return jsonOk(c, list);
}

// ═══════════════════════════════════════════════════════════
// 品牌管理 (M15)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/brand/list — 品牌列表 */
export async function adminBrandList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeBrand } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(storeBrand)
    .where(sql`${storeBrand.isDel} = 0`)
    .orderBy(sql`${storeBrand.sort} DESC, ${storeBrand.id} DESC`)
    .limit(100);
  return jsonOk(c, rows);
}

/** POST /api/admin/brand/save — 新增/编辑品牌 */
export async function adminBrandSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    brand_name?: string;
    sort?: number;
    is_show?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeBrand } = await import("@/models/schema");
  if (body.id) {
    await container.db
      .update(storeBrand)
      .set({ brandName: body.brand_name ?? "", sort: body.sort ?? 0, isShow: body.is_show ?? 1 })
      .where(eq(storeBrand.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(storeBrand)
    .values({
      brandName: body.brand_name ?? "新品牌",
      pid: 0,
      fid: "",
      storeId: 0,
      sort: body.sort ?? 0,
      isShow: body.is_show ?? 1,
      addTime: now,
      isDel: 0,
    })
    .returning({ id: storeBrand.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/brand/del/:id — 删除品牌 */
export async function adminBrandDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  await productAssociations(c).deleteBrand(id);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 系统管理员/角色管理 (M16)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/system_admin/list — 管理员列表 */
export async function adminSystemAdminList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemAdmin } = await import("@/models/schema");
  const rows = await container.db
    .select({
      id: systemAdmin.id,
      account: systemAdmin.account,
      realName: systemAdmin.realName,
      phone: systemAdmin.phone,
      roles: systemAdmin.roles,
      level: systemAdmin.level,
      status: systemAdmin.status,
      lastTime: systemAdmin.lastTime,
    })
    .from(systemAdmin)
    .where(sql`${systemAdmin.status} >= 0`)
    .orderBy(sql`${systemAdmin.id} DESC`)
    .limit(100);
  return jsonOk(c, rows);
}

/** POST /api/admin/system_admin/save — 新增/编辑管理员 */
export async function adminSystemAdminSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    account?: string;
    real_name?: string;
    phone?: string;
    pwd?: string;
    roles?: string;
    level?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemAdmin } = await import("@/models/schema");
  const actor = c.get("adminInfo");
  if (!actor) throw new ValidateException("管理员身份不存在");
  // 管理员密码与登录一致用 bcrypt (AdminAuthService.login 用 bcrypt 校验)
  const bcrypt = (await import("bcryptjs")).default;
  const hashPwd = (pwd: string) => bcrypt.hash(pwd, 12);

  const normalizeRoleIds = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    if (ids.some((id) => !/^[1-9]\d*$/.test(id))) throw new ValidateException("角色 ID 格式错误");
    return ids.join(",");
  };
  const normalizedRoles = normalizeRoleIds(body.roles);
  if (body.level !== undefined && (!Number.isInteger(body.level) || body.level < 0 || body.level > 9)) {
    throw new ValidateException("管理员等级必须为 0 到 9 的整数");
  }
  if (body.status !== undefined && body.status !== 0 && body.status !== 1) {
    throw new ValidateException("管理员状态参数错误");
  }

  if (body.id) {
    const target = await container.db
      .select({ level: systemAdmin.level, roles: systemAdmin.roles })
      .from(systemAdmin)
      .where(eq(systemAdmin.id, body.id))
      .limit(1);
    if (!target[0]) throw new ValidateException("管理员不存在");
    if (actor.level !== 0 && (target[0].level === 0 || body.level === 0)) {
      throw new ValidateException("只有超级管理员可以管理超级管理员账号");
    }
    if (actor.level !== 0) {
      await assertRoleAssignmentsWithinActor(c, target[0].roles, false);
    }
    if (normalizedRoles !== undefined) {
      await assertRoleAssignmentsWithinActor(c, normalizedRoles);
    }
    if (body.pwd && body.pwd.length < 12) throw new ValidateException("管理员密码至少 12 位");
    const updates: Record<string, unknown> = {};
    if (body.real_name !== undefined) updates.realName = body.real_name;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (normalizedRoles !== undefined) updates.roles = normalizedRoles;
    if (body.level !== undefined) updates.level = body.level;
    if (body.status !== undefined) updates.status = body.status;
    if (body.pwd) updates.pwd = await hashPwd(body.pwd);
    await container.db.update(systemAdmin).set(updates).where(eq(systemAdmin.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  if (!body.account?.trim()) return jsonFail(c, "账号不能为空");
  if (!body.pwd || body.pwd.length < 12) return jsonFail(c, "新管理员密码至少 12 位");
  const newLevel = body.level ?? 1;
  if (actor.level !== 0 && newLevel === 0) throw new ValidateException("只有超级管理员可以创建超级管理员账号");
  await assertRoleAssignmentsWithinActor(c, normalizedRoles ?? "");
  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(systemAdmin)
    .values({
      account: body.account.trim(),
      pwd: await hashPwd(body.pwd),
      realName: body.real_name ?? "",
      phone: body.phone ?? "",
      roles: normalizedRoles ?? "",
      level: newLevel,
      status: body.status ?? 1,
      adminType: 1,
      relationId: 0,
      headPic: "",
      lastIp: "",
      lastTime: now,
    })
    .returning({ id: systemAdmin.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** GET /api/admin/system_role/list — 角色列表 */
export async function adminSystemRoleList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemRole)
    .where(sql`${systemRole.status} >= 0`)
    .orderBy(sql`${systemRole.id} DESC`)
    .limit(50);
  const permissionSets = await new AdminPermissionService(container).resolveManyRulePermissionKeys(
    rows.map((row) => row.rules),
  );
  return jsonOk(c, rows.map((row, index) => ({ ...row, permissionKeys: permissionSets[index] ?? [] })));
}

/** GET /adminapi/integral/order/list — unified store_order(type=4) list. */
export async function adminIntegralOrderList(c: C) {
  const q = c.req.query();
  const service = new StoreIntegralOrderService(c.get("container"), c.env);
  return jsonOk(
    c,
    await service.adminList({
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 10),
      status: q.status !== undefined && q.status !== "" ? Number(q.status) : undefined,
      paid: q.paid !== undefined && q.paid !== "" ? Number(q.paid) : undefined,
      uid: q.uid ? Number(q.uid) : undefined,
      orderId: q.order_id || undefined,
    }),
  );
}

/** GET /adminapi/integral/order/chart */
export async function adminIntegralOrderChart(c: C) {
  const service = new StoreIntegralOrderService(c.get("container"), c.env);
  return jsonOk(c, await service.adminChart());
}

/** GET /adminapi/system_menus/tree — 当前 Worker 已登记的菜单级权限树 */
export async function adminSystemPermissionTree(c: C) {
  return jsonOk(c, new AdminPermissionService(c.get("container")).permissionTree());
}

/** POST /api/admin/system_role/save — 新增/编辑角色 */
export async function adminSystemRoleSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    role_name?: string;
    rules?: string;
    level?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");
  const normalizedRules = body.rules === undefined ? undefined : normalizeRoleRules(body.rules);
  const roleName = body.role_name?.trim();
  if (body.role_name !== undefined && !roleName) throw new ValidateException("角色名称不能为空");
  if (body.level !== undefined && (!Number.isInteger(body.level) || body.level < 0 || body.level > 9)) {
    throw new ValidateException("角色等级必须为 0 到 9 的整数");
  }
  if (body.status !== undefined && body.status !== 0 && body.status !== 1) {
    throw new ValidateException("角色状态参数错误");
  }

  if (body.id) {
    const existing = await container.db
      .select({ rules: systemRole.rules })
      .from(systemRole)
      .where(eq(systemRole.id, body.id))
      .limit(1);
    if (!existing[0]) throw new ValidateException("角色不存在");
    await assertRoleRulesWithinActor(c, existing[0].rules);
    if (normalizedRules !== undefined) await assertRoleRulesWithinActor(c, normalizedRules);
    const updates: Record<string, unknown> = {};
    if (roleName !== undefined) updates.roleName = roleName;
    if (normalizedRules !== undefined) updates.rules = normalizedRules;
    if (body.level !== undefined) updates.level = body.level;
    if (body.status !== undefined) updates.status = body.status;
    await container.db
      .update(systemRole)
      .set(updates)
      .where(eq(systemRole.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  await assertRoleRulesWithinActor(c, normalizedRules ?? "");
  const row = await container.db
    .insert(systemRole)
    .values({
      roleName: roleName ?? "新角色",
      rules: normalizedRules ?? "",
      level: body.level ?? 0,
      status: body.status ?? 1,
      type: 0,
      relationId: 0,
    })
    .returning({ id: systemRole.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/system_role/del/:id — 删除角色 */
export async function adminSystemRoleDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");
  const existing = await container.db
    .select({ rules: systemRole.rules })
    .from(systemRole)
    .where(eq(systemRole.id, id))
    .limit(1);
  if (!existing[0]) throw new ValidateException("角色不存在");
  await assertRoleRulesWithinActor(c, existing[0].rules);
  await container.db.update(systemRole).set({ status: -1 }).where(eq(systemRole.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 提现审核 (M17)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/extract/list — 提现记录 (状态筛选 + 用户信息) */
export async function adminExtractList(c: C) {
  const container = c.get("container");
  const { sql, and, eq } = await import("drizzle-orm");
  const { userExtract } = await import("@/models/schema");
  const { user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const status = q.status !== undefined && q.status !== "" ? Number(q.status) : undefined;
  const page = q.page ? Number(q.page) : 1;
  const limit = q.limit ? Number(q.limit) : 20;

  const conds: unknown[] = [];
  if (status !== undefined) conds.push(eq(userExtract.status, status));
  const where = conds.length ? and(...(conds as Parameters<typeof and>[0][])) : undefined;

  const rows = await container.db
    .select({
      id: userExtract.id,
      uid: userExtract.uid,
      extractType: userExtract.extractType,
      bankName: userExtract.bankName,
      realName: userExtract.realName,
      extractNumber: userExtract.extractNumber,
      bankCode: userExtract.bankCode,
      bankAddress: userExtract.bankAddress,
      alipayCode: userExtract.alipayCode,
      wechat: userExtract.wechat,
      qrcodeUrl: userExtract.qrcodeUrl,
      extractPrice: userExtract.extractPrice,
      extractFee: userExtract.extractFee,
      mark: userExtract.mark,
      balance: userExtract.balance,
      status: userExtract.status,
      failMsg: userExtract.failMsg,
      failTime: userExtract.failTime,
      addTime: userExtract.addTime,
      nickname: userTable.nickname,
      account: userTable.account,
    })
    .from(userExtract)
    .leftJoin(userTable, eq(userTable.uid, userExtract.uid))
    .where(where as never)
    .orderBy(sql`${userExtract.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userExtract)
    .where(where as never);
  const list = rows.map((row) => ({
    ...row,
    extractNumber:
      row.extractNumber ||
      (row.extractType === "alipay"
        ? row.alipayCode
        : row.extractType === "weixin" || row.extractType === "wx"
          ? row.wechat
          : row.bankCode),
  }));
  return jsonOk(c, { list, total: totalRows[0]?.c ?? 0 });
}

/** POST /api/admin/extract/status/:id — 提现审核 (API status=1 通过 / 2 拒绝) */
export async function adminExtractStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number; fail_msg?: string };
  const container = c.get("container");
  const { eq, and, sql } = await import("drizzle-orm");
  const { userExtract, userBrokerage, user: userTable } = await import("@/models/schema");

  const rejected = body.status === 2 || body.status === -1;
  const newStatus = rejected ? -1 : 1;
  const now = Math.floor(Date.now() / 1000);
  const updated = await withTx(container, async (tx) => {
    const records = await tx
      .update(userExtract)
      .set({
        status: newStatus,
        failMsg: rejected ? (body.fail_msg ?? "审核拒绝") : "",
        failTime: rejected ? now : 0,
      })
      .where(and(eq(userExtract.id, id), eq(userExtract.status, 0)))
      .returning({
        uid: userExtract.uid,
        extractPrice: userExtract.extractPrice,
        extractFee: userExtract.extractFee,
      });
    const record = records[0];
    if (!record) return false;

    if (rejected) {
      // PHP deducts gross amount (net extract_price + extract_fee); reject restores both.
      await tx
        .update(userTable)
        .set({
          brokeragePrice: sql`${userTable.brokeragePrice} + ${record.extractPrice} + ${record.extractFee}`,
        })
        .where(eq(userTable.uid, record.uid));
      await tx
        .update(userBrokerage)
        .set({ status: -1 })
        .where(and(eq(userBrokerage.linkId, String(id)), eq(userBrokerage.category, "extract")));
    } else {
      await tx
        .update(userBrokerage)
        .set({ status: 1 })
        .where(and(eq(userBrokerage.linkId, String(id)), eq(userBrokerage.category, "extract")));
    }
    return true;
  });
  if (!updated) return jsonFail(c, "提现记录不存在或已审核");
  return jsonOk(c, null, rejected ? "已拒绝" : "已通过");
}

// ═══════════════════════════════════════════════════════════
// 财务流水 (M18)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/bill/list — 资金流水 (join 用户 + 筛选) */
export async function adminBillList(c: C) {
  const container = c.get("container");
  const { sql, and, eq } = await import("drizzle-orm");
  const { userBill } = await import("@/models/schema");
  const { user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const pm = q.pm !== undefined && q.pm !== "" ? Number(q.pm) : undefined;
  const page = q.page ? Number(q.page) : 1;
  const limit = q.limit ? Number(q.limit) : 20;

  const conds: unknown[] = [];
  if (pm !== undefined) conds.push(eq(userBill.pm, pm));
  const where = conds.length ? and(...(conds as Parameters<typeof and>[0][])) : undefined;

  const rows = await container.db
    .select({
      id: userBill.id,
      uid: userBill.uid,
      linkId: userBill.linkId,
      pm: userBill.pm,
      title: userBill.title,
      category: userBill.category,
      type: userBill.type,
      number: userBill.number,
      balance: userBill.balance,
      mark: userBill.mark,
      status: userBill.status,
      addTime: userBill.addTime,
      nickname: userTable.nickname,
      account: userTable.account,
    })
    .from(userBill)
    .leftJoin(userTable, eq(userTable.uid, userBill.uid))
    .where(where as never)
    .orderBy(sql`${userBill.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userBill)
    .where(where as never);
  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 会员等级管理 (M18)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/level/list — 会员等级列表 */
export async function adminLevelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemUserLevel)
    .where(sql`${systemUserLevel.isDel} = 0`)
    .orderBy(sql`${systemUserLevel.grade} ASC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/level/save — 新增/编辑会员等级 */
export async function adminLevelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    name?: string;
    grade?: number;
    discount?: number;
    exp_num?: number;
    is_show?: number;
    image?: string;
    color?: string;
    explain?: string;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");

  if (body.id) {
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.grade !== undefined) updates.grade = body.grade;
    if (body.discount !== undefined) updates.discount = body.discount;
    if (body.exp_num !== undefined) updates.expNum = body.exp_num;
    if (body.is_show !== undefined) updates.isShow = body.is_show;
    if (body.image !== undefined) updates.image = body.image;
    if (body.color !== undefined) updates.color = body.color;
    if (body.explain !== undefined) updates.explain = body.explain;
    await container.db.update(systemUserLevel).set(updates).where(eq(systemUserLevel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(systemUserLevel)
    .values({
      name: body.name ?? "新等级",
      grade: body.grade ?? 0,
      discount: (body.discount ?? 100).toFixed(2),
      expNum: body.exp_num ?? 0,
      isShow: body.is_show ?? 1,
      image: body.image ?? "",
      color: body.color ?? "",
      explain: body.explain ?? "",
      isDel: 0,
      addTime: now,
    })
    .returning({ id: systemUserLevel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/level/del/:id — 删除会员等级 */
export async function adminLevelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");
  await container.db.update(systemUserLevel).set({ isDel: 1 }).where(eq(systemUserLevel.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 运费模板 + 快递公司 (M19)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/shipping_template/list — 运费模板列表 (含区域费率) */
export async function adminShippingTemplateList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { shippingTemplates, shippingTemplatesRegion } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(shippingTemplates)
    .where(sql`${shippingTemplates.isDel} = 0`)
    .orderBy(sql`${shippingTemplates.sort} DESC, ${shippingTemplates.id} DESC`);
  // 区域费率
  const regions = await container.db
    .select()
    .from(shippingTemplatesRegion)
    .orderBy(sql`${shippingTemplatesRegion.id} ASC`);
  return jsonOk(c, { list: rows, regions });
}

/** POST /api/admin/shipping_template/save — 新增/编辑模板 (含区域) */
export async function adminShippingTemplateSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    name?: string;
    type?: number;
    sort?: number;
    status?: number;
    regions?: { region_id: number; region_name: string; first: string; first_price: string; continue: string; continue_price: string }[];
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { shippingTemplates, shippingTemplatesRegion } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);

  if (body.id) {
    await container.db
      .update(shippingTemplates)
      .set({
        name: body.name ?? "",
        type: body.type ?? 1,
        sort: body.sort ?? 0,
        status: body.status ?? 1,
      })
      .where(eq(shippingTemplates.id, body.id));
    // 重建区域
    await container.db
      .delete(shippingTemplatesRegion)
      .where(eq(shippingTemplatesRegion.templateId, body.id));
    for (const r of body.regions ?? []) {
      await container.db.insert(shippingTemplatesRegion).values({
        templateId: body.id,
        regionId: r.region_id,
        regionName: r.region_name,
        first: r.first ?? "1",
        firstPrice: r.first_price ?? "0.00",
        continue: r.continue ?? "1",
        continuePrice: r.continue_price ?? "0.00",
        addTime: now,
      });
    }
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  if (!body.name) return jsonFail(c, "请输入模板名称");
  const row = await container.db
    .insert(shippingTemplates)
    .values({
      ownerType: 0,
      relationId: 0,
      name: body.name,
      type: body.type ?? 1,
      appoint: 0,
      noDelivery: 0,
      sort: body.sort ?? 0,
      status: body.status ?? 1,
      isDel: 0,
      addTime: now,
    })
    .returning({ id: shippingTemplates.id });
  const tid = row[0].id;
  for (const r of body.regions ?? []) {
    await container.db.insert(shippingTemplatesRegion).values({
      templateId: tid,
      regionId: r.region_id,
      regionName: r.region_name,
      first: r.first ?? "1",
      firstPrice: r.first_price ?? "0.00",
      continue: r.continue ?? "1",
      continuePrice: r.continue_price ?? "0.00",
      addTime: now,
    });
  }
  return jsonOk(c, { id: tid }, "创建成功");
}

/** DELETE /api/admin/shipping_template/del/:id — 删除模板 */
export async function adminShippingTemplateDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { shippingTemplates } = await import("@/models/schema");
  await container.db.update(shippingTemplates).set({ isDel: 1 }).where(eq(shippingTemplates.id, id));
  return jsonOk(c, null, "删除成功");
}

/** GET /api/admin/express/list — 快递公司列表 */
export async function adminExpressList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(expressCompany)
    .orderBy(sql`${expressCompany.sort} DESC, ${expressCompany.id} ASC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/express/save — 新增/编辑快递公司 */
export async function adminExpressSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    code?: string;
    name?: string;
    is_show?: number;
    sort?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");

  if (body.id) {
    await container.db
      .update(expressCompany)
      .set({
        code: body.code ?? "",
        name: body.name ?? "",
        isShow: body.is_show ?? 1,
        sort: body.sort ?? 0,
        status: body.status ?? 1,
      })
      .where(eq(expressCompany.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.name) return jsonFail(c, "请输入快递公司名称");
  const row = await container.db
    .insert(expressCompany)
    .values({
      code: body.code ?? "",
      name: body.name,
      isShow: body.is_show ?? 1,
      sort: body.sort ?? 0,
      status: body.status ?? 1,
      addTime: Math.floor(Date.now() / 1000),
    })
    .returning({ id: expressCompany.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/express/del/:id — 删除快递公司 */
export async function adminExpressDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");
  await container.db.delete(expressCompany).where(eq(expressCompany.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 营销活动创建/编辑/删除 (M20)
// ═══════════════════════════════════════════════════════════

/** POST /api/admin/activity/save — 创建/编辑活动 (type 分发) */
export async function adminActivitySave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    type: "seckill" | "combination" | "bargain" | "integral";
    id?: number;
    productId?: number;
    storeName?: string;
    image?: string;
    price?: string;
    otPrice?: string;
    quota?: number;
    stock?: number;
    num?: number;
    // 秒杀
    timeId?: string;
    // 拼团
    people?: number;
    // 砍价
    minPrice?: string;
    // 积分
    integral?: number;
    sort?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  const sort = body.sort ?? 90;
  const status = body.status ?? 1;
  const common = {
    productId: body.productId ?? 0,
    storeName: body.storeName ?? "新活动",
    image: body.image ?? "",
    price: body.price ?? "0.00",
    otPrice: body.otPrice ?? "0.00",
    quota: body.quota ?? 100,
    quotaShow: body.quota ?? 100,
    stock: body.stock ?? 100,
    status,
    sort,
  };

  try {
    if (body.type === "seckill") {
      const vals = {
        ...common,
        timeId: body.timeId ?? "1",
        num: body.num ?? 2,
        sales: 0,
        addTime: now,
      };
      if (body.id) {
        await container.db.update(schema.storeSeckill).set(vals).where(eq(schema.storeSeckill.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeSeckill).values(vals).returning({ id: schema.storeSeckill.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "combination") {
      const vals = { ...common, people: body.people ?? 2, sales: 0, addTime: now };
      if (body.id) {
        await container.db.update(schema.storeCombination).set(vals).where(eq(schema.storeCombination.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeCombination).values(vals).returning({ id: schema.storeCombination.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "bargain") {
      const vals = { ...common, minPrice: body.minPrice ?? "0.00", sales: 0, people: 10, addTime: now };
      if (body.id) {
        await container.db.update(schema.storeBargain).set(vals).where(eq(schema.storeBargain.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeBargain).values(vals).returning({ id: schema.storeBargain.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "integral") {
      const vals = {
        ...common,
        integral: body.integral ?? 100,
        num: body.num ?? 1,
        sales: 0,
        addTime: now,
      };
      if (body.id) {
        await container.db.update(schema.storeIntegral).set(vals).where(eq(schema.storeIntegral.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeIntegral).values(vals).returning({ id: schema.storeIntegral.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    return jsonFail(c, "未知活动类型");
  } catch (e) {
    return jsonFail(c, e instanceof Error ? e.message : "保存失败");
  }
}

/** DELETE /api/admin/activity/del/:type/:id — 删除活动 */
export async function adminActivityDel(c: C) {
  const type = c.req.param("type") as "seckill" | "combination" | "bargain" | "integral";
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const tableMap = {
    seckill: schema.storeSeckill,
    combination: schema.storeCombination,
    bargain: schema.storeBargain,
    integral: schema.storeIntegral,
  };
  const table = tableMap[type];
  if (!table) return jsonFail(c, "未知活动类型");
  await container.db.delete(table).where(eq(table.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 商品标签 + 用户标签 (M21)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/product_label/list — 商品标签列表 */
export async function adminProductLabelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeProductLabel } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(storeProductLabel)
    .orderBy(sql`${storeProductLabel.sort} DESC, ${storeProductLabel.id} DESC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/product_label/save — 商品标签增改 */
export async function adminProductLabelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; labelName?: string; color?: string; bgColor?: string; sort?: number; status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeProductLabel } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.update(storeProductLabel).set({
      labelName: body.labelName ?? "", color: body.color ?? "", bgColor: body.bgColor ?? "",
      sort: body.sort ?? 0, status: body.status ?? 1,
    }).where(eq(storeProductLabel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.labelName) return jsonFail(c, "请输入标签名");
  const row = await container.db.insert(storeProductLabel).values({
    labelName: body.labelName, color: body.color ?? "", bgColor: body.bgColor ?? "",
    sort: body.sort ?? 0, status: body.status ?? 1, type: 0, relationId: 0, labelCate: 0,
    styleType: 1, borderColor: "", icon: "", isShow: 1, addTime: now,
  }).returning({ id: storeProductLabel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/product_label/del/:id */
export async function adminProductLabelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  await productAssociations(c).deleteProductLabel(id);
  return jsonOk(c, null, "删除成功");
}

/** GET /api/admin/user_label/list — 用户标签列表 */
export async function adminUserLabelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { userLabel } = await import("@/models/schema");
  const rows = await container.db.select().from(userLabel).orderBy(sql`${userLabel.sort} DESC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/user_label/save */
export async function adminUserLabelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; name?: string; color?: string; sort?: number; status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { userLabel } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.update(userLabel).set({
      name: body.name ?? "", color: body.color ?? "", sort: body.sort ?? 0, status: body.status ?? 1,
    }).where(eq(userLabel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.name) return jsonFail(c, "请输入标签名");
  const row = await container.db.insert(userLabel).values({
    type: 0,
    relationId: 0,
    labelCate: 0,
    name: body.name,
    tagId: "",
    color: body.color ?? "#e93323",
    sort: body.sort ?? 0,
    status: body.status ?? 1,
    addTime: now,
  }).returning({ id: userLabel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/user_label/del/:id */
export async function adminUserLabelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  await userSegmentation(c).deletePlatformLabel(id);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// DIY 装修/自定义页面 (M22)
// ═══════════════════════════════════════════════════════════

const ADMIN_DISE_MAX_BODY_BYTES = 4_100_000;
const ADMIN_DISE_MAX_VALUE_BYTES = 2_000_000;
const ADMIN_DISE_MAX_CONTENT_BYTES = 2_000_000;
const ADMIN_DISE_ALLOWED_SAVE_KEYS = new Set([
  "id",
  "create_kind",
  "name",
  "title",
  "value",
  "content",
  "status",
]);
const ADMIN_DISE_UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface AdminDiseEditableFields {
  name?: string;
  title?: string;
  value?: string;
  content?: string;
  status?: 0 | 1;
}

export type AdminDiseSaveInput =
  | ({ mode: "update"; id: number } & AdminDiseEditableFields)
  | ({
      mode: "create";
      createKind: "diy_page";
      name: string;
      title?: string;
      value: string;
      content?: string;
    });

export interface AdminDiseDeletionCandidate {
  id: number;
  status: number;
  type: number;
  isDiy: number;
  templateName: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function optionalAdminDiseString(
  source: Record<string, unknown>,
  key: "name" | "title" | "content",
  maxBytes: number,
  trim = false,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  const raw = source[key];
  if (typeof raw !== "string") throw new ValidateException(`${key}必须是字符串`);
  const value = trim ? raw.trim() : raw;
  if (utf8Length(value) > maxBytes) throw new ValidateException(`${key}内容过长`);
  return value;
}

/** Parse, bound and canonicalize the JSON contract stored in system_dise.value. */
export function normalizeAdminDiseJson(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidateException("value必须是JSON字符串");
  const source = raw.trim();
  if (!source) throw new ValidateException("value不能为空");
  if (utf8Length(source) > ADMIN_DISE_MAX_VALUE_BYTES) {
    throw new ValidateException("value内容过长");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ValidateException("value不是有效JSON");
  }
  if (parsed === null) throw new ValidateException("value不能为null");

  const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const current = queue.pop()!;
    visited += 1;
    if (visited > 100_000 || current.depth > 64) {
      throw new ValidateException("value结构过于复杂");
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (ADMIN_DISE_UNSAFE_JSON_KEYS.has(key)) {
        throw new ValidateException(`value包含不安全字段: ${key}`);
      }
      queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return JSON.stringify(parsed);
}

/** Strict DTO parser: immutable columns and unknown request fields are rejected. */
export function parseAdminDiseSaveInput(raw: unknown): AdminDiseSaveInput {
  if (!isPlainRecord(raw)) throw new ValidateException("请求体必须是JSON对象");
  const unknownKeys = Object.keys(raw).filter((key) => !ADMIN_DISE_ALLOWED_SAVE_KEYS.has(key));
  if (unknownKeys.length) throw new ValidateException(`不支持的字段: ${unknownKeys.join(",")}`);

  const name = optionalAdminDiseString(raw, "name", 255, true);
  const title = optionalAdminDiseString(raw, "title", 255, true);
  const content = optionalAdminDiseString(raw, "content", ADMIN_DISE_MAX_CONTENT_BYTES);
  const value = Object.prototype.hasOwnProperty.call(raw, "value")
    ? normalizeAdminDiseJson(raw.value)
    : undefined;

  let status: 0 | 1 | undefined;
  if (Object.prototype.hasOwnProperty.call(raw, "status")) {
    if (raw.status !== 0 && raw.status !== 1) throw new ValidateException("status只能为0或1");
    status = raw.status;
  }
  if (value !== undefined && content !== undefined && value === content) {
    throw new ValidateException("value与content必须独立维护，不能写入相同内容");
  }

  if (Object.prototype.hasOwnProperty.call(raw, "id")) {
    if (!Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
      throw new ValidateException("ID错误");
    }
    if (Object.prototype.hasOwnProperty.call(raw, "create_kind")) {
      throw new ValidateException("更新请求不能包含create_kind");
    }
    const editable: AdminDiseEditableFields = { name, title, value, content, status };
    if (Object.values(editable).every((item) => item === undefined)) {
      throw new ValidateException("没有可更新的字段");
    }
    if (name !== undefined && !name) throw new ValidateException("页面名称不能为空");
    return { mode: "update", id: raw.id as number, ...editable };
  }

  if (raw.create_kind !== "diy_page") {
    throw new ValidateException("新增页面必须使用create_kind=diy_page安全合同");
  }
  if (!name) throw new ValidateException("页面名称不能为空");
  if (value === undefined) throw new ValidateException("新增页面必须提供value");
  if (status !== undefined && status !== 0) {
    throw new ValidateException("新增页面必须先以停用状态保存");
  }
  return { mode: "create", createKind: "diy_page", name, title, value, content };
}

export function adminDiseDeletionProtectionReason(
  row: AdminDiseDeletionCandidate,
): string | null {
  const templateName = row.templateName.trim().toLowerCase();
  if (row.id === 1 || templateName === "default") return "默认页面不能删除";
  if (templateName === "suspended_window") return "悬浮配置不能删除";
  if (row.status === 1 && row.type === 1 && row.isDiy === 1) return "启用中的首页不能删除";
  return null;
}

function newAdminDiseVersion(nowMs = Date.now()): string {
  return `${nowMs.toString(36)}-${crypto.randomUUID()}`;
}

async function readAdminDiseSaveInput(c: C): Promise<AdminDiseSaveInput> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > ADMIN_DISE_MAX_BODY_BYTES) {
    throw new ValidateException("请求体过大");
  }
  const text = await c.req.text();
  if (utf8Length(text) > ADMIN_DISE_MAX_BODY_BYTES) throw new ValidateException("请求体过大");
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ValidateException("请求体不是有效JSON");
  }
  return parseAdminDiseSaveInput(raw);
}

/** GET /api/admin/dise/list — 自定义页面列表 */
export async function adminDiseList(c: C) {
  c.header("Cache-Control", "private, no-store");
  const container = c.get("container");
  const { desc, eq } = await import("drizzle-orm");
  const { systemDise } = await import("@/models/schema");
  const rows = await container.db
    .select({
      id: systemDise.id,
      name: systemDise.name,
      title: systemDise.title,
      value: systemDise.value,
      content: systemDise.content,
      status: systemDise.status,
      type: systemDise.type,
      templateName: systemDise.templateName,
      isDiy: systemDise.isDiy,
      isShow: systemDise.isShow,
      version: systemDise.version,
      addTime: systemDise.addTime,
      updateTime: systemDise.updateTime,
    })
    .from(systemDise)
    .where(eq(systemDise.isDel, 0))
    .orderBy(desc(systemDise.id))
    .limit(100);
  return jsonOk(c, rows.map((row) => {
    const reason = adminDiseDeletionProtectionReason(row);
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      value: row.value ?? "",
      content: row.content ?? "",
      status: row.status,
      type: row.type,
      template_name: row.templateName,
      is_diy: row.isDiy,
      is_show: row.isShow,
      version: row.version,
      add_time: row.addTime,
      update_time: row.updateTime,
      delete_protected: reason !== null,
      delete_protection_reason: reason ?? "",
    };
  }));
}

/** POST /api/admin/dise/save — 自定义页面增改 */
export async function adminDiseSave(c: C) {
  c.header("Cache-Control", "private, no-store");
  const body = await readAdminDiseSaveInput(c);
  const container = c.get("container");
  const { and, eq, sql } = await import("drizzle-orm");
  const { systemDise } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  const result = await withTx(container, async (tx) => {
    const version = newAdminDiseVersion();
    if (body.mode === "create") {
      const inserted = await tx.insert(systemDise).values({
        name: body.name,
        title: body.title ?? body.name,
        value: body.value,
        content: body.content ?? "",
        type: 1,
        templateName: "",
        isDiy: 1,
        isShow: 0,
        status: 0,
        isDel: 0,
        version,
        addTime: now,
        updateTime: now,
      }).returning({
        id: systemDise.id,
        version: systemDise.version,
        updateTime: systemDise.updateTime,
      });
      return inserted[0];
    }

    const existing = (await tx
      .select({ id: systemDise.id, value: systemDise.value })
      .from(systemDise)
      .where(and(eq(systemDise.id, body.id), eq(systemDise.isDel, 0)))
      .limit(1)
      .for("update"))[0];
    if (!existing) throw new ValidateException("页面不存在或已删除");
    // A metadata-only update must not reactivate or re-version a row whose
    // persisted DIY contract is already corrupt.
    if (body.value === undefined) normalizeAdminDiseJson(existing.value);

    const updated = await tx.update(systemDise).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      version,
      updateTime: sql<number>`GREATEST(${systemDise.updateTime} + 1, ${now})`,
    }).where(and(eq(systemDise.id, body.id), eq(systemDise.isDel, 0))).returning({
      id: systemDise.id,
      version: systemDise.version,
      updateTime: systemDise.updateTime,
    });
    if (!updated[0]) throw new ValidateException("页面更新失败");
    return updated[0];
  });
  return jsonOk(c, {
    id: result.id,
    version: result.version,
    update_time: result.updateTime,
  }, body.mode === "create" ? "创建成功" : "更新成功");
}

/** DELETE /api/admin/dise/del/:id */
export async function adminDiseDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("ID错误");
  c.header("Cache-Control", "private, no-store");
  const container = c.get("container");
  const { and, eq, sql } = await import("drizzle-orm");
  const { systemDise } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  await withTx(container, async (tx) => {
    const row = (await tx.select({
      id: systemDise.id,
      status: systemDise.status,
      type: systemDise.type,
      isDiy: systemDise.isDiy,
      templateName: systemDise.templateName,
    }).from(systemDise)
      .where(and(eq(systemDise.id, id), eq(systemDise.isDel, 0)))
      .limit(1)
      .for("update"))[0];
    if (!row) throw new ValidateException("页面不存在或已删除");
    const reason = adminDiseDeletionProtectionReason(row);
    if (reason) throw new ValidateException(reason);

    await tx.update(systemDise).set({
      isDel: 1,
      status: 0,
      version: newAdminDiseVersion(),
      updateTime: sql<number>`GREATEST(${systemDise.updateTime} + 1, ${now})`,
    }).where(and(eq(systemDise.id, id), eq(systemDise.isDel, 0)));
  });
  return jsonOk(c, null, "删除成功");
}

// CMS 内容管理已迁移到 AdminArticleController / AdminArticleService。

// ═══════════════════════════════════════════════════════════
// 系统工具 (M22: 操作日志)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/log/list — 操作日志 */
export async function adminLogList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const offset = (page - 1) * limit;
  const rows = await container.db.execute(sql`
    SELECT * FROM "system_log" ORDER BY "id" DESC LIMIT ${limit} OFFSET ${offset}
  `);
  const countRows = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM "system_log"`);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  const carr = Array.isArray(countRows) ? countRows : (countRows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, { list: arr, total: (carr[0] as { c?: number })?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 分销管理 (M24: 推广人 + 佣金明细)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/spread/list — 推广人列表 (有 spread_count > 0 的用户) */
export async function adminSpreadList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { user: userTable } = await import("@/models/schema");
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  // 查 spread_count > 0 的用户 (推广人)
  const rows = await container.db
    .select({
      uid: userTable.uid,
      nickname: userTable.nickname,
      account: userTable.account,
      phone: userTable.phone,
      spreadCount: userTable.spreadCount,
      brokeragePrice: userTable.brokeragePrice,
      addTime: userTable.addTime,
    })
    .from(userTable)
    .where(sql`${userTable.spreadCount} > 0`)
    .orderBy(sql`${userTable.spreadCount} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userTable)
    .where(sql`${userTable.spreadCount} > 0`);

  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

/** GET /api/admin/brokerage/list — 佣金明细 (全平台) */
export async function adminBrokerageList(c: C) {
  const container = c.get("container");
  const { sql, eq } = await import("drizzle-orm");
  const { userBrokerage, user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 20);
  const uid = q.uid ? Number(q.uid) : undefined;

  const where = uid ? eq(userBrokerage.uid, uid) : undefined;

  const rows = await container.db
    .select({
      id: userBrokerage.id,
      uid: userBrokerage.uid,
      pm: userBrokerage.pm,
      title: userBrokerage.title,
      category: userBrokerage.category,
      type: userBrokerage.type,
      number: userBrokerage.number,
      balance: userBrokerage.balance,
      mark: userBrokerage.mark,
      status: userBrokerage.status,
      addTime: userBrokerage.addTime,
      nickname: userTable.nickname,
    })
    .from(userBrokerage)
    .leftJoin(userTable, eq(userTable.uid, userBrokerage.uid))
    .where(where as never)
    .orderBy(sql`${userBrokerage.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userBrokerage)
    .where(where as never);

  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 通知模板/短信配置 (M24)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/notification/list — 通知模板列表 */
export async function adminNotificationList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const rows = await container.db.execute(sql`
    SELECT id, title, content,
      CASE "legacy_type" WHEN 0 THEN 'routine' WHEN 1 THEN 'wechat' ELSE "type" END AS type,
      mark, status, add_time, notification_id, legacy_type, kid, example, tempid
    FROM "notification_template"
    ORDER BY "id" ASC
    LIMIT 100
  `);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, arr);
}

/** POST /api/admin/notification/save — 通知模板编辑 */
export async function adminNotificationSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; title?: string; content?: string; status?: number; type?: string;
  };
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const legacyType = body.type === "routine" ? 0 : body.type === "wechat" ? 1 : -1;
  if (body.id) {
    await container.db.execute(sql`
      UPDATE "notification_template" SET "title" = ${body.title ?? ""}, "content" = ${body.content ?? ""},
        "status" = ${body.status ?? 1}, "type" = COALESCE(${body.type ?? null}, "type"),
        "legacy_type" = CASE WHEN ${body.type ?? null} IS NULL THEN "legacy_type" ELSE ${legacyType} END
      WHERE "id" = ${body.id}
    `);
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  await container.db.execute(sql`
    INSERT INTO "notification_template" ("title", "content", "status", "type", "legacy_type", "mark", "add_time")
    VALUES (${body.title ?? ""}, ${body.content ?? ""}, ${body.status ?? 1}, ${body.type ?? "wechat"}, ${legacyType}, '', ${Math.floor(Date.now()/1000)})
  `);
  return jsonOk(c, null, "创建成功");
}

/** GET /api/admin/sms/config — 短信配置 (从 system_config 读取) */
export async function adminSmsConfig(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemConfig } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemConfig)
    .where(sql`${systemConfig.menuName} LIKE 'sms_%' OR ${systemConfig.menuName} LIKE 'notice_%'`);
  const config: Record<string, string> = {};
  for (const r of rows) {
    config[r.menuName] = r.value ?? "";
  }
  return jsonOk(c, config);
}

/** POST /api/admin/sms/config — 短信配置保存 */
export async function adminSmsConfigSave(c: C) {
  const body = await c.req.json().catch(() => ({}));
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemConfig } = await import("@/models/schema");
  for (const [key, value] of Object.entries(body)) {
    const existing = await container.db
      .select()
      .from(systemConfig)
      .where(eq(systemConfig.menuName, key))
      .limit(1);
    if (existing.length) {
      await container.db
        .update(systemConfig)
        .set({ value: String(value) })
        .where(eq(systemConfig.menuName, key));
    } else {
      await container.db.insert(systemConfig).values({
        menuName: key,
        info: key,
        value: String(value),
        isStore: 0,
        type: "input",
        inputType: "input",
        sort: 0,
        status: 1,
      });
    }
  }
  return jsonOk(c, null, "保存成功");
}
