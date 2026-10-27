import {computed,ref,watch} from 'vue';
import {onShow,onHide,onUnload,onReachBottom} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {RequestError} from '@/utils/request';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightResolvedMedia,memberRightMediaDeadline} from '../../../common/memberRightMedia';
import {createMemberHomeRequests,memberRequestId,memberCents,memberMoney,memberPlatform,memberPurchaseChannel,type MemberHomeRequests,type MemberHomeData,type MemberHomeCoupon,type MemberHomeProduct,type MemberPurchaseOrder,type MemberPayMethod,type MemberCashier} from '@/api/memberHome';
import {launchMemberPayment} from '@/utils/membershipPayment';

type Phase='idle'|'creating'|'choosing'|'paying'|'uncertain'|'success';
interface Journal{version:1;uid:number;requestId:string;planId:number;orderId:string;stage:'create'|'created'|'pay'|'external';platform:string;channel:string;method?:MemberPayMethod}
const localWriters=new Set<number>();
function key(uid:number){return `cinashop-member-purchase-v1-${uid}`;}
function journal(uid:number):Journal|null{const raw=uni.getStorageSync(key(uid));if(raw===''||raw===null||raw===undefined)return null;if(typeof raw!=='string'||raw.length>2048)throw Error('原会员订单记录暂不可读取，请联系客服核对');let j:Journal;try{j=JSON.parse(raw) as Journal;}catch{throw Error('原会员订单记录暂不可读取，请联系客服核对');}if(!j||typeof j!=='object'||Array.isArray(j)||j.version!==1||j.uid!==uid||!memberRequestId(j.requestId)||!Number.isSafeInteger(j.planId)||j.planId<1||typeof j.orderId!=='string'||(j.orderId!==''&&!/^[A-Za-z0-9_-]{2,32}$/u.test(j.orderId))||!['create','created','pay','external'].includes(j.stage)||!['h5','routine','app'].includes(j.platform)||!['weixinh5','weixin','routine'].includes(j.channel)||(j.stage!=='create'&&!j.orderId)||((j.stage==='pay'||j.stage==='external')&&!['yue','weixin','alipay'].includes(j.method??'')))throw Error('原会员订单记录暂不可读取，请联系客服核对');return j;}
function saveJournal(j:Journal){const raw=JSON.stringify(j);uni.setStorageSync(key(j.uid),raw);if(uni.getStorageSync(key(j.uid))!==raw)throw Error('原订单记录未能保存，本次未继续提交');}
function knownRejection(reason:unknown){return reason instanceof RequestError&&reason.httpStatus!==undefined&&reason.httpStatus>=200&&reason.httpStatus<300&&reason.status===400;}
function errorText(reason:unknown){return reason instanceof Error?reason.message:'会员信息暂不可读取';}
async function exclusive(uid:number,work:()=>Promise<void>){
 // #ifdef H5
 if(typeof window!=='undefined'){if(!navigator.locks?.request)throw Error('当前浏览器暂不能处理会员购买，请更换浏览器后继续原订单');await navigator.locks.request(`cinashop-membership-${uid}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('另一页面正在处理会员订单，请稍后查看原订单状态');await work();});return;}
 // #endif
 if(localWriters.has(uid))throw Error('另一页面正在处理会员订单，请稍后查看原订单状态');localWriters.add(uid);try{await work();}finally{localWriters.delete(uid);}
}
export function useMemberHome(){
 const auth=useAuthStore(),visible=ref(false),home=ref<MemberHomeData|null>(null),selectedId=ref(0),agreed=ref(false),phase=ref<Phase>('idle'),error=ref(''),loading=ref(false),busy=ref(false),order=ref<MemberPurchaseOrder|null>(null),cashier=ref<MemberCashier|null>(null),method=ref<MemberPayMethod>('yue');
 const couponsOpen=ref(false),coupons=ref<MemberHomeCoupon[]>([]),couponLoading=ref(false),couponError=ref(''),couponFinished=ref(false);
 const products=ref<MemberHomeProduct[]>([]),productLoading=ref(false),productError=ref(''),productFinished=ref(false),ownerClock=ref(0),mediaClock=ref(0),mediaExpired=ref(false),failedMedia=ref<string[]>([]);
 const requests=new Set<MemberHomeRequests>();
 let generation=0,disposed=false,scope:MemberHomeRequests|undefined,writeScope:MemberHomeRequests|undefined,productPage=1,couponPage=1,couponGeneration=0,couponScope:MemberHomeRequests|undefined,mediaTimer:ReturnType<typeof setTimeout>|undefined;
 const identity=()=>JSON.stringify([auth.uid,auth.token,auth.sessionVersion]);let pageOwner=identity();
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const loggedIn=computed(()=>{void ownerClock.value;return auth.uid>0&&auth.isLoggedIn&&persisted();}),current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 const plans=computed(()=>home.value?.permanent?[]:(home.value?.plans??[]).filter(p=>p.type!=='free'||!home.value?.freeUsed));
 const selected=computed(()=>plans.value.find(p=>p.id===selectedId.value)??null);
 const canCreate=computed(()=>current()&&!loading.value&&!busy.value&&phase.value==='idle'&&!!selected.value&&!!home.value);
 const lockedMethod=computed(()=>{void phase.value;void busy.value;void ownerClock.value;try{const j=loggedIn.value?journal(auth.uid):null;return j?.stage==='pay'||j?.stage==='external';}catch{return true;}});
 const canPay=computed(()=>current()&&!busy.value&&phase.value==='choosing'&&!!order.value&&cashier.value?.payable===true&&cashier.value.methods[method.value].enabled);
 const expiry=computed(()=>{const epoch=home.value?.expiry??0;return epoch>0?new Date(epoch*1000).toLocaleDateString('sv-SE'):'未开通会员';});
 function cancel(){generation++;mediaClock.value++;for(const r of requests)r.abort();requests.clear();scope?.abort();writeScope?.abort();scope=undefined;writeScope=undefined;clearTimeout(mediaTimer);mediaTimer=undefined;loading.value=false;busy.value=false;couponLoading.value=false;productLoading.value=false;}
 function clear(){cancel();home.value=null;selectedId.value=0;agreed.value=false;phase.value='idle';error.value='';order.value=null;cashier.value=null;method.value='yue';coupons.value=[];couponsOpen.value=false;couponError.value='';couponFinished.value=false;couponPage=1;products.value=[];productError.value='';productFinished.value=false;productPage=1;failedMedia.value=[];mediaExpired.value=false;mediaClock.value++;pageOwner=identity();}
 function scheduleMedia(){clearTimeout(mediaTimer);mediaTimer=undefined;mediaClock.value++;const refs=[home.value?.avatar??'',...(home.value?.rights.map(v=>v.image)??[]),...products.value.map(v=>v.image)],deadline=memberRightMediaDeadline(refs,[]);mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;const ticket=generation;mediaTimer=setTimeout(()=>{if(current()&&ticket===generation){mediaClock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));}
 function preview(raw:string){void mediaClock.value;const ticket=generation,owner=identity(),url=current()?memberRightResolvedMedia(raw):'',src=failedMedia.value.includes(url)?'':memberLevelImage(url);return{src,error:()=>{if(url&&current()&&ticket===generation&&owner===identity()&&!failedMedia.value.includes(url))failedMedia.value.push(url);}};}
 function request(ticket=generation,extra:()=>boolean=()=>true){const r=createMemberHomeRequests(()=>current()&&generation===ticket&&extra());requests.add(r);return r;}
 function finish(r:MemberHomeRequests){requests.delete(r);r.abort();}
 function ownedJournal(j:Journal){if(!current()||j.uid!==auth.uid)throw Error('登录状态已变化');const live=journal(auth.uid);if(!live||live.requestId!==j.requestId||live.planId!==j.planId||live.platform!==j.platform||live.channel!==j.channel)throw Error('原会员订单记录已变化，请重新读取');return live;}
 function remove(j:Journal){const live=ownedJournal(j);uni.removeStorageSync(key(live.uid));if(uni.getStorageSync(key(live.uid)))throw Error('原会员订单记录未能清理，请查看会员状态');}
 async function acceptReceipt(j:Journal,r:MemberHomeRequests,interactive:boolean,paidRecheck=false){
  const receipt=await r.receipt(j.requestId);if(!r.active())return false;const live=ownedJournal(j);
  if(!receipt.order){phase.value='uncertain';error.value='原购买结果暂未确认，请查看状态或继续处理原订单。';return false;}
  if(receipt.order.planId!==j.planId||(live.orderId&&live.orderId!==receipt.order.orderId))throw Error('会员订单与原购买记录不一致');
  order.value=receipt.order;if(receipt.order.paid){remove(j);resetProducts();phase.value='success';error.value='';cashier.value=null;home.value=null;try{const refreshed=await r.home();if(r.active()){home.value=refreshed;selectedId.value=plans.value[0]?.id??0;scheduleMedia();}}catch{if(r.active())error.value='会员已开通，资料暂未刷新，请重新读取会员首页。';}return true;}
  const next={...live,orderId:receipt.order.orderId,stage:live.stage==='create'?'created' as const:live.stage};saveJournal(next);
  const data=await r.cashier(receipt.order.orderId);if(!r.active())return false;
  if(data.price!==receipt.order.price)throw Error('会员订单金额已变化，请重新读取');
  if(data.paid){if(paidRecheck)throw Error('原订单状态暂不一致，请重新读取');return acceptReceipt(next,r,interactive,true);}
  cashier.value=data;method.value=next.method??(['yue','weixin','alipay'] as const).find(k=>(k!=='alipay'||memberPlatform()==='h5')&&data.methods[k].enabled)??'yue';
  phase.value=interactive?'choosing':'uncertain';error.value=interactive?'':'原会员订单尚未完成，请继续处理原订单。';return true;
 }
 function resetProducts(){products.value=[];productPage=1;productFinished.value=false;productError.value='';}
 async function load(){
  if(!current()||loading.value||busy.value)return;cancel();const ticket=generation;const r=request(ticket);scope=r;loading.value=true;error.value='';resetProducts();home.value=null;order.value=null;cashier.value=null;selectedId.value=0;agreed.value=false;
  try{const data=await r.home();if(!r.active())return;home.value=data;selectedId.value=plans.value[0]?.id??0;failedMedia.value=[];scheduleMedia();const j=journal(auth.uid);if(j){phase.value='uncertain';await acceptReceipt(j,r,false);}else phase.value='idle';}
  catch(reason){if(r.active()){error.value=errorText(reason);phase.value='uncertain';}}
  finally{if(ticket===generation){loading.value=false;if(scope===r)scope=undefined;}finish(r);}
  if(current()&&!products.value.length&&!productLoading.value)void moreProducts();
 }
 async function runWrite(action:(r:MemberHomeRequests)=>Promise<void>){
  if(!current()||busy.value)return;cancel();busy.value=true;error.value='';const ticket=generation;const r=request(ticket);writeScope=r;
  try{await exclusive(auth.uid,async()=>{if(r.active())await action(r);});}
  catch(reason){if(r.active()){phase.value='uncertain';error.value=errorText(reason);}}
  finally{if(ticket===generation){busy.value=false;if(current())scheduleMedia();}if(writeScope===r)writeScope=undefined;finish(r);if(current()&&home.value&&!products.value.length&&!productLoading.value)void moreProducts();}
 }
 async function createFor(j:Journal,r:MemberHomeRequests,first:boolean){
  phase.value='creating';let result:MemberPurchaseOrder;
  try{result=await r.create(j.planId,j.requestId);}
  catch(reason){
   if(!r.active())return;
   if(first&&knownRejection(reason)){remove(j);phase.value='idle';error.value=errorText(reason);try{const refreshed=await r.home();if(r.active()){home.value=refreshed;selectedId.value=plans.value[0]?.id??0;scheduleMedia();}}catch{if(r.active()){home.value=null;error.value+='，会员资料暂未刷新';}}}
   else{phase.value='uncertain';error.value='原购买结果暂未确认，请查看状态或继续处理原订单。';}
   return;
  }
  if(!r.active())return;
  try{const live=ownedJournal(j);saveJournal({...live,orderId:result.orderId});await acceptReceipt(j,r,true);}
  catch{if(r.active()){phase.value='uncertain';error.value='原订单已经返回，请查看状态或继续处理原订单。';}}
 }

 async function create(){
  if(!canCreate.value)return;if(!agreed.value){error.value='请先阅读并同意会员服务协议';return;}
  const plan=selected.value!,data=home.value!;await runWrite(async r=>{if(journal(auth.uid)){phase.value='uncertain';error.value='已有会员订单待确认，请先处理原订单';return;}const j:Journal={version:1,uid:auth.uid,requestId:data.requestId,planId:plan.id,orderId:'',stage:'create',platform:memberPlatform(),channel:memberPurchaseChannel()};saveJournal(j);await createFor(j,r,true);});
 }
 async function readOriginal(){if(!current()||busy.value)return;cancel();const ticket=generation;const r=request(ticket);scope=r;loading.value=true;error.value='';try{const j=journal(auth.uid);if(!j){phase.value='idle';return;}await acceptReceipt(j,r,false);}catch(reason){if(r.active()){phase.value='uncertain';error.value=errorText(reason);}}finally{if(ticket===generation){loading.value=false;if(current())scheduleMedia();}if(scope===r)scope=undefined;finish(r);}}
 async function continueOriginal(){if(!current()||busy.value)return;await runWrite(async r=>{const j=journal(auth.uid);if(!j){phase.value='idle';return;}if(j.platform!==memberPlatform()||j.channel!==memberPurchaseChannel())throw Error('请在原支付环境继续处理会员订单');if(await acceptReceipt(j,r,true))return;if(r.active())await createFor(j,r,false);});}
 async function pay(){
  if(!canPay.value||!order.value)return;const chosen=method.value;await runWrite(async r=>{let j=journal(auth.uid);if(!j||j.orderId!==order.value?.orderId)throw Error('原会员订单记录已变化');if(j.platform!==memberPlatform()||j.channel!==memberPurchaseChannel())throw Error('请在原支付环境继续处理会员订单');if((j.stage==='pay'||j.stage==='external')&&j.method!==chosen)throw Error('请先确认原支付结果');
   const status=await r.receipt(j.requestId);if(!r.active())return;if(!status.order||status.order.orderId!==j.orderId||status.order.planId!==j.planId)throw Error('原会员订单尚未确认');if(status.order.paid){await acceptReceipt(j,r,false);return;}
   const checkout=await r.cashier(j.orderId);if(!r.active())return;cashier.value=checkout;if(checkout.paid){await acceptReceipt(j,r,false);return;}if(!checkout.payable||!checkout.methods[chosen].enabled)throw Error(checkout.methods[chosen].reason||checkout.reason||'原订单暂不可支付');
   j={...ownedJournal(j),stage:'pay',method:chosen};saveJournal(j);phase.value='paying';
   let paymentReturned=false;try{const result=await r.pay(j.orderId,chosen);paymentReturned=true;if(!r.active())return;if(!result.paid){j={...ownedJournal(j),stage:'external'};saveJournal(j);await launchMemberPayment(result,()=>r.active());if(!r.active())return;}await acceptReceipt(j,r,false);if(r.active()&&order.value?.paid!==true){phase.value='uncertain';error.value='支付结果尚未确认，请查看原订单状态。';}}
   catch(reason){if(!r.active())return;if(!paymentReturned&&chosen==='yue'&&knownRejection(reason)){const safe={...ownedJournal(j),stage:'created' as const};delete safe.method;saveJournal(safe);phase.value='choosing';error.value=errorText(reason);}else{phase.value='uncertain';error.value='支付结果尚未确认，请查看原订单状态。';}}
  });
 }
 async function changePlan(){if(!current()||busy.value)return;await runWrite(async r=>{const j=journal(auth.uid);if(!j||j.stage!=='created')throw Error('请先确认原支付结果');const receipt=await r.receipt(j.requestId);if(!r.active())return;if(!receipt.order||receipt.order.orderId!==j.orderId)throw Error('原订单尚未确认');if(receipt.order.paid){await acceptReceipt(j,r,false);return;}remove(j);phase.value='idle';order.value=null;cashier.value=null;agreed.value=false;home.value=await r.home();if(r.active()){selectedId.value=plans.value[0]?.id??0;scheduleMedia();}});}
 function selectPlan(id:number){if(current()&&!busy.value&&phase.value==='idle'&&plans.value.some(p=>p.id===id))selectedId.value=id;}
 function selectMethod(value:MemberPayMethod){if(current()&&!busy.value&&phase.value==='choosing'&&cashier.value?.methods[value].enabled&&(!lockedMethod.value||method.value===value)&&(value!=='alipay'||memberPlatform()==='h5'))method.value=value;}
 function toggleAgreement(){if(current()&&!busy.value&&phase.value==='idle')agreed.value=!agreed.value;}
 function navigate(url:string){if(current()&&!busy.value)uni.navigateTo({url});}
 function rights(id?:number){if(id!==undefined&&!home.value?.rights.some(r=>r.id===id))return;navigate('/pages/user/vipRights'+(id?'?id='+id:''));}
 function agreement(){navigate('/pages/user/legalContent?type=payVip');}
 function activation(){navigate('/pages/annex/vip_active/index');}
 function product(id:number){if(products.value.some(v=>v.id===id))navigate('/pages/goods/detail?id='+id);}
 function successHome(){if(current()&&phase.value==='success'){phase.value='idle';order.value=null;cashier.value=null;error.value='';agreed.value=false;}}
 async function moreProducts(){if(!current()||productLoading.value||productFinished.value)return;const ticket=generation,r=request(ticket),page=productPage;productLoading.value=true;productError.value='';try{const list=await r.products(page);if(!r.active())return;if(list.some(v=>products.value.some(old=>old.id===v.id)))throw Error('推荐商品分页已变化，请重新读取会员首页');products.value.push(...list);productPage++;productFinished.value=list.length<15;scheduleMedia();}catch(reason){if(r.active())productError.value=errorText(reason);}finally{if(ticket===generation)productLoading.value=false;finish(r);}}
 async function moreCoupons(){if(!current()||!couponsOpen.value||couponLoading.value||couponFinished.value)return;const ticket=generation,pane=couponGeneration,r=request(ticket,()=>couponsOpen.value&&pane===couponGeneration),page=couponPage;couponScope=r;couponLoading.value=true;couponError.value='';try{const list=await r.coupons(page);if(!r.active())return;if(list.some(v=>coupons.value.some(old=>old.id===v.id)))throw Error('优惠券分页已变化，请关闭后重新读取');coupons.value.push(...list);couponPage++;couponFinished.value=list.length<10;}catch(reason){if(r.active())couponError.value=errorText(reason);}finally{if(ticket===generation&&pane===couponGeneration)couponLoading.value=false;if(couponScope===r)couponScope=undefined;finish(r);}}
 function openCoupons(){if(!current()||busy.value)return;couponScope?.abort();couponScope=undefined;couponGeneration++;couponLoading.value=false;couponsOpen.value=true;coupons.value=[];couponPage=1;couponFinished.value=false;couponError.value='';void moreCoupons();}
 function closeCoupons(){couponGeneration++;couponScope?.abort();couponScope=undefined;couponLoading.value=false;couponsOpen.value=false;coupons.value=[];}
 function login(){if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}
 function changed(){if(!visible.value||disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}ownerClock.value++;if(token!==auth.token||uid!==auth.uid){clear();auth.$patch({token,uid,sessionVersion:auth.sessionVersion+1});}if(pageOwner!==identity())clear();if(current()&&!busy.value&&!loading.value)void load();}
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
 onHide(leave);onUnload(()=>{leave();disposed=true;});onReachBottom(()=>{if(current())void moreProducts();});
 const avatarPreview=computed(()=>preview(home.value?.avatar??''));
 const rightItems=computed(()=>(home.value?.rights??[]).map(v=>({...v,preview:preview(v.image)})));
 const productItems=computed(()=>products.value.map(v=>({...v,preview:preview(v.image)})));
 const savings=(p:{price:string;payPrice:string})=>memberMoney(Math.max(0,memberCents(p.price)-memberCents(p.payPrice)));
 const couponAmount=(c:MemberHomeCoupon)=>c.type===1?c.price:String(memberCents(c.price)/1000);
 return{home,plans,selected,selectedId,agreed,phase,error,loading,busy,order,cashier,method,loggedIn,canCreate,canPay,lockedMethod,expiry,platform:memberPlatform(),couponsOpen,coupons,couponLoading,couponError,couponFinished,products,productLoading,productError,productFinished,mediaExpired,avatarPreview,rightItems,productItems,preview,savings,couponAmount,load,create,pay,readOriginal,continueOriginal,changePlan,selectPlan,selectMethod,toggleAgreement,rights,agreement,activation,product,successHome,moreProducts,openCoupons,closeCoupons,moreCoupons,login};
}
