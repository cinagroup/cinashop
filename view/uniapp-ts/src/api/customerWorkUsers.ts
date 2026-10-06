import { useAuthStore } from '@/stores/auth';
import { API_BASE,getFormType,RequestError } from '@/utils/request';
import { customerWorkCanonicalJson } from '@/utils/customerWorkUsersContract';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export function customerWorkUserRequestEndpoint(path:string,method:'GET'|'POST'):boolean{
 const target=path.match(/^\/mobile\/work\/users\/([1-9]\d{0,9})(\/coupons)?$/u),user=!!target&&Number(target[1])<=2147483647;
 if(method==='GET')return path==='/mobile/work/users'||['/mobile/work/users/groups','/mobile/work/users/levels','/mobile/work/users/labels','/mobile/work/users/coupon-grants'].includes(path)||user||new RegExp(`^/mobile/work/users/operations/${uuid}$`,'u').test(path);
 return ['replace-level','replace-group','replace-labels','grant-coupons','adjust-membership','adjust-money','adjust-integral'].some(kind=>path==='/mobile/work/users/'+kind)||new RegExp(`^/mobile/work/users/operations/${uuid}/abandon$`,'u').test(path);
}
export function createCustomerWorkUserRequests(current:()=>boolean,deadlineMs=12_000){
 const auth=useAuthStore(),owner=Object.freeze({uid:auth.uid,token:auth.token,version:auth.sessionVersion}),cancellations=new Set<()=>void>();let disposed=false;
 const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
 function abort(){disposed=true;for(const cancel of[...cancellations])cancel();cancellations.clear();}
 function request<T=unknown>(path:string,method:'GET'|'POST'='GET',data:Record<string,unknown>={},requestKey?:string):Promise<T>{
  if(!active()||!owner.token||owner.uid<1)return Promise.reject(new RequestError('请登录后核对用户经营数据'));
  if(!customerWorkUserRequestEndpoint(path,method)||method==='POST'&&(!requestKey||!new RegExp(`^${uuid}$`,'u').test(requestKey)))return Promise.reject(new RequestError('用户请求地址或原编号无效，尚未提交'));
  // The saved intent may be read through Vue refs. Dispatch its immutable JSON,
  // never host objects or live nested proxies, on both first send and recovery.
  try{data=JSON.parse(customerWorkCanonicalJson(data));}catch{return Promise.reject(new RequestError('用户原请求不是有效JSON，尚未提交'));}
  return new Promise((resolve,reject)=>{
   let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
   function finish(value:T|undefined,failure?:Error){if(done)return;done=true;if(timer)clearTimeout(timer);cancellations.delete(cancel);failure?reject(failure):resolve(value as T);}
   const cancel=()=>{finish(undefined,new RequestError('页面或账号已变化，用户原操作仍需查询'));task?.abort();};cancellations.add(cancel);
   timer=setTimeout(()=>{finish(undefined,new RequestError('用户请求超时，请查询原操作结果'));task?.abort();},deadlineMs);
   task=uni.request({url:`${API_BASE}/api${path}`,method,data,timeout:deadlineMs,header:{'Form-type':getFormType(),'Authori-zation':`Bearer ${owner.token}`,...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':requestKey!}:{})},success:response=>{
    if(done)return;if(!active()){cancel();return;}const body=response.data as{status?:unknown;msg?:unknown;data?:T}|null;
    if(!body||typeof body.status!=='number'||response.statusCode<200||response.statusCode>=300||body.status!==200){const failure=new RequestError(typeof body?.msg==='string'?body.msg:'用户响应无效，请核对原操作',typeof body?.status==='number'?body.status:undefined,undefined,response.statusCode);if(body&&[410000,410001,410002].includes(Number(body.status)))auth.clear();finish(undefined,failure);return;}finish(body.data);
   },fail:failure=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError(failure.errMsg||'用户操作结果未确认，请继续查询'));}});
  });
 }
 return{owner,active,abort,request};
}
export type CustomerWorkUserRequests=ReturnType<typeof createCustomerWorkUserRequests>;
