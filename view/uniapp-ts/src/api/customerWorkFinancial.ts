import {useAuthStore} from '@/stores/auth';
import {API_BASE,getFormType,RequestError} from '@/utils/request';
import {customerWorkCanonicalJson,CUSTOMER_FINANCIAL_KINDS,financialId,financialUuid} from '../../../common/customerWorkFinancial';
export function customerFinancialRequestEndpoint(path:string,method:'GET'|'POST'):boolean{
 if(method==='GET'){const entity=path.match(/^\/mobile\/work\/financial\/(orders|refunds)\/([1-9]\d{0,9})$/u);return !!entity&&financialId(Number(entity[2]))||/^\/mobile\/work\/financial\/operations\/[a-f0-9-]+$/u.test(path)&&financialUuid(path.split('/').at(-1));}
 return path==='/mobile/work/financial/refund-quote'||CUSTOMER_FINANCIAL_KINDS.some(kind=>path==='/mobile/work/financial/'+kind.replaceAll('_','-'))||/^\/mobile\/work\/financial\/operations\/[a-f0-9-]+\/abandon$/u.test(path)&&financialUuid(path.split('/').at(-2));
}
export function createCustomerFinancialRequests(current:()=>boolean,deadlineMs=12_000){
 const auth=useAuthStore(),owner=Object.freeze({uid:auth.uid,token:auth.token,version:auth.sessionVersion}),cancellations=new Set<()=>void>();let disposed=false;
 const active=()=>!disposed&&current()&&auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
 function abort(){disposed=true;for(const cancel of [...cancellations])cancel();cancellations.clear();}
 function request<T=unknown>(path:string,method:'GET'|'POST'='GET',data:Record<string,unknown>={},key?:string):Promise<T>{
  if(!active()||!owner.token||!financialId(owner.uid))return Promise.reject(new RequestError('请登录后核对财务原操作'));
  const writing=method==='POST'&&path!=='/mobile/work/financial/refund-quote';
  if(!customerFinancialRequestEndpoint(path,method)||writing&&!financialUuid(key)||!writing&&key!==undefined)return Promise.reject(new RequestError('财务请求地址或原编号无效，尚未提交'));
  try{data=JSON.parse(customerWorkCanonicalJson(data));}catch{return Promise.reject(new RequestError('原财务内容不是有效 JSON，尚未提交'));}
  return new Promise((resolve,reject)=>{
   let done=false,task:UniApp.RequestTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
   function finish(value:T|undefined,failure?:Error){if(done)return;done=true;if(timer)clearTimeout(timer);cancellations.delete(cancel);failure?reject(failure):resolve(value as T);}
   const cancel=()=>{finish(undefined,new RequestError('页面或账号已变化，请查询原财务操作'));task?.abort();};cancellations.add(cancel);
   timer=setTimeout(()=>{finish(undefined,new RequestError('财务请求超时，请查询原操作结果'));task?.abort();},deadlineMs);
   task=uni.request({url:`${API_BASE}/api${path}`,method,data,timeout:deadlineMs,header:{'Form-type':getFormType(),'Authori-zation':`Bearer ${owner.token}`,...(method==='POST'?{'Content-Type':'application/json'}:{}),...(writing?{'Idempotency-Key':key!}:{})},success:response=>{
    if(done)return;if(!active()){cancel();return;}const body=response.data as{status?:unknown;msg?:unknown;data?:T}|null;
    if(!body||typeof body.status!=='number'||response.statusCode<200||response.statusCode>=300||body.status!==200){const error=new RequestError(typeof body?.msg==='string'?body.msg:'财务响应无效，请核对原操作',typeof body?.status==='number'?body.status:undefined,undefined,response.statusCode);if(body&&[410000,410001,410002].includes(Number(body.status)))auth.clear();finish(undefined,error);return;}finish(body.data);
   },fail:()=>{if(done)return;if(!active()){cancel();return;}finish(undefined,new RequestError('财务操作结果未确认，请继续查询原编号'));}});
  });
 }
 return{owner,active,abort,request};
}
export type CustomerFinancialRequests=ReturnType<typeof createCustomerFinancialRequests>;
