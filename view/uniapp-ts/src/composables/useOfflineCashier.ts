import { nextTick, shallowRef, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { offlineApi } from '@/api/offline';
import { offlineChannel, offlineKey, launchOfflineTicket } from '@/utils/offlinePayment';
import { OfflineCashier, OfflineJournal, emptyOfflineHistory, type OfflineView } from '../../../common/offlineCashier';
import { offlineBrowserExclusive } from '../../../common/offlineBrowser';

export function useOfflineCashier(resultOnly = false) {
  const auth = useAuthStore();
  const state = shallowRef<OfflineView>({money:'',quote:'',intent:null,detail:null,capabilities:null,busy:false,error:'',errorSource:'cashier',reprice:'',history:emptyOfflineHistory()});
  const cashier = new OfflineCashier({...offlineApi,key:offlineKey,channel:offlineChannel,readOnly:resultOnly,
    journal:new OfflineJournal({get:key=>uni.getStorageSync(key),set:(key,value)=>uni.setStorageSync(key,value),remove:key=>uni.removeStorageSync(key)}),
    exclusive:async work=>{
      // #ifdef H5
      if(typeof window!=='undefined')return offlineBrowserExclusive(auth.uid,work);
      // #endif
      await work();
    },
    owner:()=>{const uid=auth.uid,token=auth.token,version=auth.sessionVersion;return {uid,current:()=>!!token && uid>0 && uid===auth.uid && token===auth.token && version===auth.sessionVersion};},
    publish:value=>{state.value=value;},
  });
  let visible = false,disposed = false,routeId:unknown=undefined;
  const routePath = resultOnly ? '/pages/annex/offline_result/index' : '/pages/annex/offline_pay/index';
  function show() {
    if (!visible || disposed) return;
    // #ifdef H5
    if (typeof window !== 'undefined' && window.location.hash) {
      const hash=window.location.hash.slice(1),split=hash.indexOf('?'),path=split<0?hash:hash.slice(0,split);
      if (path!==routePath) {cashier.hide();return;}
      const ids=new URLSearchParams(split<0?'':hash.slice(split+1)).getAll('orderId');
      routeId=hash.length>8192 || ids.length>1 ? null : ids[0];
    }
    // #endif
    void cashier.show(routeId);
  }
  function login() { if (!auth.isLoggedIn && visible && !disposed) uni.navigateTo({url:'/pages/auth/login'}); }
  let showScheduled = false;
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{
    cashier.hide();
    // Pinia's action publishes epoch, token and uid sequentially. Clear now,
    // but never restore against that intermediate identity.
    if (!showScheduled) { showScheduled=true; void nextTick(()=>{showScheduled=false;show();}); }
  },{flush:'sync'});
  onLoad(options=>{cashier.hide();routeId=options?.orderId;});
  onShow(()=>{visible=true;show();});
  onHide(()=>{visible=false;cashier.hide();});
  // #ifdef H5
  if (typeof window!=='undefined') window.addEventListener('hashchange',show);
  // #endif
  onUnload(()=>{disposed=true;visible=false;cashier.hide();
    // #ifdef H5
    if(typeof window!=='undefined')window.removeEventListener('hashchange',show);
    // #endif
  });
  return {auth,state,cashier,login,launchOfflineTicket};
}
