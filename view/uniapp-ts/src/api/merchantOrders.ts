import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';

/** Page-local requests abort immediately on account, store or lifecycle changes. */
export function createMerchantRequests(current:()=>boolean,deadlineMs=12_000){
  const auth=useAuthStore(),owner={uid:auth.uid,token:auth.token,version:auth.sessionVersion};
  const cancellations=new Set<()=>void>();let disposed=false;
  const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
  function abort(){disposed=true;for(const cancel of [...cancellations])cancel();cancellations.clear();}
  function request<T=unknown>(path:string,method:'GET'|'POST'|'PUT'='GET',data:Record<string,unknown>={},requestKey?:string):Promise<T>{
    if(!active()||!owner.token||owner.uid<1)return Promise.reject(new RequestError('请重新登录后打开商家管理'));
    if(!/^\/store\/manager\/(?:context|order\/[A-Za-z0-9_./%-]+)$/u.test(path))return Promise.reject(Error('管理请求地址无效'));
    return new Promise((resolve,reject)=>{
      let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      function finish(value:T|undefined,error?:Error){if(done)return;done=true;if(timer)clearTimeout(timer);cancellations.delete(cancel);if(error)reject(error);else resolve(value as T);}
      const cancel=()=>{finish(undefined,new RequestError('页面、门店或登录状态已变化'));task?.abort();};
      cancellations.add(cancel);timer=setTimeout(()=>{finish(undefined,new RequestError('请求超时，请查询原操作结果后继续'));task?.abort();},deadlineMs);
      task=uni.request({url:`${API_BASE}/api${path}`,method,data,timeout:deadlineMs,header:{'Form-type':getFormType(),'Authori-zation':`Bearer ${owner.token}`,...(method!=='GET'?{'Content-Type':'application/json'}:{}),...(requestKey?{'Idempotency-Key':requestKey}:{})},
        success:response=>{if(done)return;if(!active()){cancel();return;}const body=response.data as {status?:unknown;msg?:unknown;data?:T}|null;
          if(!body||typeof body.status!=='number'||response.statusCode<200||response.statusCode>=300||body.status!==200){
            const error=new RequestError(typeof body?.msg==='string'?body.msg:'管理响应无效，请重新读取',typeof body?.status==='number'?body.status:undefined,undefined,response.statusCode);
            if(body&&[410000,410001,410002].includes(Number(body.status)))auth.clear();finish(undefined,error);return;
          }finish(body.data);
        },fail:failure=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError(failure.errMsg||'网络连接失败，请查询原操作结果'));},
      });
    });
  }
  return {owner,active,abort,request};
}
export type MerchantRequests=ReturnType<typeof createMerchantRequests>;
