import request,{getData} from '@/utils/request';
import type {PlatformMenuAction} from '../../../common/platformMenuRules';
export const apiPlatformMenuCatalog=(signal?:AbortSignal)=>getData<unknown>(request.get('/system/menu-rules/catalog',{signal}));
export async function apiPlatformMenuWrite(action:PlatformMenuAction,signal?:AbortSignal){
 try {
 const {operation,id,input}=action;
 if(operation==='create')return await getData<unknown>(request.post('/setting/menus',input,{signal}));
 if(operation==='update')return await getData<unknown>(request.put(`/setting/menus/${id}`,input,{signal}));
 if(operation==='show')return await getData<unknown>(request.put(`/setting/menus/show/${id}`,input,{signal}));
 return await getData<unknown>(request.delete(`/setting/menus/${id}`,{data:input,signal}));
 } catch(error) {
  const response=(error as {response?:{status?:unknown;data?:{data?:unknown;msg?:unknown}}})?.response;
  if(response&&[400,409].includes(Number(response.status))&&response.data?.data&&typeof response.data.data==='object') {
   const failure=new Error(typeof response.data.msg==='string'?response.data.msg:error instanceof Error?error.message:'权限规则操作未应用');
   Object.assign(failure,{status:response.status,platformMenuNotApplied:response.data.data});throw failure;
  }
  throw error;
 }
}
export const apiPlatformMenuReceipt=(action:PlatformMenuAction,signal?:AbortSignal)=>getData<unknown>(request.get(`/system/menu-rules/receipt/${action.input.request_id}`,{signal}));
