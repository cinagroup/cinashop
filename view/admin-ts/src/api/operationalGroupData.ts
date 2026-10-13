import request,{getData} from '@/utils/request';
import type {OperationalAction,OperationalForm,OperationalGroupName,OperationalList,OperationalOption,OperationalReceipt} from '../types/operationalGroupData';
export type * from '../types/operationalGroupData';
export const operationalOptions=()=>getData<OperationalOption[]>(request.get('/setting/operational_group_data/options'));
export const operationalList=(config_name:OperationalGroupName,page:number,status:number|'')=>getData<OperationalList>(request.get('/setting/group_data',{params:{config_name,page,limit:20,status}}));
export const operationalFullGroup=(config_name:OperationalGroupName)=>getData<OperationalList>(request.get('/setting/group_data',{params:{config_name,page:1,limit:100}}));
export const operationalForm=(config_name:OperationalGroupName,id=0)=>getData<OperationalForm>(request.get(id?`/setting/group_data/${id}/edit`:'/setting/group_data/create',{params:{config_name}}));
export function operationalWrite(action:OperationalAction){const {operation,id,input}=action;
  if(operation==='create')return getData<OperationalReceipt>(request.post('/setting/group_data',input));
  if(operation==='update')return getData<OperationalReceipt>(request.put(`/setting/group_data/${id}`,input));
  if(operation==='status')return getData<OperationalReceipt>(request.put(`/setting/group_data/set_status/${id}/${input.status}`,input));
  if(operation==='delete')return getData<OperationalReceipt>(request.delete(`/setting/group_data/${id}`,{data:input}));
  return getData<OperationalReceipt>(request.post('/setting/group_data/save_all',input));
}
export const operationalReceipt=(action:OperationalAction)=>getData<OperationalReceipt>(request.get(`/setting/operational_group_data/receipt/${action.input.config_name}/${action.input.request_id}`));
/** Existing authenticated product selector: capability remains product.view, never granted by content management. */
export async function operationalProducts(keyword:string){return getData<{list:Array<{id:number;store_name:string}>}>(request.get('/product/list',{params:{page:1,limit:20,store_name:keyword,status:1}}));}
