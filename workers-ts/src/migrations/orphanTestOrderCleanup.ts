import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { DbClient } from '../lib/di';
import { collectOrphanTestOrderSnapshot, configureOrphanInspection, orphanCleanupContext,
  ORPHAN_CLEANUP_TABLES, ORPHAN_TEST_PREDICATE, snapshotHash } from './orphanTestOrderSnapshot';

type Snapshot = Awaited<ReturnType<typeof collectOrphanTestOrderSnapshot>>;
type Table = typeof ORPHAN_CLEANUP_TABLES[number];
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = () => { throw Error('Orphan cleanup scope or ownership mismatch'); };
function record(text: string): Record<string, unknown> {
  const r: unknown = JSON.parse(text);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return fail();
  return r as Record<string, unknown>;
}
function id(r: Record<string, unknown>): number {
  if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || r.id <= 0) return fail();
  return r.id;
}

/** This reviewed operation has exactly 12 orders and 46 verified dependent
 * records. The numeric extract link collision is deliberately preserved. No
 * balances, stock, users, shopping carts, sequences or provider APIs are changed. */
export function orphanCleanupPlan(snapshot: Snapshot) {
  if (snapshot.orders.length !== 12 || snapshot.descendants.length) return fail();
  const orders = snapshot.orders.map(o => record(o.row_json));
  const byId = new Map(orders.map(o => [id(o),o]));
  const byNo = new Map(orders.map(o => [o.order_id,o]));
  if (byId.size !== 12 || byNo.size !== 12 || orders.some(o => o.pay_type !== 'yue' || o.pid !== 0
    || o.paid !== 1 || o.refund_status !== 0 || o.is_del !== 0)) return fail();
  const plan: Record<Table, { id: number; sha256: string }[]> = {
    store_order: snapshot.orders.map(o=>({id:o.id,sha256:hash(o.row_json)})),
    store_order_cart_info: [], store_order_refund: [], store_order_status: [],
    store_product_reply: [], user_bill: [], user_brokerage: [],
  };
  let preserved = 0;
  for (const table of snapshot.related) {
    if (!table.rows.length) continue;
    if (!ORPHAN_CLEANUP_TABLES.some(t=>t === table.table) || table.table === 'store_order') return fail();
    const name = table.table as Table;
    for (const text of table.rows) {
      const r = record(text), key = id(r);
      if (name === 'user_brokerage' && r.type === 'extract' && r.category === 'extract'
        && r.pm === 0 && r.status === -1 && typeof r.link_id === 'string'
        && /^\d+$/.test(r.link_id) && byId.has(Number(r.link_id)) && !byNo.has(r.link_id)) {
        preserved++; continue;
      }
      const order = ['user_bill','user_brokerage'].includes(name) ? byNo.get(r.link_id)
        : byId.get(Number(name === 'store_order_refund' ? r.store_order_id : r.oid));
      if (!order) return fail();
      if (name !== 'store_order_status' && name !== 'user_brokerage' && r.uid !== order.uid) return fail();
      if (name === 'user_bill' && !(r.type === 'pay_product' && r.category === 'now_money' && r.pm === 0 && r.status === 1)) return fail();
      // Legacy test commissions use the public order number, not a numeric order
      // id. Their order_brokerage domain is independent of the extract domain.
      if (name === 'user_brokerage' && !(r.type === 'order_brokerage' && ['one_brokerage','two_brokerage'].includes(String(r.category))
        && r.pm === 1 && r.status === 1)) return fail();
      if (name === 'store_order_refund' && !(r.refund_type === 0 && Number(r.refunded_price) === 0 && r.apply_type === 1)) return fail();
      if (name === 'store_product_reply') {
        const line = snapshot.related.find(t=>t.table === 'store_order_cart_info')?.rows.map(record)
          .find(l=>l.id === r.order_cart_info_id);
        if (!line || line.oid !== r.oid || line.uid !== r.uid) return fail();
      }
      plan[name].push({id:key,sha256:hash(text)});
    }
  }
  const counts: Record<Table,number> = {store_order:12,store_order_cart_info:12,store_order_refund:2,
    store_order_status:14,store_product_reply:2,user_bill:12,user_brokerage:4};
  for (const table of ORPHAN_CLEANUP_TABLES) if (plan[table].length !== counts[table]
    || new Set(plan[table].map(r=>r.id)).size !== counts[table]) return fail();
  if (preserved !== 1) return fail();
  return {plan,preserved};
}

export async function cleanupFingerprint(tx: postgres.TransactionSql, excluded?: ReturnType<typeof orphanCleanupPlan>['plan']) {
  const result = [];
  for (const table of [...ORPHAN_CLEANUP_TABLES,'user']) {
    const ids = excluded && table !== 'user' ? excluded[table as Table].map(r=>r.id) : [];
    const identity = table === 'user' ? 'uid' : 'id';
    const [budget] = await tx.unsafe<{ n:number }[]>(`SELECT count(*)::integer AS n FROM (SELECT 1 FROM public."${table}" LIMIT 1001) t`);
    if (budget.n > 1000) throw Error('Cleanup fingerprint row budget');
    const [row] = await tx.unsafe<{ rows:number; sha256:string }[]>(`SELECT count(*)::integer AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS sha256
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM public."${table}" t
      WHERE NOT t.${identity}=ANY($1::integer[])) hashes`,[ids]);
    result.push({table,...row});
  }
  return result;
}

/** Caller owns the real transaction; exported for native rollback/lock tests. */
export async function cleanupOrphanRows(tx: postgres.TransactionSql, expectedSnapshot: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedSnapshot)) throw Error('Confirmed backup digest required');
  await configureOrphanInspection(tx);
  // Lock discovered order-reference tables and the reviewed indirect-reference
  // tables before taking data snapshots. NOWAIT never queues behind site traffic.
  const discovered = await tx<{name:string}[]>`SELECT c.relname AS name FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (a.attname IN
      ('order_id','order_no','order_id_key','store_order_id','source_order_id','payment_order_id','selected_order_id',
       'remaining_order_id','root_order_id','child_order_id','fulfilled_order_id','oid','link_id','aggregate_id',
       'payload','refund_id','previous_refund_id','order_cart_info_id')
       OR c.relname IN ('user','store_product_reply_comment')) GROUP BY c.relname ORDER BY c.relname COLLATE "C" LIMIT 101`;
  const locks = [...new Set([...discovered.map(t=>t.name),...ORPHAN_CLEANUP_TABLES,'user'])].sort();
  if (locks.length > 100 || locks.some(n=>!/^[a-z][a-z0-9_]*$/.test(n))) throw Error('Cleanup lock scope');
  await tx.unsafe(`LOCK TABLE ${locks.map(n=>`ONLY public."${n}"`).join(',')} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const snapshot = await collectOrphanTestOrderSnapshot(tx);
  if (snapshotHash(snapshot) !== expectedSnapshot) throw Error('Backup snapshot changed; no deletion');
  const context = await orphanCleanupContext(tx,snapshot);
  if (context.tables.length !== 7 || context.tables.some(t=>t.relkind !== 'r' || t.relpersistence !== 'p'
    || t.relrowsecurity || t.relforcerowsecurity || t.relispartition || t.inheritance || t.rules)
    || context.triggers.length || context.transitive.some(t=>t.rows)) throw Error('Unsafe cleanup dependencies');
  if (JSON.stringify(context.foreignKeys) !== JSON.stringify([{name:'spr_order_cart_info_fk',child:'store_product_reply',
    parent:'store_order_cart_info',definition:'FOREIGN KEY (order_cart_info_id) REFERENCES store_order_cart_info(id) NOT VALID'}]))
    throw Error('Unreviewed cleanup foreign keys');
  const {plan,preserved} = orphanCleanupPlan(snapshot);
  const retainedBefore = await cleanupFingerprint(tx,plan);
  const deleted = [];
  const deadline = Date.now()+15_000;
  for (const table of ['store_product_reply','store_order_refund','store_order_status','store_order_cart_info',
    'user_bill','user_brokerage','store_order'] as const) {
    if (Date.now()>deadline) throw Error('Cleanup deadline');
    const ids=plan[table].map(r=>r.id), hashes=plan[table].map(r=>r.sha256);
    const rows = await tx.unsafe<{id:number}[]>(`DELETE FROM ONLY public."${table}" t USING unnest($1::integer[],$2::text[]) expected(id,sha)
      WHERE t.id=expected.id AND encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=expected.sha RETURNING t.id`,[ids,hashes]);
    if (JSON.stringify(rows.map(r=>r.id).sort((a,b)=>a-b)) !== JSON.stringify([...ids].sort((a,b)=>a-b))) throw Error('Cleanup exact row mismatch');
    deleted.push({table,rows:rows.length});
  }
  const retainedAfter = await cleanupFingerprint(tx);
  if (JSON.stringify(retainedBefore)!==JSON.stringify(retainedAfter)) throw Error('Cleanup changed retained rows');
  const [remaining] = await tx.unsafe<{n:number}[]>(`SELECT count(*)::integer AS n FROM public.store_order o WHERE ${ORPHAN_TEST_PREDICATE}`);
  if (remaining.n !== 0) throw Error('Cleanup postcondition');
  return {scope:'orphan-test-order-cleanup',ready:true,applied:true,snapshotSha256:expectedSnapshot,
    deleted,preservedCandidateRows:preserved,retained:retainedAfter,remainingOrphans:remaining.n};
}

async function productionIdentity(tx: postgres.TransactionSql) {
  const [r]=await tx`SELECT current_database() AS database,current_user AS role,current_setting('server_version_num')::integer/10000 AS major`;
  if (r.database !== 'postgres' || r.role !== 'postgres' || r.major !== 16) throw Error('Unexpected cleanup target');
}
export async function deleteOrphanTestOrders(db:Pick<DbClient,'$client'>,expectedSnapshot:string) {
  return db.$client.begin('isolation level read committed',async tx=>{
    await productionIdentity(tx); return cleanupOrphanRows(tx,expectedSnapshot);
  });
}
export async function inspectOrphanCleanupResult(db:Pick<DbClient,'$client'>) {
  return db.$client.begin('isolation level repeatable read read only',async tx=>{
    await productionIdentity(tx); await configureOrphanInspection(tx);
    const [remaining] = await tx.unsafe<{n:number}[]>(`SELECT count(*)::integer AS n FROM public.store_order o WHERE ${ORPHAN_TEST_PREDICATE}`);
    return {scope:'orphan-test-cleanup-result',remainingOrphans:remaining.n,retained:await cleanupFingerprint(tx)};
  });
}
