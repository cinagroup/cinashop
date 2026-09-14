import { getAdminSession, getToken } from '@/utils/auth';
import { createShippingCreation, type CreationIdentity } from '../../../shared/shippingCreation';
import { postShippingCreation } from '../../../shared/shippingCreationTransport';

export function adminShippingCreation(scope: { signal: AbortSignal; isCurrent(): boolean }) {
  const actorId = getAdminSession()?.userInfo.id;
  if (!actorId) throw new Error('缺少稳定账号身份，请重新登录后恢复创建');
  const identity: CreationIdentity = { ownerType: 0, relationId: 0, actorId };
  return createShippingCreation(identity, () => scope.isCurrent(), {
    create: (payload, key) => postShippingCreation('/adminapi/shipping_template/save', 'Authori-zation', getToken(), key, payload, scope.signal, identity),
    lookup: key => postShippingCreation('/adminapi/shipping_template/creation-receipt', 'Authori-zation', getToken(), key, {}, scope.signal, identity),
  });
}
