import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, storeProductRelation, userLabel } from '@/models/schema';
import { outProductLabelIds, lockOutProductLabels, type OutProductLabelAdmission } from '@/services/out/OutProductLabelBindings';
import { assertSupplierProductLabelAuthority, type SupplierProductLabelActor } from './SupplierProductLabelService';
import { ValidateException, HttpApiException, ServiceUnavailableException } from '@/utils/errors';

export function supplierUserLabelCatalogQuery(query: URLSearchParams) {
  if ([...query.keys()].some(key => !['page', 'limit', 'keyword'].includes(key))
    || ['page', 'limit', 'keyword'].some(key => query.getAll(key).length > 1)) throw new ValidateException('用户标签目录查询参数错误');
  const integer = (name: string, fallback: number, maximum: number) => {
    const raw = query.get(name); if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > maximum) throw new ValidateException('用户标签目录分页参数错误');
    return Number(raw);
  };
  const keyword = (query.get('keyword') ?? '').trim();
  if (keyword.length > 128 || /[\u0000-\u001f]/.test(keyword)) throw new ValidateException('用户标签目录搜索词错误');
  return { page: integer('page', 1, 1_000_000), limit: integer('limit', 20, 50), keyword };
}


const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
export function supplierProductUserLabelInput(raw: Record<string, unknown>) {
  return Object.hasOwn(raw, 'label_id') && raw.label_id !== undefined ? outProductLabelIds(raw.label_id, 'user') : undefined;
}
export async function supplierUserLabelRelations(db: DbClient, productId: number, other = false) {
  return db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, productId),
    other ? ne(storeProductRelation.type, 4) : eq(storeProductRelation.type, 4))).orderBy(asc(storeProductRelation.id));
}
export interface SupplierUserLabelProof {
  main: Product; admission: OutProductLabelAdmission; relations: Relation[]; protectedRelations: Relation[];
}
const conflict = () => new HttpApiException('购买用户标签保存核对失败，请刷新后重试', 409, 409);
export async function replaceSupplierUserLabels(db: DbClient, supplierId: number, expected: Product,
  admission: OutProductLabelAdmission, original: Relation[]): Promise<SupplierUserLabelProof> {
  const [main] = await db.select().from(storeProduct).where(eq(storeProduct.id, expected.id));
  if (!main || main.type !== 2 || main.relationId !== supplierId || ![0, 1, 3].includes(main.productType)
    || main.isDel !== 0 || main.isShow !== 0 || main.isVerify !== 0 || main.labelId !== admission.ids.join(',')
    || !same(main, expected) || !same(await supplierUserLabelRelations(db, main.id), original)) throw conflict();
  const protectedRelations = await supplierUserLabelRelations(db, main.id, true);
  await db.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, main.id), eq(storeProductRelation.type, 4)));
  const now = Math.floor(Date.now()/1000);
  const relations = admission.ids.length ? await db.insert(storeProductRelation).values(admission.ids.map(relationId => ({
    productId: main.id, relationId, relationPid: 0, type: 4, status: 1, addTime: now,
  }))).returning() : [];
  if (relations.length !== admission.ids.length || relations.some((row, i) => row.productId !== main.id
    || row.relationId !== admission.ids[i] || row.type !== 4 || row.relationPid !== 0 || row.status !== 1 || row.addTime !== now)) throw conflict();
  const proof = { main, admission, relations: relations.sort((a,b)=>a.id-b.id), protectedRelations };
  await assertSupplierUserLabels(db, supplierId, proof); return proof;
}
export async function assertSupplierUserLabels(db: DbClient, supplierId: number, proof: SupplierUserLabelProof) {
  await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [main] = await db.select().from(storeProduct).where(eq(storeProduct.id, proof.main.id));
  const admitted = await lockOutProductLabels(db, 'user', proof.admission.ids);
  if (!main || main.type !== 2 || main.relationId !== supplierId || !same(main, proof.main)
    || !same(admitted, proof.admission) || !same(await supplierUserLabelRelations(db, main.id), proof.relations)
    || !same(await supplierUserLabelRelations(db, main.id, true), proof.protectedRelations)) throw conflict();
}

/** Historical foreign labels remain removable without exposing foreign names. */
export async function readSupplierUserLabels(db: DbClient, product: Pick<Product, 'id'|'labelId'>) {
  const truncated = [...product.labelId].length > 4096;
  let ids: number[] = [], parsed = !truncated;
  try {
    if (truncated || product.labelId !== '' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(product.labelId)) throw Error('Legacy CSV');
    ids = outProductLabelIds(product.labelId ? product.labelId.split(',') : [], 'user');
  } catch { parsed = false; }
  const relations = await db.select({ id: storeProductRelation.relationId, pid: storeProductRelation.relationPid, status: storeProductRelation.status })
    .from(storeProductRelation).where(and(eq(storeProductRelation.productId, product.id), eq(storeProductRelation.type, 4))).orderBy(asc(storeProductRelation.id)).limit(101);
  const labels = ids.length ? await db.select().from(userLabel).where(inArray(userLabel.id, ids)).orderBy(asc(userLabel.id)) : [];
  const byId = new Map(labels.map(row => [row.id,row]));
  const consistent = parsed && relations.length === ids.length && relations.every(row => row.pid === 0 && [0,1].includes(row.status))
    && same(relations.map(row=>row.id).sort((a,b)=>a-b), [...ids].sort((a,b)=>a-b));
  return { version: 1 as const, ids, entries: ids.map(id => { const row = byId.get(id), platform = row?.type === 0 && row.relationId === 0;
    return { id, title: platform ? row.name : '历史用户标签', available: platform && row.status === 1 }; }),
    consistent, truncated: truncated || relations.length > 100 };
}

/** Supplier orders use financial store zero. Fulfillment ownership does not
 * authorize type-2 Supplier or foreign store user labels. */
export async function supplierUserLabelCatalog(container: Container, supplierId: number, query: URLSearchParams,
  actor: SupplierProductLabelActor, runtimeConfigured: boolean) {
  const input = supplierUserLabelCatalogQuery(query), path = '/supplierapi/product/user-label/catalog';
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY`);
    await db.execute(sql`SET LOCAL statement_timeout='5s'`);
    await assertSupplierProductLabelAuthority(db, supplierId, actor, 'GET', path);
    const pattern = `%${input.keyword.replace(/[\\%_]/g, value=>'\\'+value)}%`;
    const where = and(eq(userLabel.type,0),eq(userLabel.relationId,0),eq(userLabel.status,1), input.keyword ? or(ilike(userLabel.name,pattern),
      /^\d{1,10}$/.test(input.keyword) && Number(input.keyword)<=2147483647 ? eq(userLabel.id,Number(input.keyword)) : undefined) : undefined);
    const [count] = await db.select({ total:sql<number>`count(*)::integer` }).from(userLabel).where(where);
    const list = await db.select({id:userLabel.id,title:userLabel.name}).from(userLabel).where(where).orderBy(desc(userLabel.id))
      .limit(input.limit).offset((input.page-1)*input.limit);
    await assertSupplierProductLabelAuthority(db,supplierId,actor,'GET',path);
    const result = {version:1 as const,list,count:count?.total??0,page:input.page,limit:input.limit,runtime_configured:runtimeConfigured};
    if (new TextEncoder().encode(JSON.stringify(result)).length>128*1024) throw new ServiceUnavailableException('用户标签目录响应过大');
    return result;
  });
}
