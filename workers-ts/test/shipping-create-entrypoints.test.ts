import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '../src/lib/di';
import { saveAdminShippingTemplate } from '../src/services/admin/AdminShippingTemplateService';
import { saveGroupedAdminShippingTemplate } from '../src/services/admin/AdminShippingTemplateGroupedService';
import { SupplierShippingTemplateService } from '../src/services/supplier/SupplierShippingTemplateService';
import { createAdminShippingFixture } from './helpers/adminShippingFixture';

const grouped = () => ({ id:0,name:'mandatory creation context',type:1,status:1,sort:0,appoint:0,no_delivery:0,
  region_info:[{city_ids:[[0]],first:'1',first_price:'6',continue:'1',continue_price:'2'}],appoint_info:[],no_delivery_info:[] });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('all public shipping service creation entrypoints on PG16', () => {
  let f: Awaited<ReturnType<typeof createAdminShippingFixture>>;
  beforeEach(async()=>{f=await createAdminShippingFixture();},30000);
  afterEach(async()=>{await f?.close();});
  it.each(['admin-flat','admin-grouped-dispatch','admin-grouped-direct','supplier-save','supplier-create'] as const)('%s has no keyless insertion fallback', async kind => {
    const container=createContainerFromDb(f.db), before=await f.snapshot();
    const supplier=new SupplierShippingTemplateService(container);
    const call=()=>kind==='admin-flat' ? saveAdminShippingTemplate(container,{name:'key in body cannot authorize',requestKey:crypto.randomUUID(),actorId:7})
      : kind==='admin-grouped-dispatch' ? saveAdminShippingTemplate(container,grouped())
      : kind==='admin-grouped-direct' ? saveGroupedAdminShippingTemplate(container,grouped())
      : kind==='supplier-save' ? supplier.save(20,0,{...grouped(),requestKey:crypto.randomUUID(),actorId:27})
      : supplier.create(20,grouped());
    await expect(call()).rejects.toThrow('Idempotency-Key');
    expect(await f.snapshot()).toEqual(before);
  });
  it.each([0,-1,2147483648,NaN])('rejects invalid actor %s even with a valid separate key',async actorId=>{
    const before=await f.snapshot();
    await expect(saveAdminShippingTemplate(createContainerFromDb(f.db),{name:'must not create'},{actorId,requestKey:crypto.randomUUID()})).rejects.toThrow('身份');
    expect(await f.snapshot()).toEqual(before);
  });
  it('keeps normalized Admin grouped status and receipt identity stable across both service entrypoints',async()=>{
    const container=createContainerFromDb(f.db),context={actorId:7,requestKey:crypto.randomUUID()};
    const first=await saveAdminShippingTemplate(container,{...grouped(),status:'0'},context);
    const before=await f.snapshot();
    expect(first.receipt).toMatchObject({version:'shipping-create-v1',requestKey:context.requestKey,replayed:false});
    const again=await saveGroupedAdminShippingTemplate(container,{...grouped(),status:0},context);
    expect(again).toEqual({...first,created:false,receipt:{...first.receipt,replayed:true}});
    expect(await f.snapshot()).toEqual(before);
  });
  it('shares the Supplier save/create receipt and rejects cross-format reuse through Admin dispatch',async()=>{
    const container=createContainerFromDb(f.db),supplier=new SupplierShippingTemplateService(container),context={actorId:27,requestKey:crypto.randomUUID()};
    const id=await supplier.save(20,0,grouped(),context);
    expect(await supplier.create(20,grouped(),context)).toMatchObject({id,replayed:true,requestKey:context.requestKey});
    const adminContext={actorId:7,requestKey:context.requestKey};
    await saveAdminShippingTemplate(container,{name:'flat'},adminContext);
    const before=await f.snapshot();
    await expect(saveAdminShippingTemplate(container,grouped(),adminContext)).rejects.toMatchObject({code:409,httpStatus:409});
    expect(await f.snapshot()).toEqual(before);
  });
});
