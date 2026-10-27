import {computed,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {RequestError} from '@/utils/request';
import {createLevelActivationRequests,type LevelActivationState,type LevelActivationReceipt,type LevelActivationField,type LevelActivationCity,type LevelActivationRequests} from '@/api/memberLevelActivation';

type Phase='idle'|'pending'|'success'|'uncertain'|'active';
type Region={indices:[number,number,number];label:string};
/** One free account activation; private drafts never enter the recovery marker. */
export function useMemberLevelActivation(){
 const auth=useAuthStore(),visible=ref(false),state=ref<LevelActivationState|null>(null),fields=ref<LevelActivationField[]>([]),receipt=ref<LevelActivationReceipt|null>(null),phase=ref<Phase>('idle'),loading=ref(false),error=ref(''),ownerClock=ref(0),epoch=ref(0);
 const cities=ref<LevelActivationCity[]>([]),citiesLoading=ref(false),cityError=ref(''),regions=ref<Record<string,Region>>({});
 let disposed=false,generation=0,readScope:LevelActivationRequests|undefined,writeScope:LevelActivationRequests|undefined,cityScope:LevelActivationRequests|undefined;
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const loggedIn=computed(()=>{void ownerClock.value;return auth.uid>0&&auth.isLoggedIn&&persisted();}),current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 const markerPrefix=(uid=auth.uid)=>'member_level_activation_pending:'+uid+':';
 function pendingKeys(){const info=uni.getStorageInfoSync();if(!info||!Array.isArray(info.keys)||info.keys.length>10000||info.keys.some(k=>typeof k!=='string'))throw Error('本机请求状态无法读取');return info.keys.filter(k=>k.startsWith(markerPrefix()));}
 function unresolved(){try{return pendingKeys().length>0;}catch{return true;}}
 function markPending():string{try{pendingKeys();const key=markerPrefix()+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),value={version:1,owner_uid:auth.uid,started_at:Date.now()};uni.setStorageSync(key,value);const saved=uni.getStorageSync(key);if(!saved||typeof saved!=='object'||saved.version!==1||saved.owner_uid!==auth.uid||saved.started_at!==value.started_at)throw Error('存储未确认');return key;}catch{throw Error('无法保存激活请求状态，请检查本机存储后重试');}}
 function clearMarker(key?:string){try{for(const name of key?[key]:pendingKeys())uni.removeStorageSync(name);}catch{/* A retained marker only requires another read on a future visit. */}}
 function cancel(){generation++;epoch.value=generation;readScope?.abort();writeScope?.abort();cityScope?.abort();readScope=writeScope=cityScope=undefined;loading.value=citiesLoading.value=false;}
 function clearPrivate(){state.value=null;fields.value=[];receipt.value=null;regions.value={};cities.value=[];error.value='';cityError.value='';}
 function reset(){cancel();clearPrivate();phase.value=auth.uid>0&&unresolved()?'uncertain':'idle';}
 function ready(){return current()&&!loading.value&&phase.value==='idle'&&!!state.value&&state.value.member_enabled&&state.value.activation_required&&!state.value.activated&&fields.value.length===state.value.fields.length;}
 const canSubmit=computed(ready),submitting=computed(()=>phase.value==='pending');
 async function load(){
  if(!current()||phase.value==='pending'||loading.value)return;
  cancel();clearPrivate();phase.value=unresolved()?'uncertain':'idle';const ticket=generation,request=createLevelActivationRequests(()=>current()&&generation===ticket);readScope=request;loading.value=true;
  try{const result=await request.state();if(!request.active())return;state.value=result;
   if(result.activated){clearMarker();phase.value='active';}
   else{phase.value=unresolved()?'uncertain':'idle';fields.value=result.fields.map(f=>({...f,singlearr:[...f.singlearr]}));if(phase.value==='idle'&&fields.value.some(f=>f.format==='address'))void loadCities();}
  }catch(reason){if(request.active())error.value=reason instanceof Error?reason.message:'会员激活信息读取失败';}
  finally{if(ticket===generation){loading.value=false;if(readScope===request)readScope=undefined;}request.abort();}
 }
 async function loadCities(){
  if(!current()||!state.value||phase.value!=='idle'||citiesLoading.value||cities.value.length)return;
  const ticket=generation,request=createLevelActivationRequests(()=>current()&&generation===ticket);cityScope?.abort();cityScope=request;citiesLoading.value=true;cityError.value='';
  try{const result=await request.cities();if(request.active()){cities.value=result;if(!result.length)cityError.value='地区目录暂不可用，请稍后重新读取';}}
  catch(reason){if(request.active())cityError.value=reason instanceof Error?reason.message:'地区读取失败';}
  finally{if(ticket===generation){citiesLoading.value=false;if(cityScope===request)cityScope=undefined;}request.abort();}
 }
 function validate():Array<{info:string;value:string}>{
  return fields.value.map(f=>{const value=f.value.trim(),bad=()=>{throw Error(f.tip.trim()||'请正确填写'+f.info);};if(f.required&&!value)bad();if([...value].length>1024||/[\u0000-\u001f\u007f]/u.test(value))bad();if(value){
   if(f.format==='num'&&(!/^\d+(?:\.\d+)?$/u.test(value)||Number(value)<=0||!Number.isFinite(Number(value))))bad();
   if(f.format==='mail'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))bad();
   if(f.format==='phone'&&!/^1[3-9]\d{9}$/u.test(value))bad();
   if(f.format==='id'&&!/^(?:\d{15}|\d{17}[\dXx])$/u.test(value))bad();
   if(f.format==='radio'&&(!/^(0|[1-9]\d*)$/u.test(value)||Number(value)>=f.singlearr.length))bad();
   if(f.format==='date'){const match=/^(\d{4})-(\d{2})-(\d{2})$/u.exec(value),d=new Date(value+'T00:00:00Z');if(!match||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value||Number(match[1])<1900||value>=today())bad();}
  }return{info:f.info,value};});
 }
 async function activate(){
  if(!ready())return;error.value='';let values:Array<{info:string;value:string}>;const revision=state.value!.revision;
  try{values=validate();if(new TextEncoder().encode(JSON.stringify({revision,fields:values})).byteLength>16*1024)throw Error('激活资料超过16KiB，请缩短填写内容');}catch(reason){error.value=reason instanceof Error?reason.message:'请检查填写的资料';return;}
  let marker:string;try{marker=markPending();}catch(reason){error.value=reason instanceof Error?reason.message:'无法保存激活请求状态';return;}
  const ticket=++generation;epoch.value=ticket;readScope?.abort();cityScope?.abort();readScope=cityScope=undefined;loading.value=citiesLoading.value=false;
  const request=createLevelActivationRequests(()=>current()&&generation===ticket);writeScope=request;phase.value='pending';receipt.value=null;
  try{const result=await request.activate(revision,values);if(!request.active())return;fields.value=[];regions.value={};clearMarker();receipt.value=result;phase.value='success';state.value=state.value?{...state.value,activated:true,level_status:1}:null;
   if(result.rewards.level_give_integral===0&&result.rewards.level_give_money===0&&result.owned_coupons.length===0)goLevel();
  }catch(reason){if(!request.active())return;const rejected=reason instanceof RequestError&&reason.httpStatus!==undefined&&reason.httpStatus>=200&&reason.httpStatus<300&&[400,409].includes(reason.status??0);
   if(rejected){clearMarker(marker!);if(!unresolved()){phase.value='idle';error.value=reason.message;}else{fields.value=[];regions.value={};phase.value='uncertain';error.value='激活结果暂未确认，请先重新读取会员状态。';}}
   else{fields.value=[];regions.value={};phase.value='uncertain';error.value='激活结果暂未确认，请先重新读取会员状态。';}
  }finally{values=[];if(writeScope===request)writeScope=undefined;request.abort();}
 }
 function startAgain(){if(!current()||phase.value!=='uncertain'||loading.value||!state.value||state.value.activated||!state.value.member_enabled||!state.value.activation_required)return;cancel();fields.value=state.value.fields.map(f=>({...f,singlearr:[...f.singlearr]}));regions.value={};phase.value='idle';error.value='上次请求可能仍在处理，资料以先完成的激活为准；奖励仅发放一次。';if(fields.value.some(f=>f.format==='address'))void loadCities();}
 function today(){const date=new Date();return[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');}
 const dateEnd=computed(()=>{const date=new Date(Date.now()-86400000);return[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');});
 function form(){
  void epoch.value;const ticket=generation,owner=auth.uid,token=auth.token,session=auth.sessionVersion,document=state.value;
  const allowed=()=>current()&&ticket===generation&&owner===auth.uid&&token===auth.token&&session===auth.sessionVersion&&document===state.value&&phase.value==='idle';
  const indices=(info:string):[number,number,number]=>regions.value[info]?.indices??[0,0,0];
  function ranges(info:string){const [p,c]=indices(info),province=cities.value[p],city=province?.children[c];return[cities.value.map(v=>v.n),province?.children.map(v=>v.n)??[],city?.children.length?city.children.map(v=>v.n):['—']];}
  return{epoch:ticket,fields:current()?fields.value:[],allowed,indices,ranges,label:(info:string)=>regions.value[info]?.label||'省，市，区',
   input(info:string,value:unknown){if(!allowed()||typeof value!=='string')return;const field=fields.value.find(f=>f.info===info);if(field&&field.format!=='address')field.value=value;},
   column(info:string,detail:unknown){if(!allowed()||!detail||typeof detail!=='object')return;const d=detail as {column?:unknown;value?:unknown};if(!Number.isInteger(d.column)||!Number.isInteger(d.value)||Number(d.column)<0||Number(d.column)>2||Number(d.value)<0)return;const old=indices(info),next=[...old] as [number,number,number],column=Number(d.column),range=ranges(info);if(Number(d.value)>=range[column]!.length)return;next[column]=Number(d.value);if(column<2)next[2]=0;if(column===0)next[1]=0;regions.value={...regions.value,[info]:{indices:next,label:regions.value[info]?.label??''}};},
   region(info:string,detail:unknown){if(!allowed()||!detail||typeof detail!=='object')return;const value=(detail as {value?:unknown}).value;if(!Array.isArray(value)||value.length!==3||value.some(v=>!Number.isInteger(v)||v<0))return;const [p,c,a]=value as [number,number,number],province=cities.value[p],city=province?.children[c],area=city?.children[a],field=fields.value.find(f=>f.info===info&&f.format==='address');if(!field||!province||!city||city.children.length&&!area)return;field.value=String(city.v);regions.value={...regions.value,[info]:{indices:[p,c,a],label:[province.n,city.n,area?.n].filter(Boolean).join('，')}};},
  };
 }
 function goLevel(){if(current()&&phase.value!=='pending')uni.navigateTo({url:'/pages/user/level'});}
 function viewWallet(){if(current()&&phase.value!=='pending')uni.navigateTo({url:'/pages/user/coupon'});}
 function viewCoupon(id:number){const coupon=receipt.value?.owned_coupons.find(c=>c.id===id),now=Date.now();if(current()&&phase.value==='success'&&coupon&&coupon.status===0&&coupon.is_fail===0&&(coupon.start_time===null||Date.parse(coupon.start_time)<=now)&&(coupon.end_time===null||Date.parse(coupon.end_time)>=now))uni.navigateTo({url:'/pages/user/couponProducts?couponId='+id});}
 function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
 function changed(){if(!visible.value||disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}ownerClock.value++;if(token!==auth.token||uid!==auth.uid){reset();auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}if(current()&&!state.value&&!loading.value&&phase.value!=='pending')void load();}
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{reset();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
 onShow(()=>{visible.value=true;reset();changed();
  // #ifdef H5
  if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
  // #endif
 });
 function leave(){visible.value=false;if(phase.value==='pending')phase.value='uncertain';cancel();clearPrivate();
  // #ifdef H5
  if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
  // #endif
 }
 onHide(leave);onUnload(()=>{leave();disposed=true;});
 return{state,fields,receipt,phase,loading,error,loggedIn,canSubmit,submitting,cities,citiesLoading,cityError,dateEnd,form,load,loadCities,activate,startAgain,goLevel,viewWallet,viewCoupon,login};
}
