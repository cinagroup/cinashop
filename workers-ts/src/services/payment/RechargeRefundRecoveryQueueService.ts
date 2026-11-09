/** Durable recharge refund recovery through actual App LOGIN. Discovery is
 * bounded RR/RO using the existing (status,next_query_at,operation_id) index.
 * Every worker address is revalidated by the owning recovery service. */
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container,DbClient } from '@/lib/di';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { ServiceUnavailableException } from '@/utils/errors';
import { recoverAppRechargeRefund } from './RechargeRefundRecoveryService';
import { captureRechargeRefundRecoveryDispatch,captureRechargeRefundRecoveryMessage,
 type RechargeRefundRecoveryDispatchMessage,type RechargeRefundRecoveryMessage } from './RechargeRefundRecoveryQueue';

export const RECHARGE_REFUND_RECOVERY_PAGE_SIZE=20;
const fail=():never=>{throw new ServiceUnavailableException('充值退款后台恢复暂不可核对');};
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
async function bounded(tx:DbClient){
 await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
 await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
  pg_catalog.set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text||'ms',true),
  pg_catalog.set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}
/** Export the SAME indexed query for physical EXPLAIN acceptance. A caller's
 * cursor is an address, never evidence that a row is due or safe to refund. */
export function rechargeRefundRecoveryPageQuery(message:Readonly<RechargeRefundRecoveryDispatchMessage>,cutoff:number){
 const status=message.phase==='submitting'?'SUBMITTING':'UNKNOWN',c=message.cursor;
 return sql`SELECT operation_id,next_query_at FROM public.recharge_refund_state
  WHERE status=${status} AND next_query_at>=1 AND next_query_at<=${cutoff}
   ${c?sql`AND (next_query_at,operation_id)>(${c.queryAt}::bigint,${c.operationId}::uuid)`:sql``}
  ORDER BY next_query_at,operation_id LIMIT ${RECHARGE_REFUND_RECOVERY_PAGE_SIZE+1}`;
}
export class RechargeRefundRecoveryQueueService {
 constructor(private readonly container:Container,private readonly env:Env){}
 async snapshot(input:RechargeRefundRecoveryDispatchMessage){
  const message=captureRechargeRefundRecoveryDispatch(input),root=this.container.db;
  if(!Object.hasOwn(root,'$client'))return fail();
  return root.transaction(async raw=>{
   const tx=raw as unknown as DbClient;await bounded(tx);await assertRechargeRoutineRefundAccountRuntimeTx(tx,'app','read');
   const [clock]=await tx.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint AS now`);
   const now=Number(clock?.now);if(!integer(now)||message.cutoff!==null&&message.cutoff>now)return fail();
   const cutoff=message.cutoff??now,rows=await tx.execute(rechargeRefundRecoveryPageQuery(message,cutoff));
   const addresses:RechargeRefundRecoveryMessage[]=[];
   for(const row of rows.slice(0,RECHARGE_REFUND_RECOVERY_PAGE_SIZE)){
    const queryAt=Number(row.next_query_at);if(!integer(queryAt)||queryAt>cutoff)return fail();
    addresses.push(captureRechargeRefundRecoveryMessage({action:'recoverRechargeRefund',operationId:row.operation_id}));
   }
   let continuation:RechargeRefundRecoveryDispatchMessage|null=null;
   if(rows.length>RECHARGE_REFUND_RECOVERY_PAGE_SIZE){
    const tail=rows[RECHARGE_REFUND_RECOVERY_PAGE_SIZE-1];
    continuation=captureRechargeRefundRecoveryDispatch({...message,cutoff,cursor:{queryAt:Number(tail.next_query_at),operationId:tail.operation_id}});
   }else if(message.phase==='submitting')continuation=captureRechargeRefundRecoveryDispatch({...message,phase:'unknown',cutoff,cursor:null});
   const [deadline]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds' AS ready`);
   if(deadline?.ready!==true)return fail();
   return{addresses,continuation,examined:rows.length,cutoff};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
 }
 async dispatch(input:RechargeRefundRecoveryDispatchMessage){
  const page=await this.snapshot(input),messages:Array<RechargeRefundRecoveryMessage|RechargeRefundRecoveryDispatchMessage>=[...page.addresses];
  if(page.continuation)messages.push(page.continuation);
  // The snapshot COMMIT precedes Queue I/O. A failed/unknown enqueue ACK
  // retries the same page; duplicate addresses cannot mint another first POST.
  if(messages.length)await this.env.ORDER_QUEUE.sendBatch(messages.map(body=>({body,contentType:'json'})));
  return{enqueued:page.addresses.length,examined:page.examined,hasMore:page.continuation!==null};
 }
 process(input:RechargeRefundRecoveryMessage){
  const message=captureRechargeRefundRecoveryMessage(input);
  return recoverAppRechargeRefund(this.container,this.env,message.operationId);
 }
}
