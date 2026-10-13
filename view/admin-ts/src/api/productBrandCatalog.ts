import request,{getData} from '@/utils/request';
import type {ProductBrandAction,ProductBrandItem,ProductBrandNode} from '../types/productBrandCatalog';
export type {ProductBrandAction,ProductBrandItem,ProductBrandNode,ProductBrandForm} from '../types/productBrandCatalog';
export async function brandList(pid=0,brand_name=''){
  const result=await getData<{list:ProductBrandItem[];count:number}>(request.get('/product/brand',{params:{pid,brand_name}}));
  if(!Array.isArray(result?.list)||!Number.isSafeInteger(result.count)||result.count<result.list.length)throw Error('品牌列表资料不完整');
  return {...result,list:result.list.map(row=>({...row,has_children:Array.isArray(row.children)}))};
}
export const brandParents=()=>getData<ProductBrandNode[]>(request.get('/product/brand/cascader_list/1'));
export async function mutateProductBrand(action:ProductBrandAction){
  if(action.kind==='save')return getData(action.id?request.put(`/product/brand/${action.id}`,{...action.body,id:action.id}):request.post('/product/brand',action.body));
  if(action.kind==='show')return getData(request.put(`/product/brand/set_show/${action.id}/${action.value}`));
  return getData(request.delete(`/product/brand/${action.id}`));
}
export async function brandProof(action:ProductBrandAction){
  const rows=await getData<Array<{id:number;brandName:string;pid:number;fid:string;sort:number;isShow:number;storeId:number;isDel:number}>>(request.get('/brand/list'));
  if(!Array.isArray(rows)||rows.length>1000||rows.some(row=>row.storeId!==0||row.isDel!==0))throw Error('品牌核对资料不完整');
  if(action.kind==='delete')return !rows.some(row=>row.id===action.id);
  if(action.kind==='show')return rows.some(row=>row.id===action.id&&row.isShow===action.value);
  const fid=action.body.fid.filter(id=>id>0),pid=fid.at(-1)??0;
  return rows.some(row=>(!action.id||row.id===action.id)&&row.brandName===action.body.brand_name.trim()&&row.pid===pid&&row.fid===fid.join(',')&&row.sort===action.body.sort&&row.isShow===action.body.is_show);
}
