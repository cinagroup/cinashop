import { computed, getCurrentInstance, ref, watch } from 'vue';
import { createProfileAvatarPreparation, PROFILE_AVATAR_CANVAS_ID } from '@/utils/profileAvatarImage';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { RequestError } from '@/utils/request';
import { createCustomerProfileRequests, profileDraft, encodeProfileSave, profileAvatarPreview, profileAvatarExpiry,
  type CustomerProfile, type ProfileDraft, type CustomerProfileRequests } from '@/api/customerProfile';

const emptyDraft=():ProfileDraft=>({nickname:'',avatar:'',fields:{}});
type Backup={revision:string;draft:ProfileDraft};
const cloneDraft=(value:ProfileDraft):ProfileDraft=>({nickname:value.nickname,avatar:value.avatar,fields:{...value.fields}});
const message=(value:unknown)=>value instanceof Error?value.message:'请求失败';
export function useCustomerProfile() {
  const auth=useAuthStore(),visible=ref(false),snapshot=ref<CustomerProfile|null>(null),draft=ref<ProfileDraft>(emptyDraft());
  const loading=ref(false),busy=ref(''),error=ref(''),notice=ref(''),needsReview=ref(false),uploadReview=ref(false);
  const backup=ref<Backup|null>(null),preview=ref(''),failedImage=ref(''),clock=ref(0),ownerClock=ref(0);
  let generation=0,disposed=false,adopted='',readScope:CustomerProfileRequests|undefined,actionScope:CustomerProfileRequests|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,uncertainOwner='';
  const instance=getCurrentInstance()?.proxy,avatarCanvas=ref({width:1,height:1}),nativeAvatarAvailable=ref(false),nativeAvatarEpoch=ref(0);
  let preparation:ReturnType<typeof createProfileAvatarPreparation>|undefined;
  const identity=()=>`${auth.uid}:${auth.sessionVersion}:${auth.token}`;
  function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
  const loggedIn=computed(()=>{void ownerClock.value;return auth.isLoggedIn&&auth.uid>0&&persisted();});
  const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
  const owns=()=>current()&&!!snapshot.value&&adopted===identity()&&snapshot.value.actor_uid===auth.uid;
  const locked=computed(()=>loading.value||!!busy.value),editable=computed(()=>owns()&&!locked.value&&!needsReview.value&&!uploadReview.value);
  let passwordAvailable=false;
  // #ifdef APP-PLUS
  passwordAvailable=true;
  // #endif
  // #ifdef H5
  if(typeof window!=='undefined')passwordAvailable=!/MicroMessenger/iu.test(window.navigator?.userAgent??'');
  // #endif
  const fields=computed(()=>snapshot.value?.profile.register_extend_info??[]);
  const dirty=computed(()=>!!snapshot.value&&JSON.stringify(draft.value)!==JSON.stringify(profileDraft(snapshot.value)));
  const avatar=computed(()=>{void clock.value;const src=profileAvatarPreview(draft.value.avatar,preview.value);return src===failedImage.value?'':src;});
  const avatarView=computed(()=>{void clock.value;const src=avatar.value,ticket=generation,stamp=identity();return{src,error:()=>{if(src&&owns()&&ticket===generation&&stamp===identity()&&avatar.value===src)failedImage.value=src;}};});
  const canRestore=computed(()=>editable.value&&backup.value?.revision===snapshot.value?.revision);
  function clear(){
    if(busy.value==='save'&&actionScope){const owner=actionScope.owner;uncertainOwner=`${owner.uid}:${owner.version}:${owner.token}`;}
    generation++;nativeAvatarEpoch.value++;preparation?.abort();preparation=undefined;avatarCanvas.value={width:1,height:1};readScope?.abort();actionScope?.abort();readScope=actionScope=undefined;clearTimeout(timer);timer=undefined;
    snapshot.value=null;draft.value=emptyDraft();backup.value=null;preview.value='';failedImage.value='';adopted='';loading.value=false;busy.value='';error.value=notice.value='';needsReview.value=uploadReview.value=false;clock.value++;
  }
  function scheduleMedia(renew=true){
    clearTimeout(timer);timer=undefined;if(!owns())return;clock.value++;
    const expiry=profileAvatarExpiry(draft.value.avatar,preview.value);if(expiry===null||expiry<=Date.now())return;
    const now=Date.now(),mayRenew=renew&&draft.value.avatar===snapshot.value!.profile.avatar&&expiry-now>60_000;
    const ticket=generation;timer=setTimeout(()=>{timer=undefined;clock.value++;if(!owns()||ticket!==generation)return;
      if(mayRenew&&!locked.value&&!needsReview.value&&!uploadReview.value)void load(true);else scheduleMedia(false);
    },Math.max(1,Math.min((mayRenew?expiry-60_000:expiry+20)-now,2147483647)));
  }
  async function load(mediaOnly=false,explicit=true,confirmedSave=false){
    if(!current()||busy.value||loading.value)return;
    const before=snapshot.value,retained=!mediaOnly&&!confirmedSave&&before&&(dirty.value||needsReview.value)
      ?{revision:before.revision,draft:cloneDraft(draft.value)}:null;
    nativeAvatarEpoch.value++;
    const ticket=++generation,scope=createCustomerProfileRequests(()=>current()&&ticket===generation);readScope?.abort();readScope=scope;
    loading.value=true;error.value='';clearTimeout(timer);timer=undefined;
    try{
      const value=await scope.info();if(!scope.active())return;
      if(mediaOnly&&before&&value.version!==before.version){needsReview.value=true;error.value='已保存资料发生变化，请重新读取并核对草稿';scheduleMedia(false);return;}
      if(mediaOnly&&before&&value.revision!==before.revision){needsReview.value=true;error.value='资料填写要求已变化，请重新读取并核对草稿';scheduleMedia(false);return;}
      snapshot.value=value;adopted=identity();failedImage.value='';
      if(mediaOnly&&before){if(draft.value.avatar===value.profile.avatar)preview.value=value.profile.avatar_preview;}
      else{draft.value=profileDraft(value);preview.value=value.profile.avatar_preview;uploadReview.value=false;
        if(retained){backup.value=retained;notice.value='已显示当前保存的资料，原草稿已保留；核对后可恢复草稿。';}
        else if(confirmedSave){backup.value=null;notice.value='资料已保存并重新读取';}
        if(explicit||confirmedSave){needsReview.value=false;uncertainOwner='';}
        else if(uncertainOwner===identity()){needsReview.value=true;notice.value='上次保存结果未确认，请核对当前资料后重新读取。';}
      }
      scheduleMedia();
    }catch(reason){if(scope.active()){error.value=message(reason);scheduleMedia(false);}}
    finally{if(ticket===generation){loading.value=false;if(readScope===scope)readScope=undefined;}scope.abort();}
  }
  function restore(){if(!canRestore.value||!backup.value)return;draft.value=cloneDraft(backup.value.draft);preview.value=draft.value.avatar===snapshot.value!.profile.avatar?snapshot.value!.profile.avatar_preview:'';failedImage.value='';backup.value=null;notice.value='草稿已恢复，请核对后保存';scheduleMedia();}
  function discardBackup(){if(owns()&&!locked.value)backup.value=null;}
  function setNickname(event:unknown){if(!editable.value)return;const value=(event as {detail?:{value?:unknown}})?.detail?.value;if(typeof value==='string')draft.value.nickname=value;}
  function setField(info:string,event:unknown){if(!editable.value||!fields.value.some(f=>f.info===info))return;const value=(event as {detail?:{value?:unknown}})?.detail?.value;if(typeof value==='string'||typeof value==='number'&&Number.isFinite(value))draft.value.fields[info]=String(value);}
  function keepAvatar(){if(!owns()||locked.value)return;draft.value.avatar=snapshot.value!.profile.avatar;preview.value=snapshot.value!.profile.avatar_preview;failedImage.value='';uploadReview.value=false;notice.value='已保留当前保存的头像';scheduleMedia();}
  async function uploadAvatar(native=false,event?:unknown){
    if(!editable.value)return;const ticket=generation,stamp=identity(),scope=createCustomerProfileRequests(()=>current()&&ticket===generation&&stamp===identity());
    const image=createProfileAvatarPreparation(()=>scope.active(),size=>{avatarCanvas.value=size;},instance);preparation=image;
    actionScope=scope;busy.value=native?'prepare':'choose';error.value='';
    try{
      let filePath:string;
      if(!native){const file=await image.choose();if(!scope.active()||!file)return;busy.value='prepare';filePath=await image.prepare(file);}
      else filePath=await image.native(event);
      if(!scope.active())return;
      busy.value='upload';const result=await scope.upload(filePath);if(!scope.active())return;
      draft.value.avatar=result.url;preview.value=result.src;failedImage.value='';uploadReview.value=false;notice.value='头像已上传，保存修改后生效';scheduleMedia();
    }catch(reason){if(scope.active()){uploadReview.value=busy.value==='upload';error.value=uploadReview.value?`头像上传未确认：${message(reason)}。可保留原头像后继续编辑。`:message(reason);}}
    finally{if(scope.active()){busy.value='';nativeAvatarEpoch.value++;if(actionScope===scope)actionScope=undefined;avatarCanvas.value={width:1,height:1};}if(preparation===image)preparation=undefined;image.abort();scope.abort();}
  }
  const chooseAvatar=()=>uploadAvatar();
  function cancelAvatarChoice(){
    if(busy.value!=='choose'||!owns())return;
    const image=preparation,scope=actionScope;preparation=undefined;actionScope=undefined;
    image?.abort();scope?.abort();busy.value='';nativeAvatarEpoch.value++;
    error.value='';notice.value='已取消头像选择，可重新选择';scheduleMedia();
  }
  const nativeAvatarButton=computed(()=>{
    const epoch=nativeAvatarEpoch.value,ticket=generation,stamp=identity();let used=false;
    return{key:epoch,choose:(event:unknown)=>{
      if(used||epoch!==nativeAvatarEpoch.value||ticket!==generation||stamp!==identity()||!editable.value)return Promise.resolve();
      used=true;return uploadAvatar(true,event);
    }};
  });
  async function save(){
    if(!editable.value||!snapshot.value)return;let payload:ReturnType<typeof encodeProfileSave>;
    try{payload=encodeProfileSave(snapshot.value,draft.value);}catch(reason){error.value=message(reason);return;}
    const ticket=generation,stamp=identity(),scope=createCustomerProfileRequests(()=>current()&&ticket===generation&&stamp===identity());actionScope=scope;busy.value='save';error.value=notice.value='';let confirmed=false;
    try{await scope.save(payload);if(!scope.active())return;confirmed=true;needsReview.value=true;notice.value='资料保存已确认，正在读取最新资料';}
    catch(reason){if(scope.active()){
      const known=reason instanceof RequestError&&reason.status!==undefined&&([400,403,404,409,422].includes(reason.status)||reason.status>=410000&&reason.status<=410999);
      needsReview.value=!known||reason instanceof RequestError&&reason.status===409;if(needsReview.value)uncertainOwner=stamp;
      error.value=known?message(reason):`资料保存结果未确认：${message(reason)}。草稿已保留，请重新读取核对；不会自动重试。`;
    }}finally{if(scope.active()){busy.value='';if(actionScope===scope)actionScope=undefined;}scope.abort();}
    if(confirmed&&ticket===generation&&current())await load(false,true,true);
  }
  function navigate(url:string){if(!current()||locked.value)return;uni.navigateTo({url});}
  function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
  function syncPersisted(){
    ownerClock.value++;let token:unknown,uid:number;try{token=uni.getStorageSync('uni_token')||'';uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{clear();return;}
    if(typeof token!=='string'||!Number.isSafeInteger(uid)||uid<0||token!==''&&uid<1||token===''&&uid!==0){clear();return;}
    if(auth.token!==token||auth.uid!==uid)auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});
    else if(snapshot.value&&!owns())clear();
  }
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load(false,false);});},{flush:'sync'});
  function changed(){syncPersisted();}
  onShow(()=>{visible.value=true;syncPersisted();clear();void load(false,false);
    // #ifdef MP-WEIXIN
    try{nativeAvatarAvailable.value=typeof uni.canIUse==='function'&&uni.canIUse('button.open-type.chooseAvatar');}catch{nativeAvatarAvailable.value=false;}
    // #endif
    // #ifdef H5
    if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
    // #endif
  });
  function leave(){visible.value=false;clear();
    // #ifdef H5
    if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
    // #endif
  }
  onHide(leave);onUnload(()=>{leave();disposed=true;uncertainOwner='';});
  return{passwordAvailable,snapshot,draft,fields,loading,busy,locked,editable,loggedIn,error,notice,needsReview,uploadReview,backup,canRestore,avatar,avatarView,
    avatarCanvas,avatarCanvasId:PROFILE_AVATAR_CANVAS_ID,nativeAvatarAvailable,nativeAvatarButton,
    load:()=>load(false,true),save,chooseAvatar,cancelAvatarChoice,keepAvatar,restore,discardBackup,setNickname,setField,login,
    phone:()=>navigate('/pages/user/phone'),password:()=>navigate('/pages/user/changePassword')};
}
