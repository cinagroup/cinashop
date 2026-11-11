/** Execute-time statement snapshot and atomic append-only effect. Only the genuine
 * task processor calls this inside its owned lease/result transaction. */
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { user, userLabelRelation } from '@/models/schema';
import { purchasedLabelIds, type PurchasedLabelIntent } from './PurchasedProductLabelCodec';
import { purchasedLabelSelection, type PurchasedLabelCatalogRow } from './PurchasedProductLabelSelection';
import { capturePurchasedLabelResult, type PurchasedLabelProductConfig, type PurchasedLabelBundleConfig } from './PurchasedProductLabelResult';
import { verifyActualPurchasedLabelSource } from './PurchasedProductLabelSource';
export async function grantPurchasedProductLabelsTx(tx: DbClient, intent: PurchasedLabelIntent,
  taskId: string, sourceHash: string, completedAt: number) {
  if (Object.hasOwn(tx, '$client')) throw Error('购买标签授予须使用任务所属事务');
  await verifyActualPurchasedLabelSource(tx, intent);
  const [account] = await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, intent.userId)).limit(1).for('update', { noWait: true });
  if (!account) throw Error('购买标签用户不存在');
  const productIds = [...new Set(intent.carts.map(c => c.productId))].sort((a, b) => a-b);
  // Fixed PHP getColumn/value query by ID only: soft-deleted/hidden goods and
  // closed type5 bundles still supply current labels; physically missing rows
  // supply none. No catalog status or ownership filter is invented here.
  // Acquire the user lock before this READ COMMITTED statement takes its fresh
  // snapshot. Products, bundle, label scopes and existing memberships all come
  // from this ONE snapshot. RR's earlier metadata snapshot could miss a grant
  // committed just before its user lock, since locking does not version a row.
  // This also coordinates with the existing RC promotion/Admin label writers
  // without changing user facts or requiring new source-table privileges.
  const bundleNeeded = intent.orderType === 5 && intent.activityId > 0;
  const [snapshot] = await tx.execute<{
    products: PurchasedLabelProductConfig[]; bundle: PurchasedLabelBundleConfig | null;
    catalog: PurchasedLabelCatalogRow[]; memberships: Array<{ labelId: number; type: number; relationId: number }>;
  }>(sql`WITH wanted AS MATERIALIZED(SELECT unnest(ARRAY[${sql.join(productIds.map(id => sql`${id}`),sql`, `)}]::integer[]) AS id),
    products AS MATERIALIZED(SELECT p.id,p.label_id FROM public.store_product p JOIN wanted w ON w.id=p.id),
    bundle AS MATERIALIZED(SELECT id,link_ids FROM public.store_discounts WHERE ${bundleNeeded} AND id=${intent.activityId}),
    configured AS MATERIALIZED(SELECT label_id AS ids FROM products UNION ALL SELECT link_ids FROM bundle),
    tokens AS MATERIALIZED(SELECT btrim(t.token) AS token FROM configured c CROSS JOIN LATERAL regexp_split_to_table(COALESCE(c.ids,''),',') AS t(token)),
    numbers AS MATERIALIZED(SELECT CASE WHEN token~'^[0-9]{1,10}$' THEN token::bigint ELSE 0 END AS n FROM tokens),
    requested AS MATERIALIZED(SELECT DISTINCT CASE WHEN n BETWEEN 1 AND 2147483647 THEN n::integer ELSE NULL END AS id FROM numbers),
    catalog AS MATERIALIZED(SELECT l.id,l.type,l.relation_id,l.status FROM public.user_label l WHERE l.id IN(SELECT id FROM requested)
      ORDER BY l.id LIMIT 10001 FOR SHARE NOWAIT),
    memberships AS MATERIALIZED(SELECT label_id,type,relation_id FROM public.user_label_relation WHERE uid=${intent.userId}
      AND (type=0 AND relation_id=0 OR ${intent.financialStoreId}::integer>0 AND type=1 AND relation_id=${intent.financialStoreId})
      AND label_id IN(SELECT id FROM requested) ORDER BY id LIMIT 10001)
    SELECT (SELECT COALESCE(jsonb_agg(jsonb_build_object('productId',w.id,'found',p.id IS NOT NULL,'labelIds',p.label_id) ORDER BY w.id),'[]'::jsonb)
      FROM wanted w LEFT JOIN products p ON p.id=w.id) AS products,
      CASE WHEN ${bundleNeeded} THEN jsonb_build_object('activityId',${intent.activityId}::integer,'found',EXISTS(SELECT 1 FROM bundle),'linkIds',(SELECT link_ids FROM bundle)) ELSE NULL END AS bundle,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'type',type,'relationId',relation_id,'status',status) ORDER BY id),'[]'::jsonb) FROM catalog) AS catalog,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('labelId',label_id,'type',type,'relationId',relation_id)),'[]'::jsonb) FROM memberships) AS memberships`);
  if (!snapshot) throw Error('购买标签配置快照缺失');
  const { products, bundle, catalog, memberships } = snapshot;
  const requested = [...new Set([...products.flatMap(p => purchasedLabelIds(p.labelIds)), ...purchasedLabelIds(bundle?.linkIds ?? null)])].sort((a, b) => a-b);
  if (requested.length > 10000) throw Error('购买标签配置容量超限');
  const selection = purchasedLabelSelection(requested, catalog, intent.financialStoreId);
  if (memberships.length > 10000) throw Error('购买标签既有关系容量超限');
  const owned = new Set(memberships.map(r => `${r.labelId}:${r.type}:${r.relationId}`));
  const targets = selection.targets.map(t => ({ ...t, added: !owned.has(`${t.labelId}:${t.type}:${t.relationId}`) }));
  const result = capturePurchasedLabelResult({ format: 1, taskId, sourceHash, userId: intent.userId, financialStoreId: intent.financialStoreId,
    products, bundle, targets, skipped: selection.skipped, completedAt }, intent, taskId, sourceHash);
  const missing = targets.filter(t => t.added).map(t => ({ uid: intent.userId, type: t.type, relationId: t.relationId, labelId: t.labelId }));
  if (missing.length) await tx.insert(userLabelRelation).values(missing);
  return result;
}
