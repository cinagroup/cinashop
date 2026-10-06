import { sql, type SQL } from 'drizzle-orm';

/** Shared count/list and detail visibility. No positive-stock predicate: an
 * authentic published sold-out activity still has an executable detail page.
 * Aliases are identifiers, never caller-provided SQL or tenant authority. */
export function integralPublicCandidateSql(activityAlias = 'a', productAlias = 'p'): SQL {
  if (![activityAlias, productAlias].every(value => /^[a-z][a-z0-9_]*$/.test(value))) throw Error('Invalid integral catalogue alias');
  const a = (name: string) => sql`${sql.identifier(activityAlias)}.${sql.identifier(name)}`;
  const p = (name: string) => sql`${sql.identifier(productAlias)}.${sql.identifier(name)}`;
  return sql`${a('id')}>0 AND ${p('id')}>0 AND ${a('product_id')}=${p('id')} AND ${a('status')}=1 AND ${a('is_show')}=1 AND ${a('is_del')}=0
    AND ${a('type')}=${p('type')} AND ${a('relation_id')}=${p('relation_id')} AND ${a('product_type')}=${p('product_type')}
    AND ${p('is_show')}=1 AND ${p('is_del')}=0 AND ${p('is_verify')}=1 AND ${p('is_vip_product')}=0 AND ${p('is_presale_product')}=0
    AND ${p('product_type')} BETWEEN 0 AND 4 AND ${p('pid')}>=0 AND ${p('pid')}<>${p('id')}
    AND ((${p('type')}=0 AND ${p('relation_id')}=0 AND ${p('pid')}=0)
      OR (${p('type')}=1 AND ${p('relation_id')}>0 AND EXISTS(SELECT 1 FROM public.system_store integral_owner_store
        WHERE integral_owner_store.id=${p('relation_id')} AND integral_owner_store.is_show=1 AND integral_owner_store.is_del=0 AND integral_owner_store.is_store=1))
      OR (${p('type')}=2 AND ${p('relation_id')}>0 AND EXISTS(SELECT 1 FROM public.system_supplier integral_owner_supplier
        WHERE integral_owner_supplier.id=${p('relation_id')} AND integral_owner_supplier.is_show=1 AND integral_owner_supplier.is_del=0)))
    AND (${p('pid')}=0 OR EXISTS(SELECT 1 FROM public.store_product integral_platform_parent
      WHERE integral_platform_parent.id=${p('pid')} AND integral_platform_parent.pid=0 AND integral_platform_parent.type=0
        AND integral_platform_parent.relation_id=0 AND integral_platform_parent.product_type=${p('product_type')}))`;
}

/** Shop uploads use the existing Admin library; suppliers may use their own
 * and platform library. Call only after the persisted owner passes the shared
 * public-candidate policy. This does not change the product's real owner. */
export function integralPublicMediaOwner(type: number, relationId: number) {
  return type === 1 ? { type: 0, relationId: 0 } : { type, relationId };
}
