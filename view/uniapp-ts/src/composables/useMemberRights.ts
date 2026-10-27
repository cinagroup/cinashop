import {computed,ref,watch} from 'vue';
import {diyPresentationHtmlTree,mapDiyPresentationHtmlMedia} from '../../../common/diyPresentationHtml';
import {memberLevelImage} from '@/api/memberLevels';
import {onShow,onHide,onUnload,onLoad} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createMemberRightRequests,type MemberRightDetail,type MemberRightRequests} from '@/api/memberRights';
import {memberRightResolvedMedia,memberRightPreviewHtml,memberRightMediaDeadline} from '../../../common/memberRightMedia';

export function useMemberRights(){
  const auth=useAuthStore(),visible=ref(false),rights=ref<MemberRightDetail[]>([]),selectedId=ref(0);
  const loading=ref(false),error=ref(''),clock=ref(0),ownerClock=ref(0),mediaExpired=ref(false),failed=ref<string[]>([]);
  let disposed=false,generation=0,scope:MemberRightRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined,requestedId=0;
  const identity=()=>JSON.stringify([auth.uid,auth.token,auth.sessionVersion]);
  function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
  const loggedIn=computed(()=>{void ownerClock.value;return auth.isLoggedIn&&auth.uid>0&&persisted();});
  const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
  const selectedIndex=computed(()=>Math.max(0,rights.value.findIndex(v=>v.id===selectedId.value)));
  const selected=computed(()=>rights.value.find(v=>v.id===selectedId.value)??null);
  function clear(){generation++;scope?.abort();scope=undefined;clearTimeout(timer);timer=undefined;rights.value=[];selectedId.value=0;loading.value=false;error.value='';failed.value=[];mediaExpired.value=false;clock.value++;}
  function schedule(){
    clearTimeout(timer);timer=undefined;clock.value++;
    const deadline=memberRightMediaDeadline(rights.value.map(v=>v.pic),rights.value.map(v=>v.content_preview));
    mediaExpired.value=deadline!==null&&deadline<=Date.now();
    if(deadline===null||deadline<=Date.now())return;
    const ticket=generation;timer=setTimeout(()=>{timer=undefined;if(current()&&ticket===generation){clock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
  }
  async function load(){
    if(!current()||loading.value)return;
    const previous=selectedId.value||requestedId,ticket=++generation,request=createMemberRightRequests(()=>current()&&ticket===generation);
    scope?.abort();scope=request;loading.value=true;error.value='';
    try{
      const data=await request.info();if(!request.active())return;
      rights.value=data;failed.value=[];selectedId.value=data.some(v=>v.id===previous)?previous:data[0]?.id??0;schedule();
    }catch(reason){if(request.active()){rights.value=[];selectedId.value=0;error.value=reason instanceof Error?reason.message:'会员权益读取失败';}}
    finally{if(ticket===generation){loading.value=false;if(scope===request)scope=undefined;}request.abort();}
  }
  function select(id:number){if(current()&&rights.value.some(v=>v.id===id))selectedId.value=id;}
  function swipe(event:{detail:{current:number}}){const index=event.detail.current;if(Number.isInteger(index)&&rights.value[index])select(rights.value[index]!.id);}
  function image(row:MemberRightDetail){
    void clock.value;const src=current()?memberRightResolvedMedia(row.pic):'',ticket=generation,owner=identity();
    return{src:failed.value.includes(src)?'':memberLevelImage(src),error:()=>{if(src&&current()&&ticket===generation&&owner===identity()&&rights.value.some(v=>v.id===row.id&&v.pic===src)&&!failed.value.includes(src))failed.value.push(src);}};
  }
  function html(row:MemberRightDetail){void clock.value;return current()?memberRightPreviewHtml(row.content_preview):'';}
  // Uni rich-text's string parser keeps HTML attribute entities verbatim.
  // The shared safe tree decodes each attribute once before native rendering.
  function nodes(row:MemberRightDetail){return diyPresentationHtmlTree(mapDiyPresentationHtmlMedia(html(row),memberLevelImage));}
  const items=computed(()=>{void clock.value;return rights.value.map(row=>({...row,preview:image(row)}));});
  function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
  function changed(){
    if(!visible.value||disposed)return;
    let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}
    ownerClock.value++;
    if(token!==auth.token||uid!==auth.uid){clear();auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}
    else if(!rights.value.length&&!loading.value&&loggedIn.value)void load();
  }
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
  onLoad((query)=>{const raw=query?.id;if(typeof raw==='string'&&/^[1-9]\d{0,9}$/u.test(raw)&&Number(raw)<=2147483647)requestedId=Number(raw);});
  onShow(()=>{visible.value=true;clear();changed();if(current())void load();
    // #ifdef H5
    if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
    // #endif
  });
  function leave(){visible.value=false;clear();
    // #ifdef H5
    if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
    // #endif
  }
  onHide(leave);onUnload(()=>{leave();disposed=true;requestedId=0;});
  return{rights,items,selected,selectedId,selectedIndex,loading,error,loggedIn,mediaExpired,load,select,swipe,image,html,nodes,login};
}
