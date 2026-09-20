import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { systemAdmin, systemRole, systemMenus, storeOrderRefund } from '../src/models/schema';
import { adminRefundDecisionScope } from '../src/services/admin/AdminRefundDecisionService';
import { approveStoreOrderReturn, lockRefundExecution } from '../src/services/order/StoreOrderRefundService';
import { md5 } from '../src/utils/jwt';
import { ApiErrorCode } from '../src/utils/errors';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { withFinancePeers, outcome, waitForFinanceBlock } from './helpers/financePeers';

// Do not present PGlite's single connection as evidence of concurrent PostgreSQL locks.
describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('Admin locked decision with independent PostgreSQL backends',()=>{
  let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  beforeEach(async()=>{f=await adminRefundEvidenceFixture();});
  afterEach(async()=>{await f?.close();});
  const gate=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve};};
  const scope=(id=28)=>adminRefundDecisionScope({uid:11,storeId:0,supplierId:0,storeOrderId:id,orderId:`history_refund_${id}`,refundPrice:'5.00'},
    {applyType:2,refundType:0,received:false},'return',{id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600});
  it.each(['admin','state'])('rejects %s changed by another backend while blocked on the refund lock',async kind=>{
    await withFinancePeers(f.db,async([blocker,waiter,mutator])=>{
      const entered=gate(),release=gate();
      const held=outcome(withTx(createContainerFromDb(blocker.db),async tx=>{await lockRefundExecution(tx,28);entered.resolve();await release.promise;}));
      let decision:ReturnType<typeof outcome<{changed:boolean}>>|undefined;
      try{
        await Promise.race([entered.promise,held.then(result=>{if(!result.ok)throw result.error;})]);
        decision=outcome(approveStoreOrderReturn(createContainerFromDb(waiter.db),28,scope()));
        await waitForFinanceBlock(f.db,waiter.pid,blocker.pid);
        if(kind==='admin')await mutator.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
        else await mutator.db.update(storeOrderRefund).set({refundType:1}).where(eq(storeOrderRefund.id,28));
        release.resolve();expect((await held).ok).toBe(true);
        const result=await decision;
        expect(result.ok).toBe(false);
        if(!result.ok)expect(result.error).toMatchObject(kind==='admin'
          ? {name:'AuthException',code:ApiErrorCode.ERR_BANNED,message:'管理员已禁用或身份已变化'}
          : {name:'ValidateException',code:400,message:'退款类型或状态已变化，请刷新后重新确认'});
      }finally{release.resolve();await held;await decision;}
      expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(kind==='admin'?0:1);expect(await f.statuses()).toEqual([]);
    });
  });
  it.each(['admin','role','menu'])('fails NOWAIT without a decision write when %s authority is being edited',async kind=>{
    await f.db.insert(systemMenus).values({id:800,type:1,authType:2,access:1,uniqueAuth:'refund.manage'});
    await f.db.update(systemRole).set({rules:'800'}).where(eq(systemRole.id,1));
    await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
    await withFinancePeers(f.db,async([blocker,waiter])=>{
      const entered=gate(),release=gate();
      const held=outcome(withTx(createContainerFromDb(blocker.db),async tx=>{
        if(kind==='admin')await tx.select().from(systemAdmin).where(eq(systemAdmin.id,100)).for('update');
        if(kind==='role')await tx.select().from(systemRole).where(eq(systemRole.id,1)).for('update');
        if(kind==='menu')await tx.select().from(systemMenus).where(eq(systemMenus.id,800)).for('update');
        entered.resolve();await release.promise;
      }));
      try{
        await Promise.race([entered.promise,held.then(result=>{if(!result.ok)throw result.error;})]);
        await expect(approveStoreOrderReturn(createContainerFromDb(waiter.db),28,scope())).rejects.toThrow('权限正在变更');
      }finally{release.resolve();await held;}
      expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(0);expect(await f.statuses()).toEqual([]);
    });
  });
  it.each(['admin','role','menu'])('holds the granted %s authority until decision commit, then rejects a new decision after revocation',async kind=>{
    await f.db.insert(systemMenus).values({id:800,type:1,authType:2,access:1,uniqueAuth:'refund.manage'});
    await f.db.update(systemRole).set({rules:'800'}).where(eq(systemRole.id,1));
    await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
    await withFinancePeers(f.db,async([decisionPeer,mutator])=>{
      const authorized=gate(),release=gate();
      const reviewed=scope();
      const authorize=reviewed.authorizeLockedDecision!;
      // Test-only barrier after the real authorization acquired its locks.
      reviewed.authorizeLockedDecision=async(...args)=>{await authorize(...args);authorized.resolve();await release.promise;};
      const decision=outcome(approveStoreOrderReturn(createContainerFromDb(decisionPeer.db),28,reviewed));
      let revoke:ReturnType<typeof outcome<unknown>>|undefined;
      try{
        await Promise.race([authorized.promise,decision.then(result=>{if(!result.ok)throw result.error;})]);
        revoke=outcome(kind==='admin'
          ? mutator.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100))
          : kind==='role'
            ? mutator.db.update(systemRole).set({status:0}).where(eq(systemRole.id,1))
            : mutator.db.update(systemMenus).set({uniqueAuth:'refund.view'}).where(eq(systemMenus.id,800)));
        await waitForFinanceBlock(f.db,mutator.pid,decisionPeer.pid);
        release.resolve();expect(await decision).toEqual({ok:true,value:{changed:true}});
        expect((await revoke).ok).toBe(true);
      }finally{release.resolve();await decision;await revoke;}
      await expect(approveStoreOrderReturn(createContainerFromDb(decisionPeer.db),35,scope(35))).rejects.toMatchObject({
        name:'AuthException',code:kind==='admin'?ApiErrorCode.ERR_BANNED:ApiErrorCode.ERR_AUTH,
      });
      expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(4);
      expect((await f.applications()).find(r=>r.id===35)?.refundType).toBe(0);
      expect(await f.statuses()).toMatchObject([{oid:28,changeType:'agree_refund_return'}]);
    });
  });
});
