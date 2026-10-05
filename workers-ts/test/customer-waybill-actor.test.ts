import { describe,it,expect } from 'vitest';
import type { Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { OrderWaybillJobService } from '../src/services/waybill/OrderWaybillJobService';
import { assertCustomerWaybillActor } from '../src/services/waybill/CustomerWaybillAuthority';
import { customerWorkRuntimePrivilegePlan,customerWorkRuntimeGrantSql } from '../src/migrations/customerWorkRuntimePrivilegePlan';

describe('customer waybill independent principal boundary',()=>{
  it('rejects customer actors at every generic Admin/supplier entry before any database/provider access',async()=>{
    let accessed=0;
    const container=new Proxy({} as Container,{get(){accessed++;throw Error('Generic route touched customer database');}});
    const service=new OrderWaybillJobService(container,{} as Env),actor={actorType:'customer' as const,actorId:17,serviceId:23},input={requestKey:'11111111-1111-4111-8111-111111111111',reason:'现场核对原面单已签发'};
    await expect(service.create('1',actor,{request_key:input.requestKey})).rejects.toThrow('独立用户授权合同');
    await expect(service.listJobs(actor)).rejects.toThrow('独立用户授权合同');
    await expect(service.listActions(1,actor)).rejects.toThrow('独立用户授权合同');
    await expect(service.applyExisting(1,actor,input)).rejects.toThrow('独立用户授权合同');
    await expect(service.confirmIssued(1,actor,input)).rejects.toThrow('独立用户授权合同');
    await expect(service.confirmRetry(1,actor,input)).rejects.toThrow('独立用户授权合同');
    await expect(service.closeWithoutRetry(1,actor,input)).rejects.toThrow('独立用户授权合同');
    expect(accessed).toBe(0);
  });
  it('requires an actual positive customer service record and user identity',()=>{
    expect(()=>assertCustomerWaybillActor({actorType:'customer',actorId:17,serviceId:0})).toThrow();
    expect(()=>assertCustomerWaybillActor({actorType:'customer',actorId:0,serviceId:23})).toThrow();
    expect(()=>assertCustomerWaybillActor({actorType:'customer',actorId:17,serviceId:23})).not.toThrow();
  });
  it('fixed customer runtime grants preserve chat presence and deny authority edits',()=>{
    const plan=customerWorkRuntimePrivilegePlan();
    expect(plan.tables.store_service).toEqual(['SELECT']);expect(plan.updateColumns.store_service).toEqual(['online']);
    expect(plan.tables.delivery_service).toEqual(['SELECT']);expect(plan.tables.express_company).toEqual(['SELECT']);
    expect(plan.tables.customer_work_operation_request).toEqual(['SELECT','INSERT']);
    const statements=customerWorkRuntimeGrantSql('owned_app',[]).join('\n');
    expect(statements).toContain('GRANT UPDATE("online") ON public."store_service"');
    expect(statements).toContain('customer_work_lock_scope_v1(integer)');
    expect(()=>customerWorkRuntimeGrantSql('untrusted;DROP ROLE owned_app',[])).toThrow();
  });
});
