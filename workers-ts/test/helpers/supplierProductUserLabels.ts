import { userLabel } from '@/models/schema';
import { supplierProductRecommendImageFixture } from './supplierProductRecommendImage';
import type { SupplierProductScheduleRuntime } from './supplierProductSchedule';
export async function supplierProductUserLabelsFixture() {
  const f = await supplierProductRecommendImageFixture();
  try {
    await f.db.insert(userLabel).values([{id:9201,name:'平台购买用户',type:0,relationId:0,status:1},
      {id:9202,name:'平台%_客户',type:0,relationId:0,status:1}, {id:9203,name:'停用平台',type:0,relationId:0,status:0},
      {id:9204,name:'外部门店私密名称',type:1,relationId:8,status:1}]);
    const withUserLabelWriter = <T>(work:(writer:SupplierProductScheduleRuntime)=>Promise<T>) => f.withWriter(async writer => {
      await f.exec(`GRANT UPDATE(id) ON public.user_label TO "${writer.role}"`); return work(writer);
    });
    return {...f,withUserLabelWriter};
  } catch(error) {await f.close();throw error;}
}
