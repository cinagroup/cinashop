import request,{getData} from '@/utils/request';
import type {ConfigClassAction} from '../../../common/configClasses';
export const apiConfigClassCatalog=(signal?:AbortSignal)=>getData<unknown>(request.get('/config_class/catalog',{signal}));
export async function apiConfigClassWrite(action:ConfigClassAction,signal?:AbortSignal){
 try {
 const {operation,id,input}=action;
 if(operation==='create')return await getData<unknown>(request.post('/config_class',input,{signal}));
 if(operation==='update')return await getData<unknown>(request.put(`/config_class/${id}`,input,{signal}));
 if(operation==='status')return await getData<unknown>(request.put(`/config_class/set_status/${id}/${input.status}`,input,{signal}));
 return await getData<unknown>(request.delete(`/config_class/${id}`,{data:input,signal}));
 } catch(error) {
  const response=(error as {response?:{status?:unknown;data?:{data?:unknown;msg?:unknown}}})?.response;
  if(response&&[400,409].includes(Number(response.status))&&response.data?.data&&typeof response.data.data==='object') {
   const failure=new Error(typeof response.data.msg==='string'?response.data.msg:error instanceof Error?error.message:'分类操作未应用');
   Object.assign(failure,{status:response.status,configClassNotApplied:response.data.data});throw failure;
  }
  throw error;
 }
}
export const apiConfigClassReceipt=(action:ConfigClassAction,signal?:AbortSignal)=>getData<unknown>(request.get(`/config_class/receipt/${action.input.request_id}`,{signal}));
