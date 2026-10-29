import { ref, computed, watch, onScopeDispose } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createUserCenterRequests, type UserCenterRequests } from '@/api/userCenter';
import { parseLegacyShareCode, parseSpreadPosterData, type SpreadPosterData } from '@/utils/legacyShare';
import { API_BASE, getFormType } from '@/utils/request';
import { spreadPosterDeadline, spreadSharePath } from '@/utils/spreadPoster';
export function useSpreadPoster() {
 const auth=useAuthStore(),data=ref<SpreadPosterData|null>(null),selected=ref(0),code=ref(''),loading=ref(false),error=ref(''),visible=ref(false),ownerUid=ref(0),ownerVersion=ref(0);
 let generation=0,disposed=false,scope:UserCenterRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 function stored(){try{const token=uni.getStorageSync('uni_token')||'',uid=Number(uni.getStorageSync('uni_uid'))||0;return typeof token==='string'&&Number.isSafeInteger(uid)&&uid>=0&&!!token===(uid>0)?{token,uid}:null;}catch{return null;}}
 function persisted(){const value=stored();return !!value&&value.uid===auth.uid&&value.token===auth.token;}
 const current=()=>!disposed&&visible.value&&persisted()&&auth.isLoggedIn&&auth.uid>0;
 function clear(){generation++;scope?.abort();scope=undefined;clearTimeout(timer);timer=undefined;data.value=null;selected.value=0;code.value='';loading.value=false;error.value='';ownerUid.value=0;ownerVersion.value=0;}
 function sync(){const value=stored();if(!value){clear();return false;}if(value.uid!==auth.uid||value.token!==auth.token){clear();auth.$patch({...value,sessionVersion:auth.sessionVersion+1});}return true;}
 async function load(){
  if(!visible.value||disposed||loading.value)return;clear();if(!sync()||!current()){error.value='登录后生成自己的推广海报';return;}
  const epoch=generation,r=createUserCenterRequests(()=>current()&&epoch===generation);scope=r;loading.value=true;
  try{
   const [poster,qr]=await Promise.all([r.request<unknown>('user/spread_info','GET',{},true).then(v=>parseSpreadPosterData(v,API_BASE)),r.request<unknown>('get_qrcode/-1/'+r.owner.uid,'GET',{},true).then(v=>parseLegacyShareCode(v,API_BASE||(typeof window!=='undefined'?window.location.origin:'')))]);
   if(!r.active())return;const image=getFormType()==='routine'?qr.routineUrl:qr.wechatUrl;
   if(!image)throw Error(getFormType()==='routine'?'小程序推广码尚未配置或发布，请联系商家后重试':'推广二维码暂不可用，请重试');
   if(!poster.spread.length)throw Error('商家尚未配置推广海报模板');
   if(poster.nickname!==qr.nickname||poster.site_name!==qr.site_name)throw Error('推广身份或站点资料已变化，请重新读取');
   const deadline=spreadPosterDeadline([poster.avatar,image,...poster.spread.map(v=>v.pic)]);
   if(deadline!==null&&deadline<=Date.now())throw Error('推广图片已过期，请重新读取推广资料');
   ownerUid.value=r.owner.uid;ownerVersion.value=r.owner.version;data.value=poster;code.value=image;
   if(deadline!==null)timer=setTimeout(()=>{if(current()&&epoch===generation){clear();error.value='推广图片已过期，请重新读取推广资料';}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
  }catch(reason){if(r.active())error.value=reason instanceof Error?reason.message:'推广海报读取失败，请重试';}
  finally{if(epoch===generation)loading.value=false;r.abort();if(scope===r)scope=undefined;if(visible.value&&!persisted())sync();}
 }
 function choose(index:number){if(!current()||!data.value||!Number.isSafeInteger(index)||index<0||index>=data.value.spread.length)return;selected.value=index;}
 function changed(){if(disposed||!visible.value)return;if(sync()&&current()&&!data.value&&!loading.value&&!error.value)void load();}
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();},{flush:'sync'});
 onShow(()=>{if(disposed)return;visible.value=true;void load();
  // #ifdef H5
  if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
  // #endif
 });
 function leave(){visible.value=false;clear();
  // #ifdef H5
  if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
  // #endif
 }
 onHide(leave);onUnload(()=>{disposed=true;leave();});onScopeDispose(()=>{disposed=true;leave();});
 const sharePath=computed(()=>current()?spreadSharePath(code.value):'');
 return{auth,data,selected,code,loading,error,visible,ownerUid,ownerVersion,load,choose,current,sharePath};
}
