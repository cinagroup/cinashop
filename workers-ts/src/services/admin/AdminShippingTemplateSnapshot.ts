import { withTx, type Container } from '@/lib/di';
import { formatValidatedShippingRuleGroups as groups } from '../product/ShippingTemplateRules';
import { boundShippingTransaction, readShippingEditorSnapshot as readAdminShippingSnapshot } from '../product/ShippingTemplateRevision';
export { boundShippingTransaction, readShippingEditorSnapshot as readAdminShippingSnapshot, requireShippingRevision, assertShippingRevision } from '../product/ShippingTemplateRevision';

export async function detailAdminShippingTemplate(container: Container, id: number) {
  return withTx(container, async tx => {
    await boundShippingTransaction(tx);
    const { snapshot: s, revision } = await readAdminShippingSnapshot(tx, id);
    const regionInfo = await groups(tx, s.regions.map(r => ({ ...r, cityId: r.regionId })), 'region');
    const appointInfo = await groups(tx, s.free.map(r => ({ ...r })), 'free');
    const noDeliveryInfo = await groups(tx, s.noDelivery.map(r => ({ ...r })), 'no_delivery');
    return { revision, formData: { id, name: s.template.name, type: s.template.type, status: s.template.status,
      sort: s.template.sort, appoint: s.template.appoint, no_delivery: s.template.noDelivery },
      region_info: regionInfo, appoint_info: appointInfo, no_delivery_info: noDeliveryInfo };
  });
}
