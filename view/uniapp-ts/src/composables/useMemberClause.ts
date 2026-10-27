import {computed,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createMemberClauseRequests,type MemberClause,type MemberClauseRequests} from '@/api/memberClause';
import {openFabLink} from '@/utils/fab';
import {memberLevelImage} from '@/api/memberLevels';
import {diyPresentationHtmlTree,type DiyPresentationHtmlNode} from '../../../common/diyPresentationHtml';
import {memberRightResolvedMedia,memberRightMediaDeadline} from '../../../common/memberRightMedia';
export function useMemberClause(){
 const auth=useAuthStore(),visible=ref(false),record=ref<MemberClause|null>(null),loading=ref(false),loaded=ref(false),error=ref(''),clock=ref(0),ownerClock=ref(0),mediaExpired=ref(false),positions=ref<Record<number,number>>({});
 let disposed=false,generation=0,scope:MemberClauseRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined,sourceNodes:DiyPresentationHtmlNode[]=[],mediaDeadline=Infinity;
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const loggedIn=computed(()=>{void ownerClock.value;return auth.isLoggedIn&&auth.uid>0&&persisted();}),current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 function clear(){generation++;scope?.abort();scope=undefined;clearTimeout(timer);timer=undefined;sourceNodes=[];positions.value={};mediaDeadline=Infinity;record.value=null;loaded.value=false;loading.value=false;error.value='';mediaExpired.value=false;clock.value++;}
 function schedule(){clearTimeout(timer);timer=undefined;clock.value++;const deadline=memberRightMediaDeadline([],record.value?[record.value.content_preview]:[]);mediaDeadline=deadline??Infinity;mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;const ticket=generation;timer=setTimeout(()=>{if(current()&&ticket===generation){clock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));}
 async function load(){if(!current()||loading.value)return;clear();const ticket=generation,r=createMemberClauseRequests(()=>current()&&ticket===generation);scope=r;loading.value=true;try{const result=await r.read();if(!r.active())return;const parsed=result?diyPresentationHtmlTree(result.content_preview):[];record.value=result;sourceNodes=parsed;loaded.value=true;schedule();}catch(reason){if(r.active()){record.value=null;loaded.value=false;error.value=reason instanceof Error?reason.message:'会员协议读取失败';}}finally{if(ticket===generation){loading.value=false;if(scope===r)scope=undefined;}r.abort();}}
 // Parse the bounded server projection before native origin expansion. Mapping
 // already-safe nodes avoids serializing a legal 4MB document above its limit.
 function project(node:DiyPresentationHtmlNode):DiyPresentationHtmlNode{if(node.type==='text')return{...node};const attrs={...node.attrs};if(node.name==='img'||node.name==='video'){const source=memberRightResolvedMedia(attrs.src??''),display=memberLevelImage(source);if(!display)return{type:'text',text:node.name==='video'?'视频暂不可用':'图片暂不可用',interactive:false};attrs.src=display;}return{...node,attrs,children:node.children.map(project)};}
 function nodes(){void clock.value;return current()&&record.value?sourceNodes.map(project):[];}
 // Every interactive renderer receives a document-scoped capability. Old native
 // callbacks cannot seek or open links after a read, owner change or expiry.
 function view(){const projected=nodes(),ticket=generation,owner=auth.uid,token=auth.token,session=auth.sessionVersion;const allowed=()=>current()&&ticket===generation&&owner===auth.uid&&token===auth.token&&session===auth.sessionVersion&&!!record.value&&!mediaExpired.value&&Date.now()<mediaDeadline;return{nodes:projected,key:ticket,allowed,positions:positions.value,position(event:{index:number;value:number}){if(allowed()&&Number.isInteger(event.index)&&event.index>=0&&event.index<10000&&Number.isFinite(event.value)&&event.value>=0&&event.value<=86400*365)positions.value[event.index]=event.value;},open(href:string){if(!allowed())return;if(/^tel:\+?[0-9][0-9 -]{2,30}$/u.test(href)){try{uni.makePhoneCall({phoneNumber:href.slice(4),fail:()=>{}});}catch{}return;}openFabLink(href);}};}
 function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
 function changed(){if(!visible.value||disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}ownerClock.value++;if(token!==auth.token||uid!==auth.uid){clear();auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}if(current()&&!loading.value)void load();}
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
 onShow(()=>{visible.value=true;clear();changed();
 // #ifdef H5
 if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
 // #endif
 });
 function leave(){visible.value=false;clear();
 // #ifdef H5
 if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
 // #endif
 }
 onHide(leave);onUnload(()=>{leave();disposed=true;});
 return{record,loggedIn,loading,loaded,error,mediaExpired,load,nodes,view,login};
}
