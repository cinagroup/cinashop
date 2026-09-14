import { createShippingCreation, type CreationIdentity } from '../../../shared/shippingCreation';
import { postShippingCreation } from '../../../shared/shippingCreationTransport';

export function supplierShippingCreation(scope: { signal: AbortSignal; isCurrent(): boolean }) {
  const user = JSON.parse(localStorage.getItem('supplier-user') ?? 'null');
  if (!user || typeof user !== 'object') throw new Error('缺少稳定供应商账号，请重新登录后恢复创建');
  const identity: CreationIdentity = { ownerType: 2, relationId: user.supplier_id, actorId: user.id };
  return createShippingCreation(identity, () => scope.isCurrent(), {
    create: (payload, key) => postShippingCreation('/supplierapi/setting/shipping_templates/save/0', 'Authorization', localStorage.getItem('supplier-token'), key, payload, scope.signal, identity),
    lookup: key => postShippingCreation('/supplierapi/setting/shipping_templates/creation-receipt', 'Authorization', localStorage.getItem('supplier-token'), key, {}, scope.signal, identity),
  });
}
