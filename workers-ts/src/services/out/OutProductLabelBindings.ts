import { and, asc, eq, inArray, is, sql } from 'drizzle-orm';
import { PgVarchar } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductLabel, storeProductRelation, userLabel } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { assertOutProductRelationFence, type OutProductRelationFence } from './OutProductRelationFence';

type Kind = 'product' | 'user';
type Label = typeof storeProductLabel.$inferSelect | typeof userLabel.$inferSelect;
type Group = typeof legacyCategory.$inferSelect;
type Product = typeof storeProduct.$inferSelect;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const relationType = (kind: Kind) => kind === 'product' ? 3 : 4;
const platform = (row: Label) => row.type === 0 && row.relationId === 0;
const active = (row: Label, kind: Kind) => platform(row) && row.status === 1
  && (kind === 'user' || 'isShow' in row && row.isShow === 1);
const validGroup = (row: Group | undefined) => !!row && row.type === 0 && row.relationId === 0
  && row.ownerId === 0 && row.group === 2 && row.isShow === 1;
const scope = (id: number, productType: 0 | 1 | 2 | 3 | 4) => and(eq(storeProduct.id, id), eq(storeProduct.type, 0),
  eq(storeProduct.relationId, 0), eq(storeProduct.productType, productType), eq(storeProduct.isDel, 0));

export function outProductLabelIds(value: unknown, kind: Kind): number[] {
  if (!Array.isArray(value) || value.length > 100) throw new ValidateException('标签须为最多100个编号的数组');
  const ids = value.map(entry => {
    // PHP's actual form submits IDs; its detail response contains id/name rows.
    // Echo names and owner/status metadata never become catalog authority.
    const raw = kind === 'user' && entry && typeof entry === 'object' && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).id : entry;
    const id = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : raw;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)
      throw new ValidateException('标签编号格式错误');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new ValidateException('标签编号不能重复');
  if (kind === 'user') {
    const column = storeProduct.labelId;
    if (!is(column, PgVarchar) || typeof column.length !== 'number' || !Number.isSafeInteger(column.length) || column.length < 1)
      throw new ValidateException('用户标签字段容量未就绪');
    if (ids.join(',').length > column.length)
      throw new ValidateException(`用户标签编号总长度不能超过${column.length}字符`);
  }
  return ids;
}
export function outProductLabelInput(body: Record<string, unknown>) {
  return {
    ...(Object.hasOwn(body, 'store_label_id') && body.store_label_id !== undefined
      ? { storeLabelIds: outProductLabelIds(body.store_label_id, 'product') } : {}),
    ...(Object.hasOwn(body, 'label_id') && body.label_id !== undefined
      ? { userLabelIds: outProductLabelIds(body.label_id, 'user') } : {}),
  };
}
function storedIds(raw: string | null) {
  const points = raw === null ? [] : [...raw.slice(0, 8194)], truncated = points.length > 4096;
  const display = raw === null ? null : truncated ? points.slice(0, 4096).join('') : raw;
  let ids: number[] = [], parsed = !truncated;
  try {
    if (truncated || raw !== null && raw !== '' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) throw Error('Malformed historical label CSV');
    ids = outProductLabelIds(raw === null || raw === '' ? [] : raw.split(','), 'product');
  } catch { parsed = false; }
  return { ids, parsed, raw: display, truncated };
}
async function catalog(tx: DbClient, kind: Kind, ids: readonly number[], lock: boolean): Promise<Label[]> {
  if (!ids.length) return [];
  if (kind === 'product') {
    const query = tx.select().from(storeProductLabel).where(inArray(storeProductLabel.id, [...ids])).orderBy(asc(storeProductLabel.id));
    return lock ? query.for('share', { noWait: true }) : query;
  }
  const query = tx.select().from(userLabel).where(inArray(userLabel.id, [...ids])).orderBy(asc(userLabel.id));
  return lock ? query.for('share', { noWait: true }) : query;
}
async function groups(tx: DbClient, kind: Kind, labels: readonly Label[], lock: boolean): Promise<Group[]> {
  if (kind !== 'product' || !labels.length) return [];
  const ids = [...new Set(labels.map(row => row.labelCate))];
  const query = tx.select().from(legacyCategory).where(inArray(legacyCategory.id, ids)).orderBy(asc(legacyCategory.id));
  return lock ? query.for('share', { noWait: true }) : query;
}
export interface OutProductLabelAdmission {
  kind: Kind;
  ids: readonly number[];
  catalog: Label[];
  groups: Group[];
}
export async function lockOutProductLabels(tx: DbClient, kind: Kind, ids: readonly number[]): Promise<OutProductLabelAdmission> {
  const rows = await catalog(tx, kind, ids, true);
  const selectedGroups = await groups(tx, kind, rows, true), byId = new Map(selectedGroups.map(row => [row.id, row]));
  if (rows.length !== ids.length || rows.some(row => !active(row, kind)
    || kind === 'product' && !validGroup(byId.get(row.labelCate))))
    throw new ValidateException('标签不存在、不属于平台、已停用或商品标签组不可用');
  return { kind, ids: [...ids], catalog: rows, groups: selectedGroups };
}
export interface OutProductLabelProof {
  productId: number;
  admission: OutProductLabelAdmission;
  relations: Array<typeof storeProductRelation.$inferSelect>;
  fence: OutProductRelationFence;
}
const scalar = (row: Product, kind: Kind) => kind === 'product' ? row.storeLabelId : row.labelId;
export async function replaceOutProductLabelBindings(tx: DbClient, productId: number,
  admission: OutProductLabelAdmission, fence: OutProductRelationFence): Promise<OutProductLabelProof> {
  const { kind, ids } = admission, type = relationType(kind);
  const [product] = await tx.select().from(storeProduct).where(scope(productId, fence.productType)).limit(1);
  if (!product || scalar(product, kind) !== ids.join(',')) throw new ValidateException('平台商品标签写入结果已变化');
  await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, productId), eq(storeProductRelation.type, type)));
  const now = Math.floor(Date.now() / 1000), relations = ids.length ? await tx.insert(storeProductRelation).values(ids.map(relationId => ({
    productId, relationId, relationPid: 0, type, status: 1, addTime: now,
  }))).returning() : [];
  if (relations.length !== ids.length || !same(relations.map(row => row.relationId), ids)
    || relations.some(row => row.productId !== productId || row.type !== type || row.relationPid !== 0 || row.status !== 1 || row.addTime !== now))
    throw new ValidateException('平台商品标签关联写入结果已变化');
  const proof = { productId, admission, relations, fence };
  await assertOutProductLabelBindings(tx, proof);
  return proof;
}
export async function assertOutProductLabelBindings(tx: DbClient, proof: OutProductLabelProof) {
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const { kind, ids } = proof.admission;
  const [product] = await tx.select().from(storeProduct).where(scope(proof.productId, proof.fence.productType)).limit(1);
  const relations = await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, proof.productId),
    eq(storeProductRelation.type, relationType(kind)))).orderBy(asc(storeProductRelation.id)).limit(101);
  const labels = await catalog(tx, kind, ids, false), selectedGroups = await groups(tx, kind, proof.admission.catalog, false);
  if (!product || scalar(product, kind) !== ids.join(',') || !same(relations, [...proof.relations].sort((a, b) => a.id - b.id))
    || !same(labels, proof.admission.catalog) || !same(selectedGroups, proof.admission.groups))
    throw new ValidateException('平台商品标签、目录或分组已变化');
  await assertOutProductRelationFence(tx, proof.fence);
}
async function selection(tx: DbClient, kind: Kind, product: Pick<Product, 'id' | 'storeLabelId' | 'labelId'>) {
  const stored = storedIds(kind === 'product' ? product.storeLabelId : product.labelId);
  const relations = await tx.select({ relationId: storeProductRelation.relationId, relationPid: storeProductRelation.relationPid,
    status: storeProductRelation.status }).from(storeProductRelation).where(and(eq(storeProductRelation.productId, product.id),
      eq(storeProductRelation.type, relationType(kind)))).orderBy(asc(storeProductRelation.id)).limit(101);
  const consistent = stored.parsed && relations.length === stored.ids.length
    && same(relations.map(row => row.relationId).sort((a, b) => a - b), [...stored.ids].sort((a, b) => a - b))
    && relations.every(row => row.relationPid === 0 && [0, 1].includes(row.status));
  const rows = await catalog(tx, kind, stored.ids, false), selectedGroups = await groups(tx, kind, rows, false);
  const byId = new Map(rows.map(row => [row.id, row])), byGroup = new Map(selectedGroups.map(row => [row.id, row]));
  return {
    labels: stored.ids.flatMap(id => { const row = byId.get(id); return row && platform(row)
      ? [{ id: row.id, label_name: 'labelName' in row ? row.labelName : row.name }] : []; }),
    metadata: { ids: stored.ids, relation_ids: relations.map(row => row.relationId), stored: stored.raw, consistent,
      available: consistent && rows.length === stored.ids.length && rows.every(row => active(row, kind)
        && (kind !== 'product' || validGroup(byGroup.get(row.labelCate)))), truncated: stored.truncated },
  };
}
export async function outProductLabelsSelection(tx: DbClient, product: Pick<Product, 'id' | 'storeLabelId' | 'labelId'>) {
  const productLabels = await selection(tx, 'product', product), userLabels = await selection(tx, 'user', product);
  return { store_label_id: productLabels.labels, store_label_selection: productLabels.metadata,
    label_id: userLabels.labels, label_selection: userLabels.metadata };
}
