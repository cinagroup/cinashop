/** Real original application + local object bytes. The media LOGIN has only
 * seven table SELECTs; application creation uses a different existing writer. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import {systemSupplier} from '@/models/schema';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {md5} from '@/utils/jwt';
import {supplierFinanceAccountsFixture,type SupplierFinanceAccountsRuntime} from './supplierFinanceAccounts';
import {supplierExtractReadPassword} from './supplierExtractRead';
export const supplierExtractApplicationMediaActor={id:21,supplierId:7,authVersion:md5(supplierExtractReadPassword),expiresAt:2147483647};
export async function supplierExtractApplicationMediaFixture(){
 const f=await supplierFinanceAccountsFixture();
 try{
  const createApplication=async(options:{extractType?:'bank'|'alipay'|'weixin';reference?:string}={})=>{
   const extractType=options.extractType??'alipay';
   await f.db.update(systemSupplier).set({alipayQrcodeUrl:extractType==='alipay'?options.reference??'/api/assets/31':'/api/assets/31',
    wechatQrcodeUrl:extractType==='weixin'?options.reference??'/api/assets/32':'/api/assets/32'}).where(eq(systemSupplier.id,7));
   return f.withApplicant(async runtime=>{
    const service=new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY),seed=await service.seed(supplierExtractApplicationMediaActor);
    const input={operation_id:randomUUID(),revision:seed.revision,extract_type:extractType,money:'25.50',mark:'原申请收款二维码核验'};
    const receipt=await service.execute(input,supplierExtractApplicationMediaActor);
    if(receipt.state!=='committed'||!receipt.result)throw Error('Owned original application did not commit');
    return{operationId:input.operation_id,requestHash:receipt.request_hash,extractId:receipt.result.id,receipt,input};
   });
  };
  const original=await createApplication();
  const withApplicationMediaReader=<T>(work:(runtime:SupplierFinanceAccountsRuntime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.supplier_extract,public.system_attachment,public.supplier_extract_application_operation_v1 TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  return{...f,original,createApplication,withApplicationMediaReader};
 }catch(error){await f.close();throw error;}
}
