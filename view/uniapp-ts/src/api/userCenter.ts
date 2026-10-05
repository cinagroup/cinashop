import { useAuthStore } from '@/stores/auth';
import { API_BASE, getFormType, RequestError } from '@/utils/request';

/** A page owns all its reads, writes and deadlines; disposal rejects immediately. */
export function createUserCenterRequests(current:()=>boolean,deadlineMs=12_000) {
  const auth=useAuthStore(),owner={uid:auth.uid,token:auth.token,version:auth.sessionVersion};
  const pending=new Set<()=>void>();let disposed=false;
  const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
  function abort(){disposed=true;for(const cancel of [...pending])cancel();pending.clear();}
  function request<T>(url:string,method:'GET'|'POST'='GET',data:Record<string,unknown>={},force=false):Promise<T>{
    if(!active())return Promise.reject(new RequestError('页面或登录状态已变化'));
    if(force&&(!owner.token||owner.uid<1))return Promise.reject(new RequestError('请先登录'));
    return new Promise((resolve,reject)=>{
      let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(value:T|undefined,error?:Error)=>{if(done)return;done=true;if(timer)clearTimeout(timer);pending.delete(cancel);if(error)reject(error);else resolve(value as T);};
      const cancel=()=>{finish(undefined,new RequestError('页面或登录状态已变化'));task?.abort();};
      pending.add(cancel);
      timer=setTimeout(()=>{finish(undefined,new RequestError('请求超时，请重试'));task?.abort();},deadlineMs);
      task=uni.request({url:`${API_BASE}/api/${url.replace(/^\/+/, '')}`,method,data,timeout:deadlineMs,
        header:{'Form-type':getFormType(),...(owner.token?{'Authori-zation':`Bearer ${owner.token}`}:{})},
        success:res=>{
          if(done)return;if(!active()){cancel();return;}
          const body=res.data as {status?:unknown;msg?:unknown;data?:T}|null;
          if(!body||typeof body!=='object'||typeof body.status!=='number'||res.statusCode<200||res.statusCode>=300||body.status!==200){
            if(body&&[410000,410001,410002].includes(Number(body.status))&&owner.token){auth.clear();}
            finish(undefined,new RequestError(typeof body?.msg==='string'?body.msg:'响应无效，请重试',typeof body?.status==='number'?body.status:undefined,undefined,res.statusCode));return;
          }
          finish(body.data);
        },fail:error=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError(error.errMsg||'网络错误，请重试'));},
      });
    });
  }
  return {request,abort,active,owner};
}
export type UserCenterRequests=ReturnType<typeof createUserCenterRequests>;
