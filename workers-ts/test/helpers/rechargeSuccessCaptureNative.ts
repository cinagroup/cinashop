/** Genuine producer fixture, only catalog/role/synthetic I/O setup. Calls to
 * persisted/paid/spend/capture remain explicit in5s case bodies. No provider
 * truth, hold, paid recharge, cash-flow or notice authority is owner seeded. */
import { eq,or,sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { capitalFlow,storeOrderOutbox,systemAdmin } from '@/models/schema';
import { CapitalFlowService } from '@/services/finance/CapitalFlowService';
import { captureRechargeRefundSuccessFirstResult } from '@/services/payment/RechargeRefundSuccessCapture';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { rechargeClosedReleaseNativeFixture } from './rechargeClosedReleaseNative';

export async function rechargeSuccessCaptureNativeFixture(values:Map<string,unknown>){
 const f=await rechargeClosedReleaseNativeFixture(values);
 try{
  const capture=(operationId:unknown,providerResultId:unknown,role:'app'|'admin'|'financial'='admin')=>
   captureRechargeRefundSuccessFirstResult({...f.adminContainer,db:f.profilePeers[role].db},f.env,role,operationId,providerResultId);
  const flow=(operationId:string)=>f.adminRuntime.db.select().from(capitalFlow)
   .where(or(eq(capitalFlow.eventKey,'recharge.refund:'+operationId),eq(capitalFlow.flowId,operationId.replaceAll('-','')))).limit(4);
  const notice=(operationId:string)=>f.adminRuntime.db.select().from(storeOrderOutbox)
   .where(eq(storeOrderOutbox.eventKey,'recharge.refund.success.notice:'+operationId)).limit(3);
  async function editMark(id:number,mark:string){
   const rows=await f.adminRuntime.db.select({id:systemAdmin.id,name:systemAdmin.account}).from(systemAdmin).where(eq(systemAdmin.id,f.actor().id)).limit(2);
   expect(rows).toHaveLength(1);
   // This is the existing API's ordinary actor DTO for an actual Admin fixture
   // row. It does not claim a fresh JWT/menu capability or new refund authority.
   return new CapitalFlowService(createContainerFromDb(f.adminRuntime.db)).setMark(id,mark,{id:rows[0].id,name:rows[0].name,ip:'127.0.0.1'});
  }
  const dispatchNotice=(id:number)=>new OrderOutboxService(createContainerFromDb(f.appRuntime.db),f.env).dispatchById(id);
  const ddl=(...commands:string[])=>f.withMaintenancePeer(async peer=>peer.transaction(async tx=>{
   await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
   await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5000ms'`);
   for(const command of commands)await tx.execute(sql.raw(command));
  }));
  return{...f,capture,flow,notice,editMark,dispatchNotice,ddl};
 }catch(error){await f.close();throw error;}
}
export type RechargeSuccessCaptureNativeFixture=Awaited<ReturnType<typeof rechargeSuccessCaptureNativeFixture>>;
