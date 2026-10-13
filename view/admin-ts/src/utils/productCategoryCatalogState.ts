import type {ProductCategoryAction,ProductCategoryItem} from '../types/productCategoryCatalog';
export interface ProductCategoryDependencies {identity():string;manage():boolean;list(pid:number,name:string,show:number|''):Promise<{list:ProductCategoryItem[];count:number}>;mutate(action:ProductCategoryAction):Promise<unknown>;proof(action:ProductCategoryAction):Promise<boolean>}
export function productCategoryCatalogState(deps:ProductCategoryDependencies,wrap:<T extends object>(value:T)=>T=value=>value){
  let generation=0,listRequest=0,revokedIdentity:string|null=null;
  const state=wrap({rows:[] as ProductCategoryItem[],pid:0,name:'',show:'' as number|'',count:0,treeRevision:0,loading:false,busy:false,revoked:false,error:'',pending:null as ProductCategoryAction|null});
  const same=(key:string,epoch:number)=>key===deps.identity()&&epoch===generation;
  function reset(){generation++;listRequest++;state.treeRevision++;state.rows=[];state.pid=0;state.name='';state.show='';state.count=0;state.loading=false;state.busy=false;state.pending=null;state.error='';state.revoked=revokedIdentity===deps.identity();if(!state.revoked)revokedIdentity=null;}
  const status=(error:unknown)=>{const e=error as {status?:unknown;response?:{data?:{status?:unknown}}};return Number(e?.status??e?.response?.data?.status);};
  function reject(error:unknown,key=deps.identity()){
    if(key!==deps.identity())return;
    if([400011,410000,410001,410002].includes(status(error))){revokedIdentity=deps.identity();reset();state.error='分类权限或登录状态已变化，请更新会话资料后继续';}
    else state.error=(error as Error).message;
  }
  function page(reply:{list:ProductCategoryItem[];count:number}){if(!Array.isArray(reply?.list)||!Number.isSafeInteger(reply.count)||reply.count<reply.list.length||reply.list.length>1000||reply.list.some(row=>row.type!==0||row.relation_id!==0||!Number.isSafeInteger(row.id)||row.id<=0))throw Error('平台分类资料不完整');return reply;}
  async function load(){if(state.revoked)return;const key=deps.identity(),epoch=generation,request=++listRequest;state.loading=true;
    try{const reply=page(await deps.list(state.pid,state.name,state.show));if(same(key,epoch)&&request===listRequest){state.rows=reply.list;state.count=reply.count;state.treeRevision++;}}
    catch(error){if(same(key,epoch)&&request===listRequest)reject(error,key);}finally{if(same(key,epoch)&&request===listRequest)state.loading=false;}}
  async function children(id:number){if(state.revoked||state.busy||state.pending)return [];const key=deps.identity(),epoch=generation;
    try{const reply=page(await deps.list(id,state.name,state.show));return same(key,epoch)&&!state.revoked?reply.list:[];}catch(error){if(same(key,epoch))reject(error,key);return [];}}
  const writable=()=>deps.manage()&&!state.revoked&&!state.busy&&!state.pending;
  const copy=(action:ProductCategoryAction):ProductCategoryAction=>action.kind==='save'?{...action,body:{...action.body,pid:[...action.body.pid]}}:{...action};
  function ack(action:ProductCategoryAction,value:unknown){if(action.kind==='delete')return value===null;const row=value as {id?:unknown;is_show?:unknown;revision?:unknown};return !!row&&typeof row.revision==='string'&&/^[a-f0-9]{64}$/.test(row.revision)&&Number.isSafeInteger(row.id)&&Number(row.id)>0&&(!action.id||row.id===action.id)&&(action.kind!=='show'||row.is_show===action.value);}
  async function run(action:ProductCategoryAction,retry=false){
    if(!deps.manage()||state.revoked||state.busy||state.pending&&!retry)return false;
    const frozen=copy(action),key=deps.identity(),epoch=generation;state.busy=true;state.error='';
    try{const reply=await deps.mutate(frozen);if(!same(key,epoch))return false;if(!deps.manage()){reject(Object.assign(Error('分类权限已变化'),{status:400011}),key);return false;}if(!ack(frozen,reply))throw Error('分类操作回执不完整');state.pending=null;await load();return same(key,epoch)&&!state.revoked&&deps.manage();}
    catch(error){if(same(key,epoch)){if([400011,410000,410001,410002].includes(status(error)))reject(error,key);else{state.error=(error as Error).message;if(retry||![400,404,409].includes(status(error)))state.pending=frozen;}}return false;}
    finally{if(same(key,epoch))state.busy=false;}
  }
  async function reconcile(){if(!state.pending||state.busy||state.revoked)return false;const action=copy(state.pending),key=deps.identity(),epoch=generation;state.busy=true;
    try{const proven=await deps.proof(action);if(!same(key,epoch))return false;if(!deps.manage()){reject(Object.assign(Error('分类权限已变化'),{status:400011}),key);return false;}if(proven){state.pending=null;state.error='当前服务器状态已核对一致';await load();return same(key,epoch)&&!state.revoked;}state.error='当前状态尚未一致，请保留原内容核对或重试';return false;}
    catch(error){if(same(key,epoch))reject(error,key);return false;}finally{if(same(key,epoch))state.busy=false;}}
  return {state,reset,reject,load,children,writable,run,reconcile,retry:()=>state.pending?run(state.pending,true):Promise.resolve(false)};
}
