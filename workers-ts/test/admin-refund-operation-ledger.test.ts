import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTx, createContainerFromDb, type Container } from '../src/lib/di';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
import { adminRefundOperation } from '../src/models/schema/admin_refund_operation';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers, waitForFinanceBlock, outcome } from './helpers/financePeers';
import { appendAdminRefundOperation, checkAdminRefundOperation, findAdminRefundOperation,
  type AdminRefundOperationIdentity } from '../src/services/admin/AdminRefundOperationLedger';
import { approveStoreOrderReturn } from '../src/services/order/StoreOrderRefundService';
import { adminRefundDecisionScope } from '../src/services/admin/AdminRefundDecisionService';
import { md5 } from '../src/utils/jwt';

describe('immutable Admin refund operation ledger', () => {
  let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  beforeEach(async () => { f = await adminRefundEvidenceFixture(); await f.exec(ADMIN_REFUND_OPERATION_SQL); });
  afterEach(async () => { await f?.close(); });
  const operation = (): AdminRefundOperationIdentity => ({ adminId: 100, requestKey: crypto.randomUUID(),
    requestHash: 'a'.repeat(64), refundId: 28, action: 'return' });
  const rows = () => f.db.select().from(adminRefundOperation);
  const approveOnce = (container: Container, op: AdminRefundOperationIdentity) => withTx(container, async tx => {
    const prior = await checkAdminRefundOperation(tx, op);
    if (prior) return prior;
    await approveStoreOrderReturn(createContainerFromDb(tx), op.refundId, adminRefundDecisionScope(
      {uid:11,storeOrderId:28,storeId:0,supplierId:0,orderId:'history_refund_28',refundPrice:'5.00'},
      {applyType:2,refundType:0,received:false},'return',
      {id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600}));
    return appendAdminRefundOperation(tx, op, 'return-approved');
  });

  it('rejects a root database before doing a non-atomic receipt write', async () => {
    await expect(appendAdminRefundOperation(f.db, operation(), 'return-approved')).rejects.toThrow('business transaction');
    expect(await rows()).toEqual([]);
  });
  it('commits actual return approval and evidence together, then replays without a second status', async () => {
    const op = operation();
    const receipt = await approveOnce(f.container, op);
    expect(receipt).toMatchObject({...op, version:'admin-refund-operation-v1', outcome:'return-approved'});
    expect(await approveOnce(f.container, op)).toEqual(receipt);
    expect(await findAdminRefundOperation(f.container,100,op.requestKey)).toEqual(receipt);
    expect((await f.applications()).find(row=>row.id===28)?.refundType).toBe(4);
    expect(await f.statuses()).toMatchObject([{oid:28,changeType:'agree_refund_return'}]);
    expect(await rows()).toHaveLength(1);
  });
  it('rolls back the real approval when the receipt cannot be appended', async () => {
    await f.exec(`CREATE FUNCTION reject_refund_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected receipt failure'; END$$;
      CREATE TRIGGER reject_receipt BEFORE INSERT ON admin_refund_operation FOR EACH ROW EXECUTE FUNCTION reject_refund_receipt()`);
    await expect(approveOnce(f.container, operation())).rejects.toThrow();
    expect((await f.applications()).find(row=>row.id===28)?.refundType).toBe(0);
    expect(await f.statuses()).toEqual([]); expect(await rows()).toEqual([]);
  });
  it('rolls back evidence and business state on failure after both writes', async () => {
    const op = operation();
    await expect(withTx(f.container, async tx => {await approveOnce(createContainerFromDb(tx),op);throw new Error('after-write failure');})).rejects.toThrow('after-write failure');
    expect((await f.applications()).find(row=>row.id===28)?.refundType).toBe(0);
    expect(await rows()).toEqual([]); expect(await f.statuses()).toEqual([]);
  });
  it.each([{requestHash:'b'.repeat(64)},{refundId:35},{action:'refuse' as const}])('rejects reuse for changed identity/content %j', async change => {
    const op = operation(); await approveOnce(f.container,op);
    await expect(withTx(f.container,tx=>checkAdminRefundOperation(tx,{...op,...change}))).rejects.toMatchObject({code:409});
    expect(await rows()).toHaveLength(1); expect(await f.statuses()).toHaveLength(1);
  });
  it('separates owners, persists an abandonment fence, and never turns missing lookup into a receipt', async () => {
    const op=operation(),before=await f.snapshot();
    expect(await findAdminRefundOperation(f.container,100,op.requestKey)).toBeNull();
    await withTx(f.container,tx=>appendAdminRefundOperation(tx,op,'abandoned'));
    expect(await findAdminRefundOperation(f.container,101,op.requestKey)).toBeNull();
    expect(await approveOnce(f.container,op)).toMatchObject({outcome:'abandoned'});
    expect((await f.applications()).find(row=>row.id===28)?.refundType).toBe(0);
    expect(await f.snapshot()).toEqual(before); expect(await f.statuses()).toEqual([]);
    await expect(withTx(f.container,tx=>appendAdminRefundOperation(tx,op,'return-approved'))).rejects.toMatchObject({code:409});
  });
  it('does not describe provider admission as a settled refund', async () => {
    const op={...operation(),action:'refund' as const};
    const receipt=await withTx(f.container,tx=>appendAdminRefundOperation(tx,op,'provider-admitted'));
    expect(receipt.outcome).toBe('provider-admitted');
    expect(receipt).not.toHaveProperty('completed');expect(receipt).not.toHaveProperty('refundPrice');
    expect((await f.applications()).find(row=>row.id===28)?.refundedPrice).toBe('0.00');
  });
  it('rejects action/outcome mismatch before persisting evidence', async () => {
    await expect(withTx(f.container,tx=>appendAdminRefundOperation(tx,operation(),'balance-settled'))).rejects.toThrow('结果与操作不一致');
    expect(await rows()).toEqual([]);
  });
  it('fails closed on a missing ledger instead of returning not found', async () => {
    await f.exec('DROP TABLE admin_refund_operation');
    await expect(findAdminRefundOperation(f.container,100,operation().requestKey)).rejects.toThrow();
  });
  it('keeps evidence after the referenced business record is removed', async () => {
    const op=operation(); await approveOnce(f.container,op);
    await f.exec('DELETE FROM store_order_refund WHERE id=28');
    expect(await findAdminRefundOperation(f.container,100,op.requestKey)).toMatchObject({outcome:'return-approved'});
  });
  it('matches independent ORM and SQL table columns/constraints', async () => {
    const other=await financePostgres([]);
    try {
      const api=await import('drizzle-kit/api');
      await other.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson({adminRefundOperation}))).join('\n'));
      const shape=async(db:typeof f.db)=>({
        columns:await db.execute(sql`SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attidentity,attgenerated
          FROM pg_attribute WHERE attrelid='admin_refund_operation'::regclass AND attnum>0 ORDER BY attnum`),
        constraints:await db.execute(sql`SELECT conname,contype,pg_get_constraintdef(oid) AS definition,convalidated,condeferrable,condeferred
          FROM pg_constraint WHERE conrelid='admin_refund_operation'::regclass ORDER BY conname`),
      });
      expect(await shape(other.db)).toEqual(await shape(f.db));
    } finally {await other.close();}
  });
  const pg=it.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL);
  const gate=()=>{let resolve!:()=>void;return{promise:new Promise<void>(r=>{resolve=r;}),resolve};};
  pg('serializes two independent senders and commits only one actual approval/status/receipt', async () => {
    const op=operation();
    await withFinancePeers(f.db,async([first,second])=>{
      const entered=gate(),release=gate();
      const initial=outcome(withTx(createContainerFromDb(first.db),async tx=>{
        await checkAdminRefundOperation(tx,op);entered.resolve();await release.promise;
        return approveOnce(createContainerFromDb(tx),op);
      }));
      let duplicate:ReturnType<typeof outcome<Awaited<ReturnType<typeof approveOnce>>>>|undefined;
      try {
        await Promise.race([entered.promise,initial.then(result=>{if(!result.ok)throw result.error;})]);
        duplicate=outcome(approveOnce(createContainerFromDb(second.db),op));
        await waitForFinanceBlock(f.db,second.pid,first.pid);release.resolve();
        expect((await initial).ok).toBe(true);expect(await duplicate).toEqual(await initial);
      } finally {release.resolve();await initial;await duplicate;}
    });
    expect(await rows()).toHaveLength(1);expect(await f.statuses()).toHaveLength(1);
  });
  pg('a committed abandonment fences an independent sender already waiting on the same key', async () => {
    const op=operation();
    await withFinancePeers(f.db,async([first,second])=>{
      const entered=gate(),release=gate();
      const fence=outcome(withTx(createContainerFromDb(first.db),async tx=>{
        await appendAdminRefundOperation(tx,op,'abandoned');entered.resolve();await release.promise;
      }));
      let pending:ReturnType<typeof outcome<Awaited<ReturnType<typeof approveOnce>>>>|undefined;
      try {
        await Promise.race([entered.promise,fence.then(result=>{if(!result.ok)throw result.error;})]);
        pending=outcome(approveOnce(createContainerFromDb(second.db),op));
        await waitForFinanceBlock(f.db,second.pid,first.pid);release.resolve();
        expect((await fence).ok).toBe(true);expect(await pending).toMatchObject({ok:true,value:{outcome:'abandoned'}});
      } finally {release.resolve();await fence;await pending;}
    });
    expect((await f.applications()).find(row=>row.id===28)?.refundType).toBe(0);
    expect(await f.statuses()).toEqual([]);expect(await rows()).toHaveLength(1);
  });
});
