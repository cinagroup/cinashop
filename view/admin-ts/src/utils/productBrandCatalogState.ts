import type {ProductBrandAction,ProductBrandItem,ProductBrandNode} from '../types/productBrandCatalog';
export interface ProductBrandDependencies {identity():string;manage():boolean;list(pid:number,name:string):Promise<{list:ProductBrandItem[];count:number}>;parents():Promise<ProductBrandNode[]>;mutate(action:ProductBrandAction):Promise<unknown>;proof(action:ProductBrandAction):Promise<boolean>}
export function productBrandCatalogState(deps:ProductBrandDependencies,wrap:<T extends object>(value:T)=>T=value=>value){
  let generation=0,listRequest=0,parentRequest=0,revokedIdentity:string|null=null;
  const state=wrap({rows:[] as ProductBrandItem[],parents:[] as ProductBrandNode[],pid:0,name:'',count:0,treeRevision:0,loading:false,busy:false,revoked:false,error:'',pending:null as ProductBrandAction|null});
  const same=(key:string,epoch:number)=>key===deps.identity()&&epoch===generation;
  function reset(){generation++;listRequest++;parentRequest++;state.treeRevision++;state.rows=[];state.parents=[];state.pid=0;state.name='';state.count=0;state.loading=false;state.busy=false;state.pending=null;state.error='';state.revoked=revokedIdentity===deps.identity();if(!state.revoked)revokedIdentity=null;}
  const status=(error:unknown)=>{const e=error as {status?:unknown;response?:{data?:{status?:unknown}}};return Number(e?.status??e?.response?.data?.status);};
  function reject(error:unknown,key=deps.identity()){
    if(key!==deps.identity())return;
    if([400011,410000,410001,410002].includes(status(error))){revokedIdentity=deps.identity();reset();state.error='品牌权限或登录状态已变化，请更新会话资料后继续';}
    else state.error=(error as Error).message;
  }
  function page(reply:{list:ProductBrandItem[];count:number}){if(!Array.isArray(reply?.list)||!Number.isSafeInteger(reply.count)||reply.count<reply.list.length||reply.list.length>1000||reply.list.some(row=>row.store_id!==0||row.is_del!==0||!Number.isSafeInteger(row.id)||row.id<=0))throw Error('平台品牌资料不完整');return reply;}
  async function load(){if(state.revoked)return;const key=deps.identity(),epoch=generation,request=++listRequest;state.loading=true;
    try{const reply=page(await deps.list(state.pid,state.name));if(same(key,epoch)&&request===listRequest){state.rows=reply.list;state.count=reply.count;state.treeRevision++;}}
    catch(error){if(same(key,epoch)&&request===listRequest)reject(error,key);}finally{if(same(key,epoch)&&request===listRequest)state.loading=false;}}
  async function loadParents(){if(state.revoked)return;const key=deps.identity(),epoch=generation,request=++parentRequest;
    try{const reply=await deps.parents();if(!Array.isArray(reply)||reply.length>1001)throw Error('品牌父级选项不完整');if(same(key,epoch)&&request===parentRequest)state.parents=reply;}
    catch(error){if(same(key,epoch)&&request===parentRequest)reject(error,key);}}
  async function children(id:number){if(state.revoked||state.busy||state.pending)return [];const key=deps.identity(),epoch=generation;
    try{const reply=page(await deps.list(id,state.name));return same(key,epoch)&&!state.revoked?reply.list:[];}catch(error){if(same(key,epoch))reject(error,key);return [];}}
  const writable=()=>deps.manage()&&!state.revoked&&!state.busy&&!state.pending;
  const copy=(action:ProductBrandAction):ProductBrandAction=>action.kind==='save'?{...action,body:{...action.body,fid:[...action.body.fid]}}:{...action};
  function ack(action:ProductBrandAction,value:unknown){if(action.kind==='delete')return value===null;const row=value as {id?:unknown;is_show?:unknown};return !!row&&Number.isSafeInteger(row.id)&&Number(row.id)>0&&(!action.id||row.id===action.id)&&(action.kind!=='show'||row.is_show===action.value);}
  async function run(action:ProductBrandAction,retry=false){
    if(!deps.manage()||state.revoked||state.busy||state.pending&&!retry)return false;
    const frozen=copy(action),key=deps.identity(),epoch=generation;state.busy=true;state.error='';
    try{const reply=await deps.mutate(frozen);if(!same(key,epoch))return false;if(!deps.manage()){reject(Object.assign(Error('品牌权限已变化'),{status:400011}),key);return false;}if(!ack(frozen,reply))throw Error('品牌操作回执不完整');state.pending=null;await Promise.all([load(),loadParents()]);return same(key,epoch)&&!state.revoked&&deps.manage();}
    catch(error){if(same(key,epoch)){if([400011,410000,410001,410002].includes(status(error)))reject(error,key);else{state.error=(error as Error).message;if(retry||![400,404,409].includes(status(error)))state.pending=frozen;}}return false;}
    finally{if(same(key,epoch))state.busy=false;}
  }
  async function reconcile(){if(!state.pending||state.busy||state.revoked)return false;const action=copy(state.pending),key=deps.identity(),epoch=generation;state.busy=true;
    try{const proven=await deps.proof(action);if(!same(key,epoch))return false;if(!deps.manage()){reject(Object.assign(Error('品牌权限已变化'),{status:400011}),key);return false;}if(proven){state.pending=null;state.error='当前服务器状态已核对一致';await Promise.all([load(),loadParents()]);return same(key,epoch)&&!state.revoked;}state.error='当前状态尚未一致，请保留原内容核对或重试';return false;}
    catch(error){if(same(key,epoch))reject(error,key);return false;}finally{if(same(key,epoch))state.busy=false;}}
  return {state,reset,reject,load,loadParents,children,writable,run,reconcile,retry:()=>state.pending?run(state.pending,true):Promise.resolve(false)};
}
