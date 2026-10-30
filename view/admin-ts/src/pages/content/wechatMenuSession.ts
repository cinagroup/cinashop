import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useAuthStore} from '@/stores/auth';
import {getAdminSession,getToken} from '@/utils/auth';
/** One private read surface; every event and response carries a monotonic lease. */
export function useWechatMenuSession(permission:()=>string,source:()=>string,discard:()=>void,resume:()=>void) {
  const auth=useAuthStore(),revision=ref(0),requests=new Map<string,AbortController>();
  const has=(key:string)=>!!auth.userInfo && (auth.userInfo.level===0 || auth.uniqueAuth.some(value=>value==='*'||value==='wechat_menu.*'||value===key||key==='wechat_menu.view'&&value==='wechat_menu.manage'));
  const identity=computed(()=>JSON.stringify([auth.token,auth.userInfo,auth.uniqueAuth,auth.menus]));
  const allowed=computed(()=>!!auth.token && auth.token===getToken() && has(permission()));
  let alive=false,syncing=false,scheduled=false,stored=localStorage.getItem('admin_session'),stopAction:(()=>void)|undefined;
  function cancel(channel:string) { requests.get(channel)?.abort();requests.delete(channel); }
  function invalidate() { revision.value++;requests.forEach(c=>c.abort());requests.clear();discard(); }
  function again() { if(scheduled)return;scheduled=true;void Promise.resolve().then(()=>{scheduled=false;if(alive)resume();}); }
  function lease() { const captured={revision:revision.value,identity:identity.value,source:source(),stored};return {key:captured.revision,current:()=>alive && allowed.value && revision.value===captured.revision && identity.value===captured.identity && source()===captured.source && auth.token===getToken() && stored===captured.stored && captured.stored===localStorage.getItem('admin_session')}; }
  function begin(channel:string) { const view=lease();if(!view.current())return null;cancel(channel);const controller=new AbortController();requests.set(channel,controller);return {signal:controller.signal,current:()=>view.current() && !controller.signal.aborted && requests.get(channel)===controller,finish:()=>{if(requests.get(channel)===controller)requests.delete(channel);}}; }
  function sync() { syncing=true;invalidate();const session=getAdminSession();auth.$patch({token:getToken()??'',userInfo:session?.userInfo??null,menus:(session?.menus as typeof auth.menus)??[],uniqueAuth:session?.uniqueAuth??[]});stored=localStorage.getItem('admin_session');syncing=false;again(); }
  function storage(event:StorageEvent) { if(event.key===null || event.key==='admin_token' || event.key==='admin_session')sync(); }
  watch(identity,()=>{if(alive&&!syncing){invalidate();again();}},{flush:'sync'});
  watch(source,()=>{if(alive){invalidate();again();}},{flush:'sync'});
  onMounted(()=>{alive=true;window.addEventListener('admin-session-changed',sync);window.addEventListener('admin-auth-expired',sync);window.addEventListener('storage',storage);stopAction=auth.$onAction(({name,after})=>{if(name==='logout')invalidate();if(name==='login')after(()=>{if(alive)sync();});});sync();});
  onBeforeUnmount(()=>{alive=false;invalidate();stopAction?.();window.removeEventListener('admin-session-changed',sync);window.removeEventListener('admin-auth-expired',sync);window.removeEventListener('storage',storage);});
  return {revision,allowed,has,lease,begin,cancel,invalidate};
}
