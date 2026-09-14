import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AuthException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { SupplierProductShippingOptionsService } from '@/services/supplier/SupplierProductShippingOptionsService';
import { openLegacyShippingOptions } from '@/services/supplier/SupplierLegacyShippingOptionsStream';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function identity(c: C) {
  const id = c.get('supplierId'), actor = c.get('supplierAdminId');
  if (!id || !actor || actor !== c.get('supplierAdminInfo')?.id) throw new AuthException('请登录');
  return id;
}
export async function list(c: C) {
  return jsonOk(c, await new SupplierProductShippingOptionsService(c.get('container')).list(identity(c), c.req.query()));
}
export async function detail(c: C) {
  const supplierId = identity(c), rawId = c.req.param('id') ?? '';
  if (!/^\d{1,10}$/.test(rawId)) throw new ValidateException('运费模板ID错误');
  return jsonOk(c, await new SupplierProductShippingOptionsService(c.get('container')).detail(supplierId, Number(rawId)));
}

export async function legacy(c: C) {
  const supplierId = identity(c);
  c.header('Content-Type', 'application/json; charset=UTF-8');
  if (c.req.method === 'HEAD') return c.body(null);
  // Obtain the event context before opening a cursor; absence must not leak one.
  const context = c.executionCtx;
  const preparing = openLegacyShippingOptions(c.env.HYPERDRIVE.connectionString, supplierId, c.req.raw.signal);
  // Keep initial cursor setup/rollback alive as well as response-body cleanup.
  context.waitUntil(preparing.then(result => result.completion, () => undefined));
  const result = await preparing;
  return c.body(result.body);
}
