import { ref, watch, type Ref } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createCustomerWorkRequests, type CustomerWorkRequests } from '@/api/customerWork';
import { customerWorkRoute, parseCustomerWorkQuery, parseCustomerWorkEnvelope, isCustomerWorkContext } from '@/utils/customerWork';
import type { CustomerWorkContext, CustomerWorkEnvelope, CustomerWorkPage } from '@/types/customerWork';

export interface CustomerWorkOptions {
  page: CustomerWorkPage; query?: (query: Record<string,string>) => void;
  clear?: () => void; load?: (controller: CustomerWorkController) => Promise<void>;
}
export interface CustomerWorkController {
  auth: ReturnType<typeof useAuthStore>;
  context: Ref<CustomerWorkEnvelope<CustomerWorkContext>|null>; loading: Ref<boolean>; error: Ref<string>;
  current:()=>boolean; fence:()=>()=>boolean;
  read:<T>(path:string,guard:(value:unknown)=>value is T,data?:Record<string,unknown>)=>Promise<CustomerWorkEnvelope<T>>;
  load:()=>Promise<void>; go:(page:CustomerWorkPage,query?:Record<string,string|number>)=>void;
  back:()=>void; login:()=>void; invalidate:(failure:unknown)=>void;
}
export function useCustomerWork(options: CustomerWorkOptions):CustomerWorkController {
  const auth=useAuthStore(), context=ref<CustomerWorkEnvelope<CustomerWorkContext>|null>(null);
  const loading=ref(false), error=ref('');
  let visible=false, disposed=false, epoch=0, requests:CustomerWorkRequests|null=null, routeError='', routeStamp='';
  const current=()=>visible&&!disposed;
  const fence=()=>{const scope=requests;return ()=>!!scope?.active();};
  function clear() { epoch++; requests?.abort(); requests=null; context.value=null; loading.value=false; error.value=''; options.clear?.(); }
  function fail(scope:CustomerWorkRequests, failure:unknown) {
    if (!scope.active()) return; options.clear?.(); context.value=null; loading.value=false;
    error.value=failure instanceof Error?failure.message:'经营读取失败，请重新核对'; scope.abort(); requests=null;
  }
  async function read<T>(path:string, guard:(value:unknown)=>value is T, data:Record<string,unknown>={}):Promise<CustomerWorkEnvelope<T>> {
    const scope=requests, authority=context.value;
    if (!scope?.active()||!authority) throw Error('经营身份已变化，请重新读取');
    try { const result=parseCustomerWorkEnvelope(await scope.request(`/mobile/work/${path}`,{...data,scope_key:authority.scope_key}),scope.owner.uid,guard,authority);
      if (!scope.active()) throw Error('账号或经营身份已变化'); return result;
    } catch (failure) { fail(scope,failure); throw failure; }
  }
  async function load() {
    if (!current()) return; clear();
    if (routeError) { error.value=routeError; return; }
    if (!auth.isLoggedIn) { error.value='请登录后查看手机经营工作台'; return; }
    loading.value=true; const version=epoch, scope=createCustomerWorkRequests(()=>current()&&epoch===version); requests=scope;
    try { const response=parseCustomerWorkEnvelope(await scope.request('/mobile/work/context'),scope.owner.uid,isCustomerWorkContext);
      if (!scope.active()) return;
      if (response.data.profile.uid!==scope.owner.uid) throw Error('经营账号资料不匹配，请重新读取');
      context.value=response; await options.load?.(controller);
    } catch (failure) { fail(scope,failure); }
    finally { if (scope.active()) loading.value=false; }
  }
  function applyQuery(input:string|Record<string,unknown>, stamp:string) {
    if (stamp===routeStamp) return; routeStamp=stamp;
    try { const parsed=parseCustomerWorkQuery(options.page,input); options.query?.(parsed); routeError=''; }
    catch (failure) { routeError=failure instanceof Error?failure.message:'经营入口参数无效'; }
  }
  function hashQuery():string|null {
    // #ifdef H5
    if (typeof window!=='undefined') {
      const hash=window.location.hash.replace(/^#/u,''); const at=hash.indexOf('?');
      if ((at<0?hash:hash.slice(0,at))===`/pages/customer-work/${options.page}`) {
        if (hash.length>4096) throw Error('经营入口参数过长'); return at<0?'':hash.slice(at+1);
      }
    }
    // #endif
    return null;
  }
  function revalidateHash() { try { const raw=hashQuery(); if(raw!==null)applyQuery(raw,'hash:'+raw); }
    catch(failure) { routeError=failure instanceof Error?failure.message:'经营入口参数无效'; } }
  let removeHashListener=()=>{};
  // #ifdef H5
  if (typeof window!=='undefined'&&typeof window.addEventListener==='function') {
    const pageWindow=window;
    const hashChanged=()=>{
      if (!current()) return;
      try {
        const raw=hashQuery();
        // A different page owns its own scope; onHide/onUnload clear this page.
        if (raw===null||'hash:'+raw===routeStamp) return;
        clear(); applyQuery(raw,'hash:'+raw); void load();
      } catch(failure) {
        clear(); routeError=failure instanceof Error?failure.message:'经营入口参数无效'; error.value=routeError;
      }
    };
    pageWindow.addEventListener('hashchange',hashChanged);
    removeHashListener=()=>pageWindow.removeEventListener('hashchange',hashChanged);
  }
  // #endif
  function go(page:CustomerWorkPage, query:Record<string,string|number>={}) {
    if (!current()||!context.value) return;
    try { uni.navigateTo({url:customerWorkRoute(page,query),fail:()=>{if(current())error.value='页面打开失败，请重新加载后重试';}}); }
    catch(failure) { error.value=failure instanceof Error?failure.message:'经营入口参数无效'; }
  }
  function back() { if(current())uni.navigateBack({fail:()=>uni.switchTab({url:'/pages/user/index'})}); }
  function login() { if(current())uni.navigateTo({url:'/pages/auth/login'}); }
  function invalidate(failure:unknown) { if(requests)fail(requests,failure); }
  const controller={auth,context,loading,error,current,fence,read,load,go,back,login,invalidate};
  onLoad(query=>{try { const raw=hashQuery(); applyQuery(raw??query??{},raw===null?'load:'+JSON.stringify(query??{}):'hash:'+raw); }
    catch(failure) { routeError=failure instanceof Error?failure.message:'经营入口参数无效'; } });
  onShow(()=>{visible=true;revalidateHash();void load();});
  onHide(()=>{visible=false;clear();}); onUnload(()=>{disposed=true;visible=false;removeHashListener();clear();});
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();if(current())void load();},{flush:'sync'});
  return controller;
}
