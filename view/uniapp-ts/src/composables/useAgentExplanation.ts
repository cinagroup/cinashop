import {computed,onScopeDispose,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createAgentExplanationRequests,type AgentExplanationDocument,type AgentExplanationRequests} from '@/api/agentExplanation';
import {openFabLink} from '@/utils/fab';
import {memberLevelImage} from '@/api/memberLevels';
import {diyPresentationHtmlTree,type DiyPresentationHtmlNode} from '../../../common/diyPresentationHtml';
import {memberRightResolvedMedia,memberRightMediaDeadline} from '../../../common/memberRightMedia';

export function useAgentExplanation() {
  const auth=useAuthStore(),record=ref<AgentExplanationDocument|null>(null),loading=ref(false),loaded=ref(false),error=ref('');
  const clock=ref(0),mediaExpired=ref(false),positions=ref<Record<number,number>>({});
  let visible=false,disposed=false,generation=0,scope:AgentExplanationRequests|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,sourceNodes:DiyPresentationHtmlNode[]=[],mediaDeadline=Infinity;

  function stored() {
    try {
      const token=uni.getStorageSync('uni_token')||'',uid=Number(uni.getStorageSync('uni_uid'))||0;
      if(typeof token!=='string'||!Number.isSafeInteger(uid)||uid<0||!!token!==(uid>0))return null;
      return{token,uid};
    }catch{return null;}
  }
  function persisted(){const value=stored();return !!value&&value.token===auth.token&&value.uid===auth.uid;}
  const current=()=>visible&&!disposed&&persisted();
  function clear() {
    generation++;scope?.abort();scope=undefined;clearTimeout(timer);timer=undefined;
    sourceNodes=[];positions.value={};mediaDeadline=Infinity;record.value=null;
    loaded.value=false;loading.value=false;error.value='';mediaExpired.value=false;clock.value++;
  }
  function schedule() {
    clearTimeout(timer);timer=undefined;clock.value++;
    const deadline=memberRightMediaDeadline([],record.value?[record.value.content_preview]:[]);
    mediaDeadline=deadline??Infinity;mediaExpired.value=deadline!==null&&deadline<=Date.now();
    if(deadline===null||deadline<=Date.now())return;
    const ticket=generation;
    timer=setTimeout(()=>{if(current()&&ticket===generation){clock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
  }
  async function load() {
    if(!current()||loading.value)return;
    clear();const ticket=generation,r=createAgentExplanationRequests(()=>current()&&ticket===generation);
    scope=r;loading.value=true;
    try {
      const result=await r.read();if(!r.active())return;
      const parsed=result?diyPresentationHtmlTree(result.content_preview):[];
      record.value=result;sourceNodes=parsed;loaded.value=true;schedule();
    }catch(reason) {
      if(r.active()){record.value=null;loaded.value=false;error.value=reason instanceof Error?reason.message:'分销说明读取失败';}
    }finally {
      if(ticket===generation){loading.value=false;if(scope===r)scope=undefined;}r.abort();
    }
  }
  function project(node:DiyPresentationHtmlNode):DiyPresentationHtmlNode {
    if(node.type==='text')return{...node};
    const attrs={...node.attrs};
    if(node.name==='img'||node.name==='video') {
      const display=memberLevelImage(memberRightResolvedMedia(attrs.src??''));
      if(!display)return{type:'text',text:node.name==='video'?'视频暂不可用':'图片暂不可用',interactive:false};
      attrs.src=display;
    }
    const children=node.children.map(project);
    return{...node,attrs,children,interactive:node.name==='img'||node.interactive||children.some(child=>child.interactive)};
  }
  function nodes(){void clock.value;return current()&&record.value?sourceNodes.map(project):[];}
  function view() {
    const projected=nodes(),ticket=generation,uid=auth.uid,token=auth.token,session=auth.sessionVersion;
    const allowed=()=>current()&&ticket===generation&&uid===auth.uid&&token===auth.token&&session===auth.sessionVersion
      &&!!record.value&&!mediaExpired.value&&Date.now()<mediaDeadline;
    return{nodes:projected,key:ticket,allowed,positions:positions.value,
      position(event:{index:number;value:number}) {
        if(allowed()&&Number.isInteger(event.index)&&event.index>=0&&event.index<10000&&Number.isFinite(event.value)&&event.value>=0&&event.value<=86400*365)positions.value[event.index]=event.value;
      },
      open(href:string) {
        if(!allowed())return;
        if(/^tel:\+?[0-9][0-9 -]{2,30}$/u.test(href)){try{uni.makePhoneCall({phoneNumber:href.slice(4),fail:()=>{}});}catch{}return;}
        openFabLink(href);
      },
      reload(){if(allowed())void load();},
    };
  }
  function sync() {
    const value=stored();if(!value){clear();return false;}
    if(value.token!==auth.token||value.uid!==auth.uid){clear();auth.$patch({...value,sessionVersion:auth.sessionVersion+1});}
    return true;
  }
  function changed(){if(!visible||disposed)return;if(sync()&&!loading.value&&!loaded.value&&!error.value)void load();}
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
  onShow(()=>{if(disposed)return;visible=true;clear();if(sync())void load();
    // #ifdef H5
    if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
    // #endif
  });
  function leave(){visible=false;clear();
    // #ifdef H5
    if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
    // #endif
  }
  onHide(leave);onUnload(()=>{leave();disposed=true;});onScopeDispose(()=>{leave();disposed=true;});
  return{record,loading,loaded,error,mediaExpired,load,nodes,view,empty:computed(()=>loaded.value&&!record.value)};
}
