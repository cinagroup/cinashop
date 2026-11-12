import { apiRequest } from './http';
import { previewMode } from './supplier';
import { productUserLabelCatalog } from '@/utils/productUserLabels';
export async function getSupplierProductUserLabelCatalog(page:number,keyword:string,signal?:AbortSignal) {
  if(signal?.aborted)throw new DOMException('用户标签读取已取消','AbortError');
  if(previewMode)return productUserLabelCatalog({version:1,list:[{id:1,title:'预览购买用户'}],count:1,page:1,limit:20,runtime_configured:false});
  return productUserLabelCatalog(await apiRequest<unknown>({method:'GET',url:'/product/user-label/catalog',params:{page,limit:20,keyword},signal}));
}
