import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { DB } from '@/dao/BaseDao';
import { storeCart, storeProduct, storeProductAttrValue, user, userBill, userBrokerage } from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { assertCashierOrdinaryReady, inspectCashierOrdinary } from '@/migrations/runCashierOrdinary';
import { CASHIER_ORDINARY_TABLES } from '@/migrations/cashierOrdinary';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from './CustomerWorkScope';
import { authorizeCustomerOperationOwner, freezeCustomerActor, freezeCustomerJson } from './CustomerWorkOperationRequest';
import { CUSTOMER_ORDINARY_CASHIER_VERSION, parseOrdinaryCashierDraft, parseOrdinaryCashierRowChange, parseOrdinaryCashierRemove, parseOrdinaryCashierAddRows,
  parseOrdinaryCashierIntent,parseOrdinaryCashierPayment,ordinaryCashierObject, type OrdinaryCashierDraft, type OrdinaryCashierIntent } from './CustomerOrdinaryCashierContract';

export type OrdinaryCashierOperationKind = 'draft' | 'append' | 'quantity' | 'remove' | 'creation' | 'payment' | 'abandon';
export type OrdinaryCashierOriginalKind=Exclude<OrdinaryCashierOperationKind,'abandon'>;
export function parseOrdinaryCashierOperationIntent(kind:unknown,value:unknown){
  switch(kind){
    case 'draft':return parseOrdinaryCashierDraft(value);
    case 'append':return parseOrdinaryCashierAddRows(value);
    case 'quantity':return parseOrdinaryCashierRowChange(value);
    case 'remove':return parseOrdinaryCashierRemove(value);
    case 'creation':return parseOrdinaryCashierIntent(value);
    case 'payment':return parseOrdinaryCashierPayment(value);
    default:throw new ValidateException('普通收银原操作类型无效');
  }
}
export interface OrdinaryCashierOperationReceipt {
  version: 'customer-cashier-ordinary-receipt-v1'; actor_uid: number; request_key: string; request_hash: string;
  scope_key: string; kind: OrdinaryCashierOperationKind; intent: Record<string, unknown>; evidence: Record<string, unknown>;
}
export const ordinaryCashierJson = (value: unknown) => JSON.stringify(freezeCustomerJson(value));
const invalid = () => new ValidateException('普通收银原购物行或原请求来源无法核对');
export async function lockOrdinaryCashierRequest(tx: DbClient, actorUid: number, key: string, draftKey?: string) {
  if (Object.hasOwn(tx, '$client')) throw Error('Ordinary cashier writes require caller-owned transaction');
  await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('lock_timeout','1500ms',true),set_config('statement_timeout','5000ms',true)`);
  if (!(await inspectCashierOrdinary(tx)).complete) throw new HttpApiException('普通收银来源尚未验收，请保留原编号',503,503);
  await tx.execute(sql.raw(`LOCK TABLE ${CASHIER_ORDINARY_TABLES.map(t=>`public.${t}`).join(',')} IN ROW SHARE MODE NOWAIT`));
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731735,${parseInt((await outRequestHash([actorUid, key])).slice(0, 8), 16) | 0})`);
  if (draftKey) await tx.execute(sql`SELECT pg_advisory_xact_lock(731736,${parseInt((await outRequestHash([actorUid, draftKey])).slice(0, 8), 16) | 0})`);
}
export async function authorizeOrdinaryCashierWrite(tx: DbClient, actor: CustomerWorkActor, scopeKey: string) {
  await assertCashierOrdinaryReady(tx);
  await authorizeCustomerOperationOwner(tx, actor);
  await acquireCustomerWorkScopeLock(tx, actor.uid);
  const scope = await authorizeCustomerWorkActor(tx, actor);
  if (scope.scope_key !== scopeKey) throw new HttpApiException('普通收银经营资格已变化，请重新读取', 403, 403);
  return scope;
}
export async function authorizeOrdinaryCashierReceiptOwner(db: DbClient, actor: CustomerWorkActor) {
  const [account] = await db.select({ uid: user.uid, status: user.status, isDel: user.isDel, deleteTime: user.deleteTime,
    auth: sql<string>`md5(${user.pwd})` }).from(user).where(eq(user.uid, actor.uid)).limit(1);
  if (actor.expires_at <= Math.floor(Date.now() / 1000) || !account || account.status !== 1 || account.isDel || account.deleteTime !== null
    || account.auth !== actor.auth_version) throw new HttpApiException('原收银会话已失效，请重新登录核对', 403, 403);
}
export async function readOrdinaryCashierOperation(db: DB, actorUid: number, key: string): Promise<OrdinaryCashierOperationReceipt | null> {
  if (!(await inspectCashierOrdinary(db)).complete) throw new HttpApiException('普通收银原请求台账尚未验收，请保留原编号', 503, 503);
  const rows = await db.execute<{ request_key: string; kind: OrdinaryCashierOperationKind; request_hash: string; scope_key: string;
    intent_json: string | null; evidence_json: string | null; evidence_hash: string }>(sql`
    SELECT request_key::text,kind,request_hash,scope_key,
      CASE WHEN octet_length(intent_json)<=262144 THEN intent_json END AS intent_json,
      CASE WHEN octet_length(evidence_json)<=262144 THEN evidence_json END AS evidence_json,evidence_hash
    FROM public.cashier_ordinary_operation_v1 WHERE actor_uid=${actorUid} AND request_key=${key}::uuid LIMIT 2`);
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0].intent_json || !rows[0].evidence_json) throw invalid();
  const row = rows[0]; let intent: Record<string, unknown>, evidence: Record<string, unknown>;
  try { intent = JSON.parse(row.intent_json!) as Record<string, unknown>; evidence = JSON.parse(row.evidence_json!) as Record<string, unknown>; }
  catch { throw invalid(); }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || ordinaryCashierJson(intent) !== row.intent_json || ordinaryCashierJson(evidence) !== row.evidence_json
    || await outRequestHash(intent) !== row.request_hash || await outRequestHash(evidence) !== row.evidence_hash
    || intent.scope_key !== row.scope_key || !['draft', 'append', 'quantity', 'remove', 'creation', 'payment', 'abandon'].includes(row.kind)) throw invalid();
  const originalKind=row.kind==='abandon'?evidence.original_kind:row.kind;
  const parsed=parseOrdinaryCashierOperationIntent(originalKind,intent);
  if(ordinaryCashierJson(parsed)!==row.intent_json||row.request_key!==key)throw invalid();
  if(row.kind==='abandon'){
    ordinaryCashierObject(evidence,['outcome','original_kind']);if(evidence.outcome!=='operation-abandoned')throw invalid();
  }else{
    const expected={draft:'draft-created',append:'rows-appended',quantity:'quantity-changed',remove:'rows-removed',creation:'order-created'} as const;
    if(row.kind==='payment'){
      if(evidence.outcome!=='cash-paid'&&evidence.outcome!=='zero-paid')throw invalid();
    }else if(evidence.outcome!==expected[row.kind])throw invalid();
  }
  return { version: 'customer-cashier-ordinary-receipt-v1', actor_uid: actorUid, request_key: key, request_hash: row.request_hash,
    scope_key: row.scope_key, kind: row.kind, intent, evidence };
}
export async function priorOrdinaryCashierOperation(db: DbClient, actorUid: number, key: string, kind: OrdinaryCashierOperationKind, intent: unknown) {
  const receipt = await readOrdinaryCashierOperation(db, actorUid, key);
  const matchingAbandon=receipt?.kind==='abandon'&&receipt.evidence.outcome==='operation-abandoned'&&receipt.evidence.original_kind===kind;
  if (receipt && (receipt.kind !== kind&&!matchingAbandon || receipt.request_hash !== await outRequestHash(intent)))
    throw new HttpApiException('原普通收银编号已绑定其他内容或操作', 409, 409);
  return receipt;
}
/** Original UID+UUID shares the same transaction lock as every business POST.
 * NULL from a GET is insufficient; this immutable outcome fences late writes. */
export async function abandonOrdinaryCashierOperation(container:Container,actorValue:CustomerWorkActor,keyValue:unknown,value:unknown){
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),body=ordinaryCashierObject(value,['kind','intent']),
    kind=body.kind as OrdinaryCashierOriginalKind,intent=parseOrdinaryCashierOperationIntent(body.kind,body.intent),requestHash=await outRequestHash(intent);
  return withTx(container,async tx=>{
    await lockOrdinaryCashierRequest(tx,actor.uid,key);
    await authorizeCustomerOperationOwner(tx,actor);
    const original=await readOrdinaryCashierOperation(tx,actor.uid,key);
    if(original){if(original.request_hash!==requestHash||original.scope_key!==intent.scope_key
      ||original.kind!==kind&&!(original.kind==='abandon'&&original.evidence.original_kind===kind&&original.evidence.outcome==='operation-abandoned'))
        throw new HttpApiException('原普通收银编号已绑定其他内容或操作',409,409);
      return{receipt:original,replayed:true};}
    const draftKey=kind==='draft'?key:'draft_key'in intent?intent.draft_key:null,orderId='order_id'in intent?intent.order_id:null;
    const receipt=await appendOrdinaryCashierOperation(tx,actor.uid,key,'abandon',intent as unknown as Record<string,unknown>,
      {outcome:'operation-abandoned',original_kind:kind},draftKey,orderId);
    await authorizeCustomerOperationOwner(tx,actor);
    return{receipt,replayed:false};
  });
}
export async function appendOrdinaryCashierOperation(tx: DbClient, actorUid: number, key: string, kind: OrdinaryCashierOperationKind,
  intentValue: Record<string, unknown>, evidenceValue: Record<string, unknown>, draftKey: string | null, orderId: number | null) {
  const intent = ordinaryCashierJson(intentValue), evidence = ordinaryCashierJson(evidenceValue);
  await tx.execute(sql`INSERT INTO public.cashier_ordinary_operation_v1(actor_uid,request_key,kind,request_hash,scope_key,draft_key,order_id,intent_json,evidence_json,evidence_hash)
    VALUES(${actorUid},${key}::uuid,${kind},${await outRequestHash(intentValue)},${String(intentValue.scope_key)},${draftKey}::uuid,${orderId},${intent},${evidence},${await outRequestHash(evidenceValue)})`);
  const actual = await readOrdinaryCashierOperation(tx, actorUid, key);
  if (!actual || ordinaryCashierJson(actual.evidence) !== evidence) throw invalid();
  return actual;
}
export async function assertOrdinaryBuyer(db: DbClient, buyerUid: number, pin = false) {
  if (buyerUid > 0) {
    const query = db.select({ uid: user.uid }).from(user).where(and(eq(user.uid, buyerUid), eq(user.status, 1), eq(user.isDel, 0), sql`${user.deleteTime} IS NULL`)).limit(1);
    if ((await (pin ? query.for('share', { noWait: true }) : query)).length !== 1) throw new ValidateException('购买会员已失效');
  } else {
    const [accounts, bills, brokerage] = await Promise.all([db.select({ uid: user.uid }).from(user).where(eq(user.uid, 0)).limit(1),
      db.select({ id: userBill.id }).from(userBill).where(eq(userBill.uid, 0)).limit(1),
      db.select({ id: userBrokerage.id }).from(userBrokerage).where(eq(userBrokerage.uid, 0)).limit(1)]);
    if (accounts.length || bills.length || brokerage.length) throw new ValidateException('游客身份不能使用伪造的会员账户或余额积分账目');
  }
}
export async function assertOrdinaryProductSelection(db: DbClient, productId: number, skuUnique: string, quantity: number) {
  const [product] = await db.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
  const skus = await db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId),
    eq(storeProductAttrValue.unique, skuUnique), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0))).limit(2);
  if (!product || product.pid !== 0 || product.productType !== 0 || product.isShow !== 1 || product.isVerify !== 1
    || product.isDel || product.isPresaleProduct !== 0 || product.stock < quantity || skus.length !== 1 || skus[0].stock < quantity)
    throw new ValidateException('普通商品或规格已下架、未审核或库存不足');
  return { product, sku: skus[0] };
}
export async function readOrdinaryCashierDraft(db: DbClient, actorUid: number, key: string, lock = false) {
  if (!(await inspectCashierOrdinary(db)).complete) throw new HttpApiException('普通收银购物来源尚未验收',503,503);
  const headers = await db.execute<{ buyer_uid: number; tourist_hash: string; scope_key: string; request_hash: string; intent_json: string }>(sql`
    SELECT buyer_uid,tourist_hash,scope_key,request_hash,intent_json FROM public.cashier_ordinary_draft_v1
    WHERE actor_uid=${actorUid} AND draft_key=${key}::uuid LIMIT 2`);
  if (headers.length !== 1) throw new NotFoundException('原普通收银购物车不存在');
  const header = headers[0]; let initial: OrdinaryCashierDraft;
  try { initial = parseOrdinaryCashierDraft(JSON.parse(header.intent_json)); } catch { throw invalid(); }
  if (header.buyer_uid !== initial.buyer_uid || header.scope_key !== initial.scope_key || header.tourist_hash !== await outRequestHash(initial.tourist_key)
    || header.intent_json !== ordinaryCashierJson(initial) || header.request_hash !== await outRequestHash(initial)) throw invalid();
  const mappings = await db.execute<{ cart_id: number; product_id: number; sku_unique: string; created_quantity: number; source_json: string; source_hash: string }>(sql`
    SELECT cart_id,product_id,sku_unique,created_quantity,source_json,source_hash FROM public.cashier_ordinary_cart_v1
    WHERE actor_uid=${actorUid} AND draft_key=${key}::uuid ORDER BY cart_id LIMIT 201`);
  if (!mappings.length || mappings.length > 200) throw invalid();
  const query = db.select().from(storeCart).where(inArray(storeCart.id, mappings.map(row => row.cart_id))).orderBy(asc(storeCart.id));
  const rows = await (lock ? query.for('update') : query);
  if (rows.length !== mappings.length) throw invalid();
  for (const row of rows) {
    const mapping = mappings.find(m => m.cart_id === row.id);
    if(!mapping)throw invalid();
    let source:Record<string,unknown>;try{source=ordinaryCashierObject(JSON.parse(mapping.source_json),['actor_uid','draft_key','buyer_uid','tourist_hash','product_id','sku_unique','quantity','request_key']);}catch{throw invalid();}
    if(ordinaryCashierJson(source)!==mapping.source_json||await outRequestHash(source)!==mapping.source_hash||source.actor_uid!==actorUid||source.draft_key!==key
      ||source.buyer_uid!==initial.buyer_uid||source.tourist_hash!==header.tourist_hash||source.product_id!==row.productId||source.sku_unique!==row.productAttrUnique
      ||source.quantity!==mapping.created_quantity||normalizeOutRequestKey(source.request_key)!==source.request_key)throw invalid();
    if (mapping.product_id !== row.productId || mapping.sku_unique !== row.productAttrUnique
      || row.uid !== initial.buyer_uid || row.staffId !== actorUid || row.touristUid !== initial.tourist_key
      || row.productType !== 0 || row.type !== 0 || row.activityId !== 0 || row.isNew !== 1 || row.status !== 1
      || ![0, 1].includes(row.isDel) || ![0, 1].includes(row.isPay) || row.cartNum < 1 || row.cartNum > 32767) throw invalid();
  }
  const draft_hash = await outRequestHash({ version: CUSTOMER_ORDINARY_CASHIER_VERSION, actor_uid: actorUid, draft_key: key,
    request_hash: header.request_hash, rows: rows.map(row => ({ cart_id: row.id, product_id: row.productId, sku_unique: row.productAttrUnique,
      quantity: row.cartNum, removed: row.isDel, consumed: row.isPay })) });
  return { version: CUSTOMER_ORDINARY_CASHIER_VERSION, actor_uid: actorUid, draft_key: key, draft_hash, scope_key: header.scope_key,
    buyer_uid: initial.buyer_uid, tourist_key: initial.tourist_key, rows: rows.map(row => ({ cart_id: row.id, product_id: row.productId,
      sku_unique: row.productAttrUnique, quantity: row.cartNum, removed: row.isDel === 1, consumed: row.isPay === 1 })) };
}
export function assertOrdinaryDraftIntent(draft: Awaited<ReturnType<typeof readOrdinaryCashierDraft>>, intent: OrdinaryCashierIntent) {
  if (draft.draft_key !== intent.draft_key || draft.draft_hash !== intent.draft_hash || draft.scope_key !== intent.scope_key
    || draft.buyer_uid !== intent.buyer_uid || draft.tourist_key !== intent.tourist_key || !draft.rows.some(r => !r.removed && !r.consumed)
    || draft.rows.some(r => !r.removed && r.consumed)) throw new ValidateException('购物车身份、完整行或报价前数量已变化，请重新读取');
}
export async function prepareOrdinaryCashierDraft(container: Container, actorValue: CustomerWorkActor, keyValue: unknown, body: unknown) {
  const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), intent = parseOrdinaryCashierDraft(body);
  return withTx(container, async tx => {
    await lockOrdinaryCashierRequest(tx, actor.uid, key, key); await authorizeOrdinaryCashierWrite(tx, actor, intent.scope_key);
    const prior = await priorOrdinaryCashierOperation(tx, actor.uid, key, 'draft', intent);
    if (prior) return { receipt: prior, replayed: true };
    await assertOrdinaryBuyer(tx, intent.buyer_uid, true);
    for (const row of intent.rows) await assertOrdinaryProductSelection(tx, row.product_id, row.sku_unique, row.quantity);
    await tx.execute(sql`INSERT INTO public.cashier_ordinary_draft_v1(actor_uid,draft_key,buyer_uid,tourist_hash,scope_key,request_hash,intent_json)
      VALUES(${actor.uid},${key}::uuid,${intent.buyer_uid},${await outRequestHash(intent.tourist_key)},${intent.scope_key},${await outRequestHash(intent)},${ordinaryCashierJson(intent)})`);
    for (const row of intent.rows) {
      const [cart] = await tx.insert(storeCart).values({ uid: intent.buyer_uid, touristUid: intent.tourist_key, staffId: actor.uid,
        productId: row.product_id, productType: 0, productAttrUnique: row.sku_unique, cartNum: row.quantity, type: 0, activityId: 0,
        isNew: 1, addTime: Math.floor(Date.now() / 1000) }).returning();
      if (!cart) throw Error('Actual ordinary cashier cart did not persist');
      const source={actor_uid:actor.uid,draft_key:key,buyer_uid:intent.buyer_uid,tourist_hash:await outRequestHash(intent.tourist_key),product_id:row.product_id,
        sku_unique:row.sku_unique,quantity:row.quantity,request_key:key};
      await tx.execute(sql`INSERT INTO public.cashier_ordinary_cart_v1(cart_id,actor_uid,draft_key,product_id,sku_unique,created_quantity,source_json,source_hash)
        VALUES(${cart.id},${actor.uid},${key}::uuid,${row.product_id},${row.sku_unique},${row.quantity},${ordinaryCashierJson(source)},${await outRequestHash(source)})`);
    }
    const draft = await readOrdinaryCashierDraft(tx, actor.uid, key);
    return { receipt: await appendOrdinaryCashierOperation(tx, actor.uid, key, 'draft', intent as unknown as Record<string, unknown>,
      { outcome: 'draft-created', draft }, key, null), replayed: false };
  });
}
export async function appendOrdinaryCashierRows(container:Container,actorValue:CustomerWorkActor,keyValue:unknown,body:unknown) {
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),intent=parseOrdinaryCashierAddRows(body);
  return withTx(container,async tx=>{
    await lockOrdinaryCashierRequest(tx,actor.uid,key,intent.draft_key);await authorizeOrdinaryCashierWrite(tx,actor,intent.scope_key);
    const prior=await priorOrdinaryCashierOperation(tx,actor.uid,key,'append',intent);if(prior)return{receipt:prior,replayed:true};
    const draft=await readOrdinaryCashierDraft(tx,actor.uid,intent.draft_key,true);
    if(draft.scope_key!==intent.scope_key||draft.draft_hash!==intent.draft_hash||draft.rows.some(r=>r.consumed))throw new HttpApiException('原购物车已变化或已下单',409,409);
    await assertOrdinaryBuyer(tx,draft.buyer_uid,true);
    const additions=intent.rows.filter(r=>!draft.rows.some(c=>c.product_id===r.product_id&&c.sku_unique===r.sku_unique));
    if(draft.rows.length+additions.length>200)throw new ValidateException('收银完整购物来源最多200个规格，请先核对并重新建立购物车');
    for(const row of intent.rows){
      const previous=draft.rows.find(c=>c.product_id===row.product_id&&c.sku_unique===row.sku_unique),quantity=previous&&!previous.removed?previous.quantity+row.quantity:row.quantity;
      if(quantity>32767)throw new ValidateException('同一规格累计数量超过32767');
      await assertOrdinaryProductSelection(tx,row.product_id,row.sku_unique,quantity);
      if(previous){const changed=await tx.update(storeCart).set({cartNum:quantity,isDel:0}).where(and(eq(storeCart.id,previous.cart_id),eq(storeCart.staffId,actor.uid),
        eq(storeCart.uid,draft.buyer_uid),eq(storeCart.touristUid,draft.tourist_key),eq(storeCart.cartNum,previous.quantity),eq(storeCart.isPay,0))).returning({id:storeCart.id});if(changed.length!==1)throw invalid();}
      else{
        const[cart]=await tx.insert(storeCart).values({uid:draft.buyer_uid,touristUid:draft.tourist_key,staffId:actor.uid,productId:row.product_id,productType:0,
          productAttrUnique:row.sku_unique,cartNum:quantity,type:0,activityId:0,isNew:1,addTime:Math.floor(Date.now()/1000)}).returning();if(!cart)throw invalid();
        const source={actor_uid:actor.uid,draft_key:intent.draft_key,buyer_uid:draft.buyer_uid,tourist_hash:await outRequestHash(draft.tourist_key),product_id:row.product_id,
          sku_unique:row.sku_unique,quantity,request_key:key};
        await tx.execute(sql`INSERT INTO public.cashier_ordinary_cart_v1(cart_id,actor_uid,draft_key,product_id,sku_unique,created_quantity,source_json,source_hash)
          VALUES(${cart.id},${actor.uid},${intent.draft_key}::uuid,${row.product_id},${row.sku_unique},${quantity},${ordinaryCashierJson(source)},${await outRequestHash(source)})`);
      }
    }
    return{receipt:await appendOrdinaryCashierOperation(tx,actor.uid,key,'append',intent as unknown as Record<string,unknown>,
      {outcome:'rows-appended',draft:await readOrdinaryCashierDraft(tx,actor.uid,intent.draft_key)},intent.draft_key,null),replayed:false};
  });
}
export async function changeOrdinaryCashierRows(container: Container, actorValue: CustomerWorkActor, keyValue: unknown, kind: 'quantity' | 'remove', body: unknown) {
  const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), intent = kind === 'quantity' ? parseOrdinaryCashierRowChange(body) : parseOrdinaryCashierRemove(body);
  return withTx(container, async tx => {
    await lockOrdinaryCashierRequest(tx, actor.uid, key, intent.draft_key); await authorizeOrdinaryCashierWrite(tx, actor, intent.scope_key);
    const prior = await priorOrdinaryCashierOperation(tx, actor.uid, key, kind, intent);
    if (prior) return { receipt: prior, replayed: true };
    const draft = await readOrdinaryCashierDraft(tx, actor.uid, intent.draft_key, true);
    if (draft.scope_key !== intent.scope_key || draft.draft_hash !== intent.draft_hash || draft.rows.some(r => r.consumed))
      throw new HttpApiException('原购物车已变化或已下单，请先核对原请求', 409, 409);
    const ids = 'cart_id' in intent ? [intent.cart_id] : [...intent.cart_ids];
    if (ids.some(id => !draft.rows.some(r => r.cart_id === id && !r.removed))) throw invalid();
    if ('quantity' in intent) {
      const row = draft.rows.find(r => r.cart_id === intent.cart_id)!;
      await assertOrdinaryProductSelection(tx, row.product_id, row.sku_unique, intent.quantity);
      const changed = await tx.update(storeCart).set({ cartNum: intent.quantity }).where(and(eq(storeCart.id, row.cart_id),
        eq(storeCart.staffId, actor.uid), eq(storeCart.uid, draft.buyer_uid), eq(storeCart.touristUid, draft.tourist_key),
        eq(storeCart.cartNum, row.quantity), eq(storeCart.isDel, 0), eq(storeCart.isPay, 0))).returning({ id: storeCart.id });
      if (changed.length !== 1) throw invalid();
    } else {
      const changed = await tx.update(storeCart).set({ isDel: 1 }).where(and(inArray(storeCart.id, ids), eq(storeCart.staffId, actor.uid),
        eq(storeCart.uid, draft.buyer_uid), eq(storeCart.touristUid, draft.tourist_key), eq(storeCart.isDel, 0), eq(storeCart.isPay, 0))).returning({ id: storeCart.id });
      if (changed.length !== ids.length) throw invalid();
    }
    return { receipt: await appendOrdinaryCashierOperation(tx, actor.uid, key, kind, intent as unknown as Record<string, unknown>,
      { outcome: kind === 'quantity' ? 'quantity-changed' : 'rows-removed', draft: await readOrdinaryCashierDraft(tx, actor.uid, intent.draft_key) }, intent.draft_key, null), replayed: false };
  });
}
