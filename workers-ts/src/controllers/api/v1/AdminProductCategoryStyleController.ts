import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminProductCategoryStyleService } from '@/services/admin/AdminProductCategoryStyleService';
import { ProductCategoryStyleRejected, ProductCategoryStyleStaleVersion, readProductCategoryStyleBody } from '@/services/admin/AdminProductCategoryStyleInput';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const service = (c: C) => new AdminProductCategoryStyleService(c.get('container'));
function privateResponse(c: C) { c.header('Cache-Control', 'private, no-store'); if (new URL(c.req.url).searchParams.size) throw new ValidateException('分类样式接口不接受查询参数'); }
function actor(c: C) { const admin = c.get('adminInfo'); if (!admin) throw new ValidateException('管理员身份不存在'); return { id: admin.id }; }
export async function read(c: C) { privateResponse(c); return jsonOk(c, await service(c).read()); }
export async function receipt(c: C) {
  privateResponse(c); try { return jsonOk(c, await service(c).receipt(c.req.param('operationId'), actor(c))); }
  catch (error) { if (error instanceof NotFoundException) return c.json({ status: 404, msg: error.message, data: null }, 404); throw error; }
}
export async function save(c: C) {
  privateResponse(c); try { return jsonOk(c, await service(c).save(await readProductCategoryStyleBody(c.req.raw), actor(c)), '分类样式保存成功'); }
  catch (error) {
    // Only these pre-DML decisions carry a proof, after withTx rollback succeeds.
    if (error instanceof ProductCategoryStyleStaleVersion || error instanceof ProductCategoryStyleRejected) {
      const status = error instanceof ProductCategoryStyleStaleVersion ? 409 : 400;
      return c.json({ status, msg: error.message, data: { code: status === 409 ? 'PRODUCT_CATEGORY_STYLE_STALE_VERSION' : 'PRODUCT_CATEGORY_STYLE_REJECTED',
        operation: error.operation, operationId: error.operationId, payloadHash: error.payloadHash } }, status);
    } throw error;
  }
}
