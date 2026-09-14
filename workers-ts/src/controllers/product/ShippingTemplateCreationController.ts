import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';
import { saveAdminShippingTemplate } from '@/services/admin/AdminShippingTemplateService';
import { SupplierShippingTemplateService } from '@/services/supplier/SupplierShippingTemplateService';
import { findShippingCreationReceipt, type ShippingCreationActor } from '@/services/product/ShippingTemplateCreateReplay';

type HttpEnv = { Bindings: Env; Variables: AppVariables };
type C = Context<HttpEnv>;

/** Registered before auth, so authentication/permission failures cannot be cached. */
export const privateResponse: MiddlewareHandler<HttpEnv> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  await next();
};

function actor(c: C, supplier: boolean): ShippingCreationActor {
  const actorId = supplier ? c.get('supplierAdminId') : c.get('adminId');
  const principalId = supplier ? c.get('supplierAdminInfo')?.id : c.get('adminInfo')?.id;
  const relationId = supplier ? c.get('supplierId') : 0;
  if (!actorId || actorId !== principalId || relationId === undefined || (supplier && relationId <= 0)) {
    throw new AuthException('请登录');
  }
  return { ownerType: supplier ? 2 : 0, relationId, actorId };
}

export async function adminSave(c: C) {
  const identity = actor(c, false);
  const body = await readBoundedJsonObject(c.req.raw, 256 * 1024);
  if (body.id === undefined || Number(body.id) === 0) requireExpectedScope(c, identity);
  const result = await saveAdminShippingTemplate(c.get('container'), body,
    { actorId: identity.actorId, requestKey: c.req.raw.headers.get('Idempotency-Key') });
  return jsonOk(c, result.receipt ?? { id: result.id }, result.receipt ? '创建结果已确认' : '更新成功');
}

export async function supplierSave(c: C) {
  const identity = actor(c, true), rawId = c.req.param('id') ?? '';
  if (!/^\d{1,10}$/.test(rawId) || Number(rawId) > 2_147_483_647) throw new ValidateException('运费模板ID错误');
  const service = new SupplierShippingTemplateService(c.get('container'));
  const body = await readBoundedJsonObject(c.req.raw, 64 * 1024), id = Number(rawId);
  if (id === 0) {
    requireExpectedScope(c, identity);
    return jsonOk(c, await service.create(identity.relationId, body,
      { actorId: identity.actorId, requestKey: c.req.raw.headers.get('Idempotency-Key') }), '创建结果已确认');
  }
  return jsonOk(c, { id: await service.save(identity.relationId, id, body) }, '更新成功');
}

async function receipt(c: C, supplier: boolean) {
  const identity = actor(c, supplier);
  requireExpectedScope(c, identity);
  // POST uses manage permission. Keys never appear in URLs; client scope is never authoritative.
  const body = await readBoundedJsonObject(c.req.raw, 1024);
  if (Object.keys(body).length) throw new ValidateException('回执查询不接受请求正文参数');
  return jsonOk(c, await findShippingCreationReceipt(c.get('container'), identity, c.req.raw.headers.get('Idempotency-Key')));
}
/** A precondition, never an authority source. Compare with the fresh authenticated
 * principal so a stale browser cannot replay an old intent into a reassigned tenant.
 * Exact equality also rejects absent, duplicate and noncanonical declarations.
 */
function requireExpectedScope(c: C, identity: ShippingCreationActor) {
  const expected = `v1:${identity.ownerType}:${identity.relationId}:${identity.actorId}`;
  if (c.req.raw.headers.get('X-Shipping-Creation-Scope') !== expected) {
    throw new HttpApiException('创建身份已变化或缺失，请保留原请求并重新登录核对', 412, 412);
  }
}
export const adminReceipt = (c: C) => receipt(c, false);
export const supplierReceipt = (c: C) => receipt(c, true);
