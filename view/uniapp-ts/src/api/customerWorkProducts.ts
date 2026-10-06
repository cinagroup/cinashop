import { useAuthStore } from '@/stores/auth';
import { API_BASE,getFormType,RequestError } from '@/utils/request';
import { customerWorkCanonicalJson } from '@/utils/customerWorkProductsContract';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
export function customerWorkProductRequestEndpoint(path:string,method:'GET'|'POST'):boolean{
 const product=path.match(/^\/mobile\/work\/products\/([1-9]\d{0,9})\/skus$/u),sku=!!product&&Number(product[1])<=2147483647;
 if(method==='GET')return path==='/mobile/work/products'||['/mobile/work/products/categories','/mobile/work/products/labels'].includes(path)||sku||new RegExp(`^/mobile/work/products/operations/${uuid}$`,'u').test(path);
 return ['/mobile/work/products/show','/mobile/work/products/batch'].includes(path)||sku||new RegExp(`^/mobile/work/products/operations/${uuid}/abandon$`,'u').test(path);
}
export function createCustomerWorkProductRequests(current:()=>boolean,deadlineMs=12_000){
 const auth=useAuthStore(),owner=Object.freeze({uid:auth.uid,token:auth.token,version:auth.sessionVersion}),cancellations=new Set<()=>void>();let disposed=false;
 const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
 function abort(){disposed=true;for(const cancel of[...cancellations])cancel();cancellations.clear();}
 function request<T=unknown>(path:string,method:'GET'|'POST'='GET',data:Record<string,unknown>={},requestKey?:string):Promise<T>{
  if(!active()||!owner.token||owner.uid<1)return Promise.reject(new RequestError('请登录后核对商品经营数据'));
  if(!customerWorkProductRequestEndpoint(path,method)||method==='POST'&&(!requestKey||!new RegExp(`^${uuid}$`,'u').test(requestKey)))return Promise.reject(new RequestError('商品请求地址或原编号无效，尚未提交'));
  // The saved intent may be read through Vue refs. Dispatch its immutable JSON,
  // never host objects or live nested proxies, on both first send and recovery.
  try{data=JSON.parse(customerWorkCanonicalJson(data));}catch{return Promise.reject(new RequestError('商品原请求不是有效JSON，尚未提交'));}
  return new Promise((resolve,reject)=>{
   let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
   function finish(value:T|undefined,failure?:Error){if(done)return;done=true;if(timer)clearTimeout(timer);cancellations.delete(cancel);failure?reject(failure):resolve(value as T);}
   const cancel=()=>{finish(undefined,new RequestError('页面或账号已变化，商品原操作仍需查询'));task?.abort();};cancellations.add(cancel);
   timer=setTimeout(()=>{finish(undefined,new RequestError('商品请求超时，请查询原操作结果'));task?.abort();},deadlineMs);
   task=uni.request({url:`${API_BASE}/api${path}`,method,data,timeout:deadlineMs,header:{'Form-type':getFormType(),'Authori-zation':`Bearer ${owner.token}`,...(method==='POST'?{'Content-Type':'application/json','Idempotency-Key':requestKey!}:{})},success:response=>{
    if(done)return;if(!active()){cancel();return;}const body=response.data as{status?:unknown;msg?:unknown;data?:T}|null;
    if(!body||typeof body.status!=='number'||response.statusCode<200||response.statusCode>=300||body.status!==200){const failure=new RequestError(typeof body?.msg==='string'?body.msg:'商品响应无效，请核对原操作',typeof body?.status==='number'?body.status:undefined,undefined,response.statusCode);if(body&&[410000,410001,410002].includes(Number(body.status)))auth.clear();finish(undefined,failure);return;}finish(body.data);
   },fail:failure=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError(failure.errMsg||'商品操作结果未确认，请继续查询'));}});
  });
 }
 return{owner,active,abort,request};
}
export type CustomerWorkProductRequests=ReturnType<typeof createCustomerWorkProductRequests>;
