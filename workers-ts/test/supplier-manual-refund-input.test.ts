import {describe,expect,it} from 'vitest';
import {parseSupplierManualRefundIntent,supplierManualRefundMac,assertSupplierManualRefundRevision} from '@/services/supplier/SupplierManualRefundInput';
const actor={id:21,supplierId:7,authVersion:'a'.repeat(32),expiresAt:2000000000};
const uuid='01234567-89ab-4cde-8fab-0123456789ab',revision='b'.repeat(64);
const body={operation_id:uuid,revision,refund_price:'1.25',cash_returned:true};
describe('Supplier genuine manual refund intent contract',()=>{
  it('binds a canonical positive cash return to the real actor and tenant',async()=>{
    const a=await parseSupplierManualRefundIntent(3,body,actor),b=await parseSupplierManualRefundIntent(3,{...body,refund_price:'1.25'},actor);
    expect(a).toEqual(b);expect(a.intent).toMatchObject({actor_id:21,supplier_id:7,refund_id:3,cash_returned:true});
    expect((await parseSupplierManualRefundIntent(3,body,{...actor,supplierId:8})).hash).not.toBe(a.hash);
  });
  it('accepts a zero settlement only when cash return confirmation is absent',async()=>{
    expect((await parseSupplierManualRefundIntent(3,{operation_id:uuid,revision,refund_price:'0'},actor)).intent.refund_price).toBe('0.00');
    for(const cash_returned of [true,false,null])await expect(parseSupplierManualRefundIntent(3,{...body,refund_price:'0',cash_returned},actor)).rejects.toThrow('省略');
  });
  it('rejects unconfirmed or caller-selected capability/provider flags before admission',async()=>{
    for(const patch of [{cash_returned:false},{cash_returned:1},{manualRefund:true},{provider_status:'SUCCESS'},{supplier_id:7},{operation_id:uuid.toUpperCase()},{refund_price:'1.234'}])
      await expect(parseSupplierManualRefundIntent(3,{...body,...patch},actor)).rejects.toThrow();
    const{cash_returned:_cash,...missing}=body;await expect(parseSupplierManualRefundIntent(3,missing,actor)).rejects.toThrow();
  });
  it('binds the revision to exact source, actor, tenant and login version',()=>{
    const a=supplierManualRefundMac('owned-fixture-key',{amount:'1.25'},actor);
    expect(()=>assertSupplierManualRefundRevision(a,a)).not.toThrow();
    for(const changed of [supplierManualRefundMac('owned-fixture-key',{amount:'1.26'},actor),supplierManualRefundMac('owned-fixture-key',{amount:'1.25'},{...actor,id:22}),supplierManualRefundMac('owned-fixture-key',{amount:'1.25'},{...actor,authVersion:'c'.repeat(32)})])
      expect(()=>assertSupplierManualRefundRevision(a,changed)).toThrow('变化');
  });
});
