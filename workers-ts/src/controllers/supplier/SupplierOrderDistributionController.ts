import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { categoryActor } from './SupplierProductCategoryController';
import { SupplierOrderDistributionService } from '@/services/supplier/SupplierOrderDistributionService';
import { distributionId, readDistributionInput } from '@/services/supplier/SupplierOrderDistributionInput';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type App = { Bindings: Env; Variables: AppVariables };
export const privateResponse: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store, max-age=0'); c.header('Pragma', 'no-cache'); await next();
};
async function input(c: Context<App>) {
  if (Object.keys(c.req.queries()).length) throw new ValidateException('配送信息不接受查询参数');
  const supplierId = c.get('supplierId'); if (!supplierId) throw new ValidateException('供应商身份无效');
  return { id: distributionId(c.req.param('id')), actor: { ...await categoryActor(c), supplierId }, service: new SupplierOrderDistributionService(c.get('container'), c.env.APP_KEY) };
}
export async function read(c: Context<App>) { const value = await input(c); return jsonOk(c, await value.service.read(value.actor, value.id)); }
export async function save(c: Context<App>) { const value = await input(c); return jsonOk(c, await value.service.save(value.actor, value.id, await readDistributionInput(c.req.raw))); }
