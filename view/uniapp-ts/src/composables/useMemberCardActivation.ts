import {computed,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {RequestError} from '@/utils/request';
import {createMemberCardActivationRequests,type MemberCardActivationReceipt,type MemberCardActivationRequests} from '@/api/memberCardActivation';

type ActivationPhase='idle'|'pending'|'success'|'uncertain';
export function useMemberCardActivation(){
  const auth=useAuthStore(),visible=ref(false),code=ref(''),password=ref(''),nickname=ref(''),phase=ref<ActivationPhase>('idle'),error=ref('');
  const receipt=ref<MemberCardActivationReceipt|null>(null),ownerClock=ref(0),readingName=ref(false);
  let disposed=false,generation=0,readScope:MemberCardActivationRequests|undefined,writeScope:MemberCardActivationRequests|undefined;
  const identity=()=>JSON.stringify([auth.uid,auth.token,auth.sessionVersion]);let pageOwner=identity();
  function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
  const loggedIn=computed(()=>{void ownerClock.value;return auth.uid>0&&auth.isLoggedIn&&persisted();});
  const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
  const submitting=computed(()=>phase.value==='pending'),canSubmit=computed(()=>current()&&phase.value==='idle');
  function credentials(){code.value='';password.value='';}
  function cancel(){generation++;readScope?.abort();writeScope?.abort();readScope=undefined;writeScope=undefined;readingName.value=false;}
  function resetOwner(){cancel();credentials();nickname.value='';receipt.value=null;phase.value='idle';error.value='';pageOwner=identity();}
  async function loadNickname(){
    if(!current()||readingName.value||nickname.value)return;
    const ticket=generation,request=createMemberCardActivationRequests(()=>current()&&generation===ticket);
    readScope?.abort();readScope=request;readingName.value=true;
    try{const name=await request.nickname();if(request.active())nickname.value=name;}
    catch{if(request.active())nickname.value='';}
    finally{if(ticket===generation){readingName.value=false;if(readScope===request)readScope=undefined;}request.abort();}
  }
  async function activate(){
    if(!canSubmit.value)return;
    const cardCode=code.value.trim(),cardPassword=password.value.trim();error.value='';
    if(!cardCode){error.value='请输入卡号';return;}
    if(!cardPassword){error.value='请输入卡密';return;}
    if(cardCode.length>20||cardPassword.length>12||/[\u0000-\u001f\u007f]/u.test(cardCode+cardPassword)){error.value='会员卡号或卡密格式错误';return;}
    const ticket=++generation;readScope?.abort();readScope=undefined;readingName.value=false;
    const request=createMemberCardActivationRequests(()=>current()&&generation===ticket);writeScope=request;
    phase.value='pending';password.value='';receipt.value=null;
    try{
      const result=await request.redeem(cardCode,cardPassword);if(!request.active())return;
      credentials();receipt.value=result;phase.value='success';
    }catch(reason){
      if(!request.active())return;
      const rejected=reason instanceof RequestError&&reason.httpStatus!==undefined&&reason.httpStatus>=200&&reason.httpStatus<300
        &&Number.isSafeInteger(reason.status)&&reason.status!==200;
      if(rejected){phase.value='idle';error.value=reason.message;}
      else{credentials();phase.value='uncertain';error.value='激活结果暂未确认，请先查看会员状态，再决定是否使用其他卡密。';}
    }finally{if(writeScope===request)writeScope=undefined;request.abort();}
  }
  function anotherCard(){if(current()&&phase.value==='uncertain'){credentials();receipt.value=null;error.value='';phase.value='idle';}}
  function viewRights(){if(current()&&!submitting.value)uni.navigateTo({url:'/pages/user/vipRights'});}
  function viewMembership(){if(current()&&!submitting.value)uni.navigateTo({url:'/pages/user/vipOpen'});}
  function startUse(){if(current()&&phase.value==='success')uni.reLaunch({url:'/pages/user/vipOpen'});}
  function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
  function changed(){
    if(!visible.value||disposed)return;
    let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}
    ownerClock.value++;
    if(token!==auth.token||uid!==auth.uid){resetOwner();auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}
    if(pageOwner!==identity())resetOwner();
    if(current())void loadNickname();
  }
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{resetOwner();void Promise.resolve().then(()=>{if(current())void loadNickname();});},{flush:'sync'});
  onShow(()=>{visible.value=true;changed();
    // #ifdef H5
    if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
    // #endif
  });
  function leave(){
    visible.value=false;if(phase.value==='pending')phase.value='uncertain';
    cancel();credentials();nickname.value='';receipt.value=null;
    if(phase.value!=='success'&&phase.value!=='uncertain'){phase.value='idle';error.value='';}
    if(phase.value==='uncertain')error.value='激活结果暂未确认，请先查看会员状态，再决定是否使用其他卡密。';
    // #ifdef H5
    if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
    // #endif
  }
  onHide(leave);onUnload(()=>{leave();disposed=true;phase.value='idle';error.value='';});
  return{code,password,nickname,phase,error,receipt,loggedIn,submitting,canSubmit,activate,anotherCard,viewRights,viewMembership,startUse,login};
}
