import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export function customerWorkOperationEndpoint(path:string,method:'GET'|'POST'|'PUT'):boolean {
  if(method==='GET')return /^\/mobile\/work\/(?:orders\/[A-Za-z0-9_-]{1,50}\/(?:fulfillment|remark)|fulfillment\/(?:carriers|couriers|defaults|templates))$/u.test(path)
    ||/^\/mobile\/work\/fulfillment\/waybills(?:\/[1-9]\d{0,9}(?:\/actions)?)?$/u.test(path)
    ||/^\/mobile\/work\/operations\/city-jobs\/[1-9]\d{0,9}$/u.test(path)
    ||new RegExp(`^/mobile/work/operations/${uuid}$`,'u').test(path);
  if(method==='PUT')return /^\/mobile\/work\/orders\/[1-9]\d{0,9}\/split-fulfillment$/u.test(path);
  return /^\/mobile\/work\/orders\/[1-9]\d{0,9}\/(?:fulfillment|remark)$/u.test(path)
    ||/^\/mobile\/work\/fulfillment\/waybills\/[1-9]\d{0,9}\/decisions$/u.test(path)
    ||/^\/mobile\/work\/operations\/city-jobs\/[1-9]\d{0,9}\/recover$/u.test(path)
    ||new RegExp(`^/mobile/work/operations/${uuid}/abandon$`,'u').test(path);
}
/** Ordinary UserJWT only; an operation never borrows a merchant/Admin token. */
export function createCustomerWorkOperationRequests(current:()=>boolean,deadlineMs=12_000){
  const auth=useAuthStore(),owner=Object.freeze({uid:auth.uid,token:auth.token,version:auth.sessionVersion});
  const cancellations=new Set<()=>void>();let disposed=false;
  const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
  function abort(){disposed=true;for(const cancel of [...cancellations])cancel();cancellations.clear();}
  function request<T=unknown>(path:string,method:'GET'|'POST'|'PUT'='GET',data:Record<string,unknown>={},requestKey?:string):Promise<T>{
    if(!active()||!owner.token||owner.uid<1)return Promise.reject(new RequestError('请登录后核对当前订单操作'));
    if(!customerWorkOperationEndpoint(path,method)||method!=='GET'&&(!requestKey||!new RegExp(`^${uuid}$`,'u').test(requestKey)))return Promise.reject(new RequestError('经营操作地址或原请求编号无效，尚未提交'));
    return new Promise((resolve,reject)=>{
      let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      function finish(value:T|undefined,error?:Error){if(done)return;done=true;if(timer)clearTimeout(timer);cancellations.delete(cancel);error?reject(error):resolve(value as T);}
      const cancel=()=>{finish(undefined,new RequestError('页面或登录状态已变化，原操作仍需查询'));task?.abort();};
      cancellations.add(cancel);timer=setTimeout(()=>{finish(undefined,new RequestError('请求超时，请查询原操作结果'));task?.abort();},deadlineMs);
      task=uni.request({url:`${API_BASE}/api${path}`,method,data,timeout:deadlineMs,header:{'Form-type':getFormType(),'Authori-zation':`Bearer ${owner.token}`,...(method==='GET'?{}:{'Content-Type':'application/json','Idempotency-Key':requestKey!})},
        success:response=>{if(done)return;if(!active()){cancel();return;}const body=response.data as {status?:unknown;msg?:unknown;data?:T}|null;
          if(!body||typeof body.status!=='number'||response.statusCode<200||response.statusCode>=300||body.status!==200){
            const failure=new RequestError(typeof body?.msg==='string'?body.msg:'经营操作响应无效，请核对原结果',typeof body?.status==='number'?body.status:undefined,undefined,response.statusCode);
            if(body&&[410000,410001,410002].includes(Number(body.status)))auth.clear();finish(undefined,failure);return;
          }finish(body.data);
        },fail:failure=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError(failure.errMsg||'原操作结果未确认，请继续查询'));}});
    });
  }
  return {owner,active,abort,request};
}
export type CustomerWorkOperationRequests=ReturnType<typeof createCustomerWorkOperationRequests>;
