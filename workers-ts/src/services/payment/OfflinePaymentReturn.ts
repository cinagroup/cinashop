import type { Env } from '@/env';
import { ValidateException } from '@/utils/errors';
import { offlineReturnOrigin, offlineReturnUrl, type OfflineReturnClient } from '../../../../view/common/offlineReturn';
export { isOfflineReturnUrl } from '../../../../view/common/offlineReturn';
export type { OfflineReturnClient } from '../../../../view/common/offlineReturn';

/** Freeze an operator-configured destination before reserving an attempt.
 * Client supplies only a finite surface enum, never a URL or an Origin. */
export function prepareOfflineReturn(env: Env, client: OfflineReturnClient = 'pc'): (orderId:string)=>string {
  if (client !== 'pc' && client !== 'h5') throw new ValidateException('线下支付返回客户端无效');
  try {
    const origin = offlineReturnOrigin(client === 'pc' ? env.OFFLINE_PC_RETURN_ORIGIN : env.OFFLINE_H5_RETURN_ORIGIN);
    return orderId => offlineReturnUrl(origin,orderId);
  } catch { throw new ValidateException('线下支付返回站点未就绪'); }
}
