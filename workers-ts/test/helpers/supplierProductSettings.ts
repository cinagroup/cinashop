import { systemAttachment } from '@/models/schema';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';
import { supplierProductRecommendImageFixture } from './supplierProductRecommendImage';
export async function supplierProductSettingsFixture(){
  const f=await supplierProductRecommendImageFixture();
  try{
    await f.db.insert(systemAttachment).values([
      {attId:51,type:4,moduleType:1,relationId:7,fileType:2,imageType:8,name:'attachments/supplier/7/settings.mp4',attDir:'/api/assets/51',attType:'video/mp4'},
      {attId:52,type:4,moduleType:1,relationId:8,fileType:2,imageType:8,name:'attachments/supplier/8/settings.mp4',attDir:'/api/assets/52',attType:'video/mp4'},
      {attId:53,type:1,moduleType:1,relationId:0,fileType:2,imageType:8,name:'attachments/admin/1/settings.mp4',attDir:'/api/assets/53',attType:'video/mp4'},
    ]);
    const withSettingsWriter=<T>(work:(writer:SupplierProductScheduleRuntime)=>Promise<T>)=>f.withWriter(async writer=>{
      // PG16's existing video table barrier needs a table privilege. DELETE is
      // already in the actual App plan; column UPDATE(id) alone cannot LOCK.
      // No attachment metadata UPDATE or production privilege change is added.
      await f.exec(`GRANT DELETE ON public.system_attachment TO "${writer.role}"`);return work(writer);
    });
    return {...f,withSettingsWriter};
  }catch(error){await f.close();throw error;}
}
