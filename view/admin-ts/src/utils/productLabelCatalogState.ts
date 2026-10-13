import type {ProductLabelAction,ProductLabelCategory,ProductLabelItem} from '../types/productLabelCatalog';
export interface ProductLabelCatalogDependencies {identity():string;manage():boolean;
  categories(name:string,page:number):Promise<{list:ProductLabelCategory[];count:number}>;
  labels(category:number,page:number):Promise<{list:ProductLabelItem[];count:number}>;
  mutate(action:ProductLabelAction):Promise<unknown>;proof(action:ProductLabelAction):Promise<boolean>}
// Pending actions are wrapped by Vue reactive(). Copy their JSON DTO fields
// into plain objects; structuredClone cannot accept the resulting proxies.
function copyAction(action:ProductLabelAction):ProductLabelAction{
  if(action.kind==='label-batch')return {kind:action.kind,ids:[...action.ids]};
  if(action.kind==='label-save')return {kind:action.kind,id:action.id,body:{...action.body}};
  if(action.kind==='category-save')return {kind:action.kind,id:action.id,body:{...action.body}};
  return {...action};
}
export function productLabelCatalogState(deps:ProductLabelCatalogDependencies,wrap:<T extends object>(value:T)=>T=value=>value){
  let generation=0,labelRequest=0,categoryRequest=0,revokedIdentity:string|null=null;
  const state=wrap({categories:[] as ProductLabelCategory[],categoryCount:0,categoryPage:1,name:'',category:0,labels:[] as ProductLabelItem[],
    count:0,page:1,selected:[] as number[],loading:false,busy:false,revoked:false,error:'',pending:null as ProductLabelAction|null});
  const same=(key:string,epoch:number)=>key===deps.identity()&&epoch===generation;
  const pageValid=(reply:{list:unknown[];count:number})=>Array.isArray(reply?.list)&&Number.isSafeInteger(reply.count)&&reply.count>=0&&reply.count>=reply.list.length;
  function reset(){generation++;labelRequest++;categoryRequest++;state.categories=[];state.labels=[];state.selected=[];state.pending=null;state.busy=false;state.loading=false;state.error='';state.count=0;state.categoryCount=0;state.category=0;state.page=1;
    state.revoked=revokedIdentity===deps.identity();if(!state.revoked)revokedIdentity=null;}
  function revoke(message='权限或登录状态已变化，请更新会话资料后继续'){revokedIdentity=deps.identity();reset();state.error=message;}
  const errorStatus=(error:unknown)=>{const value=error as {status?:unknown;response?:{data?:{status?:unknown}}};return Number(value?.status??value?.response?.data?.status);};
  function reject(error:unknown,key=deps.identity()){
    if(key!==deps.identity())return;
    if([400011,410000,410001,410002].includes(errorStatus(error)))revoke();else state.error=(error as Error).message;
  }
  async function loadCategories(){
    if(state.revoked)return;
    const key=deps.identity(),epoch=generation,request=++categoryRequest;
    try{const reply=await deps.categories(state.name,state.categoryPage);if(!same(key,epoch)||request!==categoryRequest)return;
      if(!pageValid(reply)||reply.list.some(row=>row.type!==0||row.relation_id!==0||row.group!==2))throw Error('标签分组资料不完整');
      state.categories=reply.list;state.categoryCount=reply.count;
    }catch(error){if(same(key,epoch)&&request===categoryRequest)reject(error,key);}
  }
  async function loadLabels(){
    if(state.revoked)return;
    const key=deps.identity(),epoch=generation,request=++labelRequest;state.loading=true;
    try{const reply=await deps.labels(state.category,state.page);if(!same(key,epoch)||request!==labelRequest)return;
      if(!pageValid(reply)||reply.list.some(row=>row.type!==0||row.relation_id!==0||!Number.isSafeInteger(row.id)||row.id<=0))throw Error('商品标签资料不完整');
      state.labels=reply.list;state.count=reply.count;state.selected=state.selected.filter(id=>reply.list.some(row=>row.id===id));
    }catch(error){if(same(key,epoch)&&request===labelRequest)reject(error,key);}
    finally{if(same(key,epoch)&&request===labelRequest)state.loading=false;}
  }
  function selectCategory(id:number){if(state.revoked||state.busy||state.pending)return;state.category=id;state.page=1;state.selected=[];state.labels=[];labelRequest++;void loadLabels();}
  function selectPage(page:number){if(state.revoked||state.busy||state.pending)return;state.page=page;state.selected=[];state.labels=[];labelRequest++;void loadLabels();}
  const writable=()=>deps.manage()&&!state.revoked&&!state.busy&&!state.pending;
  function validAck(action:ProductLabelAction,result:unknown){
    if(action.kind==='category-delete'||action.kind==='label-delete')return result===null;
    if(!result||typeof result!=='object')return false;
    const row=result as Record<string,unknown>;
    if(action.kind==='label-batch'){
      const ids=row.ids,protectedIds=row.protected_ids;
      return Array.isArray(ids)&&Array.isArray(protectedIds)&&row.count===ids.length&&ids.every(id=>action.ids.includes(id as number))
        &&action.ids.every(id=>ids.includes(id)||protectedIds.includes(id));
    }
    return Number.isSafeInteger(row.id)&&Number(row.id)>0&&(action.id===0||row.id===action.id)
      &&(action.kind!=='label-flag'||row[action.field]===action.value);
  }
  async function run(action:ProductLabelAction,retry=false):Promise<boolean>{
    if(!deps.manage()||state.revoked||state.busy||state.pending&&!retry)return false;
    const frozen=copyAction(action),key=deps.identity(),epoch=generation;
    state.busy=true;state.error='';
    try{const result=await deps.mutate(frozen);if(!same(key,epoch))return false;
      if(!deps.manage()){revoke('商品标签权限已变化');return false;}
      if(!validAck(frozen,result))throw Error('操作回执不完整');
      state.pending=null;await Promise.all([loadCategories(),loadLabels()]);return same(key,epoch)&&!state.revoked&&deps.manage();
    }catch(error){if(same(key,epoch)){
      const status=errorStatus(error);
      if([400011,410000,410001,410002].includes(status))reject(error,key);
      else{state.error=(error as Error).message; if(retry||![400,404,409].includes(status))state.pending=frozen;}
    }return false;}finally{if(same(key,epoch))state.busy=false;}
  }
  async function reconcile(){
    if(!state.pending||state.busy||state.revoked)return false;
    const action=copyAction(state.pending),key=deps.identity(),epoch=generation;state.busy=true;
    try{const proven=await deps.proof(action);if(!same(key,epoch))return false;
      if(!deps.manage()){revoke('商品标签权限已变化');return false;}
      if(proven){state.pending=null;state.error='当前服务器状态已核对一致';await Promise.all([loadCategories(),loadLabels()]);return same(key,epoch)&&!state.revoked&&deps.manage();}
      state.error='当前状态尚未一致，请保留原内容核对或重试原操作';return false;
    }catch(error){if(same(key,epoch))reject(error,key);return false;}
    finally{if(same(key,epoch))state.busy=false;}
  }
  return {state,reset,reject,loadCategories,loadLabels,selectCategory,selectPage,writable,run,reconcile,
    retry:()=>state.pending?run(state.pending,true):Promise.resolve(false)};
}
