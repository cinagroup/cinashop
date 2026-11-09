import { describe,expect,it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createRechargeRefundRecoveryRoot,captureRechargeRefundRecoveryDispatch,captureRechargeRefundRecoveryMessage,
 isRechargeRefundRecoveryDispatch,isRechargeRefundRecoveryMessage } from '@/services/payment/RechargeRefundRecoveryQueue';
import { rechargeRefundRecoveryPageQuery,RECHARGE_REFUND_RECOVERY_PAGE_SIZE } from '@/services/payment/RechargeRefundRecoveryQueueService';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
const id='64b8ea13-902b-422d-828d-9d0bc1adea7c',root=createRechargeRefundRecoveryRoot(1794190000000);
const work={action:'recoverRechargeRefund',operationId:id};
describe('closed recharge refund Queue addresses and indexed window',()=>{
 it('creates a copied root with no caller-selected financial authority',()=>{
  expect(root).toEqual({action:'dispatchRechargeRefundRecovery',scheduledAt:1794190000000,phase:'submitting',cutoff:null,cursor:null});
  expect(Object.isFrozen(root)).toBe(true);expect(isRechargeRefundRecoveryDispatch(root)).toBe(true);
  expect(captureRechargeRefundRecoveryMessage(work)).toEqual(work);expect(isRechargeRefundRecoveryMessage(work)).toBe(true);
 });
 it.each(['role','amount','status','credentials','prepared','result','adminId','rechargeId','signature'])('refuses injected %s on both message families and blocks DLQ adoption',key=>{
  for(const input of [{...root,[key]:'untrusted'},{...work,[key]:'untrusted'}]){
   expect(isRechargeRefundRecoveryDispatch(input)).toBe(false);expect(isRechargeRefundRecoveryMessage(input)).toBe(false);
   expect(prepareOrderQueueDeadLetter(input).replayPolicy).toBe('BLOCK_UNSUPPORTED');
  }
 });
 it.each([0,-1,Infinity,NaN,1.5,2147483647001])('refuses malformed scheduled time %s',scheduledAt=>{
  expect(()=>createRechargeRefundRecoveryRoot(scheduledAt)).toThrow();
 });
 it.each([
  {...root,phase:'other'},{...root,phase:'unknown'},{...root,cutoff:0},{...root,cutoff:2147483648},
  {...root,cursor:{queryAt:10,operationId:id}},{...root,cutoff:9,cursor:{queryAt:10,operationId:id}},
  {...root,cutoff:10,cursor:{queryAt:10,operationId:id,extra:true}},
  {...root,cutoff:10,cursor:{queryAt:10,operationId:id.toUpperCase()}},
 ])('rejects malformed cursor/phase window %#',input=>{expect(()=>captureRechargeRefundRecoveryDispatch(input)).toThrow();});
 it.each([null,[],Object.create({action:'recoverRechargeRefund',operationId:id}),{...work,operationId:id.replace('-4','-1')},
  {...work,operationId:id+'\n'},{...work,operationId:1}])('rejects noncanonical operation address %#',input=>{
   expect(()=>captureRechargeRefundRecoveryMessage(input)).toThrow();
 });
 it('copies descriptors and nested cursor before awaiting and never evaluates getters',()=>{
  let reads=0;const value={...root,cutoff:100,cursor:{queryAt:90,operationId:id}};
  const copy=captureRechargeRefundRecoveryDispatch(value);value.cursor.queryAt=99;
  expect(copy.cursor?.queryAt).toBe(90);expect(Object.isFrozen(copy.cursor)).toBe(true);
  const getter={...root};Object.defineProperty(getter,'cutoff',{enumerable:true,get(){reads++;return 100;}});
  expect(()=>captureRechargeRefundRecoveryDispatch(getter)).toThrow();expect(reads).toBe(0);
 });
 it.each(['submitting','unknown'] as const)('uses one equality-bound status and composite keyset for %s',phase=>{
  const message=captureRechargeRefundRecoveryDispatch({...root,phase,cutoff:100,cursor:{queryAt:90,operationId:id}});
  const q=new PgDialect().sqlToQuery(rechargeRefundRecoveryPageQuery(message,100));
  expect(q.sql).toContain('ORDER BY next_query_at,operation_id LIMIT');expect(q.sql).not.toMatch(/OFFSET|FOR UPDATE|UPDATE public|wallet|provider/i);
  expect(q.params).toEqual([phase==='submitting'?'SUBMITTING':'UNKNOWN',100,90,id,RECHARGE_REFUND_RECOVERY_PAGE_SIZE+1]);
 });
 it('allows only copied exact public addresses for durable DLQ replay',()=>{
  for(const input of [root,work,{...root,phase:'unknown',cutoff:100,cursor:{queryAt:90,operationId:id}}]){
   const prepared=prepareOrderQueueDeadLetter(input);expect(prepared.replayPolicy).toBe('ALLOW');expect(prepared.replayMessage).toEqual(input);
   expect(prepared.replayMessage).not.toBe(input);
  }
 });
});
