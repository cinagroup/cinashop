import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables, Env } from '@/env';
import { authMiddleware } from '@/middleware/auth';
import { BuyerInvoiceService } from '@/services/user/BuyerInvoiceService';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { ValidateException } from '@/utils/errors';
import { jsonOk, jsonFail } from '@/utils/json';
import { buyerInvoiceId, buyerInvoiceQuery, buyerInvoiceRevision } from '../../../../../view/common/buyerInvoices';
import { orderDetailId } from '../../../../../view/common/orderDetailIdentity';

type Bindings = { Bindings: Env; Variables: AppVariables };
type C = Context<Bindings>;
type Action = 'titles' | 'records' | 'order' | 'save' | 'delete' | 'default' | 'apply';
export const privateBuyerInvoiceResponse: MiddlewareHandler<Bindings> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); c.header('Referrer-Policy', 'no-referrer'); await next();
};
const invalid = () => new ValidateException('发票参数无效，请重新读取');
async function body(c: C, keys?: string[]) {
  let value: unknown; try { value = JSON.parse(await readBoundedUtf8Text(c.req.raw, 8192)); } catch (e) { if (e instanceof ValidateException) throw e; throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (keys && (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)))) throw invalid();
  return row;
}
function id(value: unknown) { if (typeof value !== 'number') throw invalid(); return buyerInvoiceId(String(value)); }

/** Explicit opt-in keeps existing PHP/v1 response contracts intact. The entire
 * authentication middleware is repeated at service boundaries, including KV
 * legacy-token admission, rather than trusting a cached controller uid. */
export function buyerInvoiceView(action: Action, legacy: (c: C) => Promise<Response>): (c: C) => Promise<Response> {
  return async c => {
    const params = new URL(c.req.url).searchParams;
    if (!params.has('view')) return legacy(c);
    try {
      const keys = action === 'titles' || action === 'records' ? ['view', 'cursor', 'limit'] : ['view'];
      if (params.get('view') !== 'buyer' || [...params.keys()].some(key => !keys.includes(key) || params.getAll(key).length !== 1)) throw invalid();
      const actor = { uid: c.get('uid') ?? 0, authVersion: c.get('socketAuthVersion') ?? '', expiresAt: c.get('socketTokenExp') ?? 0 };
      const authorize = async () => {
        await authMiddleware({ force: true })(c, async () => {});
        if (c.get('uid') !== actor.uid || c.get('socketAuthVersion') !== actor.authVersion || c.get('socketTokenExp') !== actor.expiresAt) throw invalid();
      };
      const service = new BuyerInvoiceService(c.get('container'), c.env, actor, authorize);
      if (action === 'titles' || action === 'records') {
        const rawLimit = params.get('limit') ?? '20'; if (!/^(?:[1-9]|1\d|20)$/.test(rawLimit)) throw invalid();
        return jsonOk(c, await service.page(buyerInvoiceQuery(action, params.get('cursor'), Number(rawLimit))));
      }
      if (action === 'order') return jsonOk(c, await service.order(c.req.param('uni') ?? ''));
      if (action === 'save') return jsonOk(c, await service.save(await body(c)), '抬头已保存');
      if (action === 'delete' || action === 'default') {
        // Legacy GET deletion is never a write entry for the explicit new view.
        if (c.req.method === 'GET') throw invalid();
        const input = await body(c, ['revision']), target = buyerInvoiceId(c.req.param('id'));
        const revision = buyerInvoiceRevision(input.revision);
        return jsonOk(c, await (action === 'delete' ? service.remove(target, revision) : service.setDefault(target, revision)));
      }
      const input = await body(c, ['orderId', 'orderNo', 'revision', 'titleId', 'titleRevision']);
      return jsonOk(c, await service.apply({ orderId: id(input.orderId), orderNo: orderDetailId(input.orderNo), revision: buyerInvoiceRevision(input.revision),
        titleId: id(input.titleId), titleRevision: buyerInvoiceRevision(input.titleRevision) }), '开票申请已提交');
    } catch (e) {
      if (e instanceof ValidateException) return jsonFail(c, e.message);
      // Shared pure parsers have no HTTP dependency.
      if (e instanceof Error && ['发票资料与当前账号或页面不一致，请重新读取', '订单链接无效，请返回订单列表'].includes(e.message)) return jsonFail(c, e.message);
      throw e;
    }
  };
}
