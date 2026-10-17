/** Historical legacy rows deliberately have no0197 UUID. The owned SQL and
 * image bytes are real local fixtures; object storage remains a synthetic seam. */
import {eq,sql} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import {supplierExtract,systemAttachment} from '@/models/schema';
import {supplierExtractRevision} from '@/services/supplier/SupplierExtractReadService';
import {supplierFinanceAccountsFixture,type SupplierFinanceAccountsRuntime} from './supplierFinanceAccounts';
export async function supplierExtractMediaFixture(){
 const f=await supplierFinanceAccountsFixture();
 try{
  await f.db.update(supplierExtract).set({qrcodeUrl:'/kefuapi/assets/31?expires=1&signature='+'a'.repeat(43)}).where(eq(supplierExtract.id,2));
  await f.db.update(supplierExtract).set({qrcodeUrl:'/api/assets/32',voucherImage:'/api/assets/42'}).where(eq(supplierExtract.id,3));
  await f.db.insert(systemAttachment).values({attId:51,type:3,relationId:7,moduleType:3,fileType:1,imageType:8,name:'attachments/user/7/owned-private.png',attDir:'/api/assets/51',sattDir:'/api/assets/51',attType:'image/png',attSize:String(f.png.byteLength),realName:'非财务用户图片.png'});
  f.objects.set('attachments/user/7/owned-private.png',{bytes:f.png,httpMetadata:{contentType:'image/png'}});
  const withMediaReader=<T>(work:(runtime:SupplierFinanceAccountsRuntime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.supplier_extract,public.system_attachment TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const revision=async(id:number)=>{const[row]=await f.db.execute(sql`SELECT supplier_id,xmin::text AS row_version FROM public.supplier_extract WHERE id=${id}`);if(!row)throw Error('Missing owned historical extract');return supplierExtractRevision(Number(row.supplier_id),id,String(row.row_version));};
  return{...f,withMediaReader,revision,mediaIds:{qrcode:31,weixin:32,voucher:42,foreign:41,wrongModule:43,video:44,user:51},legacyIds:{alipay:2,weixin:3,bank:1,foreign:5},historicalAdminId:102};
 }catch(error){await f.close();throw error;}
}
