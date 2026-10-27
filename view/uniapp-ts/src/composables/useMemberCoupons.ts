import {computed,ref,watch} from 'vue';
import {onShow,onHide,onUnload,onReachBottom} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {RequestError} from '@/utils/request';
import {createMemberCouponRequests,memberCouponAmount,type MemberCouponIssue,type MemberOwnedCoupon,type MemberCouponPage,type MemberCouponRequests} from '@/api/memberCoupons';
type Phase='idle'|'claiming'|'uncertain'|'received';
interface Journal{version:1;uid:number;issueId:number}
const writers=new Set<number>();
const key=(uid:number)=>`cinashop-member-coupon-claim-v1-${uid}`;
function journal(uid:number):Journal|null{const raw=uni.getStorageSync(key(uid));if(raw===''||raw===null||raw===undefined)return null;if(typeof raw!=='string'||raw.length>512)throw Error('原领取记录暂不可读取，请联系客服核对');let j:Journal;try{j=JSON.parse(raw) as Journal;}catch{throw Error('原领取记录暂不可读取，请联系客服核对');}if(!j||typeof j!=='object'||Array.isArray(j)||j.version!==1||j.uid!==uid||!Number.isSafeInteger(j.issueId)||j.issueId<1||j.issueId>2147483647)throw Error('原领取记录暂不可读取，请联系客服核对');return j;}
function save(j:Journal){const raw=JSON.stringify(j);uni.setStorageSync(key(j.uid),raw);if(uni.getStorageSync(key(j.uid))!==raw)throw Error('领取记录未能保存，本次未继续提交');}
async function exclusive(uid:number,action:()=>Promise<void>){
 // #ifdef H5
 if(typeof window!=='undefined'){if(!navigator.locks?.request)throw Error('当前浏览器暂不能领取，请更换浏览器后查看原领取结果');await navigator.locks.request(`cinashop-member-coupons-${uid}`,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('另一页面正在领取，请稍后查看原领取结果');await action();});return;}
 // #endif
 if(writers.has(uid))throw Error('另一页面正在领取，请稍后查看原领取结果');writers.add(uid);try{await action();}finally{writers.delete(uid);}
}
const message=(v:unknown)=>v instanceof Error?v.message:'会员优惠券暂不可读取';
const rejected=(v:unknown)=>v instanceof RequestError&&v.status===400&&v.httpStatus!==undefined&&v.httpStatus>=200&&v.httpStatus<300;
export function useMemberCoupons(){
 const auth=useAuthStore(),visible=ref(false),data=ref<MemberCouponPage|null>(null),rows=ref<MemberCouponIssue[]>([]),loading=ref(false),busy=ref(false),error=ref(''),notice=ref(''),phase=ref<Phase>('idle'),pendingIssue=ref(0),confirmed=ref<MemberOwnedCoupon|null>(null),expanded=ref<number[]>([]),clock=ref(0),ownerClock=ref(0);
 const scopes=new Set<MemberCouponRequests>();const next=ref<number|null>(1);let generation=0,disposed=false,serverAt=0,receivedAt=0,timer:ReturnType<typeof setTimeout>|undefined;
 const identity=()=>JSON.stringify([auth.uid,auth.token,auth.sessionVersion]);let pageOwner=identity();
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const loggedIn=computed(()=>{void ownerClock.value;return auth.isLoggedIn&&auth.uid>0&&persisted();}),current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 function request(ticket=generation){const r=createMemberCouponRequests(()=>current()&&ticket===generation);scopes.add(r);return r;}
 function finish(r:MemberCouponRequests){scopes.delete(r);r.abort();}
 function cancel(){generation++;for(const r of scopes)r.abort();scopes.clear();loading.value=false;busy.value=false;clearTimeout(timer);timer=undefined;clock.value++;}
 function clear(){cancel();data.value=null;rows.value=[];next.value=1;error.value='';notice.value='';phase.value='idle';pendingIssue.value=0;confirmed.value=null;expanded.value=[];serverAt=0;receivedAt=0;pageOwner=identity();}
 const now=()=>{void clock.value;return serverAt?serverAt+Math.max(0,Date.now()-receivedAt)/1000:Date.now()/1000;};
 function schedule(){clearTimeout(timer);timer=undefined;clock.value++;const time=now(),dates=rows.value.flatMap(v=>v.owned?[v.owned.start,v.owned.end]:[]).filter((v):v is number=>v!==null&&v>=time);if(confirmed.value)for(const value of [confirmed.value.start,confirmed.value.end])if(value!==null&&value>=time)dates.push(value);if(!dates.length)return;const ticket=generation;timer=setTimeout(()=>{if(current()&&ticket===generation){clock.value++;schedule();}},Math.min(2147483647,Math.max(1,(Math.min(...dates)-time)*1000+1)));}
 function ownedRecord(j:Journal){if(!current()||j.uid!==auth.uid)throw Error('登录状态已变化');const live=journal(j.uid);if(!live||live.issueId!==j.issueId)throw Error('原领取记录已变化，请重新读取');return live;}
 function remove(j:Journal){ownedRecord(j);uni.removeStorageSync(key(j.uid));if(uni.getStorageSync(key(j.uid)))throw Error('原领取记录暂未清理，请查看原领取结果');}
 function confirmedCoupon(j:Journal,coupon:MemberOwnedCoupon){ownedRecord(j);if(coupon.issueId!==j.issueId)throw Error('领取结果与原优惠券不一致');confirmed.value=coupon;pendingIssue.value=j.issueId;rows.value=rows.value.map(v=>v.id===j.issueId?{...v,owned:coupon,claimable:false,reason:'已领取'}:v);phase.value='received';error.value='';notice.value='会员优惠券已领取';try{remove(j);}catch{notice.value='会员优惠券已领取，本机记录暂未清理，请查看原领取结果';}schedule();}
 function adopt(page:MemberCouponPage,append:boolean){if(append&&page.list.some(v=>rows.value.some(old=>old.id===v.id)))throw Error('会员券分页已变化，请刷新列表');data.value=page;serverAt=page.now;receivedAt=Date.now();rows.value=append?[...rows.value,...page.list]:page.list;next.value=page.next;schedule();}
 async function recover(j:Journal,r:MemberCouponRequests){ownedRecord(j);pendingIssue.value=j.issueId;const receipt=await r.receipt(j.issueId);if(!r.active())return false;if(receipt.coupon){confirmedCoupon(j,receipt.coupon);return true;}phase.value='uncertain';error.value='原领取结果尚未确认，请查看结果或继续领取原券。';return false;}
 async function load(append=false){if(!current()||loading.value||busy.value||append&&next.value===null)return;if(!append){cancel();error.value='';notice.value='';confirmed.value=null;expanded.value=[];rows.value=[];data.value=null;next.value=1;phase.value='idle';pendingIssue.value=0;}const ticket=generation,r=request(ticket),page=append?next.value!:1;loading.value=true;try{const fresh=await r.list(page);if(!r.active())return;adopt(fresh,append);if(!append){const j=journal(auth.uid);if(j){phase.value='uncertain';pendingIssue.value=j.issueId;await recover(j,r);}}}catch(v){if(r.active()){error.value=message(v);try{if(journal(auth.uid))phase.value='uncertain';}catch{phase.value='uncertain';}}}finally{if(ticket===generation){loading.value=false;if(current())schedule();}finish(r);}}
 async function write(action:(r:MemberCouponRequests)=>Promise<void>){if(!current()||busy.value||loading.value)return;cancel();const ticket=generation,r=request(ticket);busy.value=true;error.value='';notice.value='';try{await exclusive(auth.uid,async()=>{if(r.active())await action(r);});}catch(v){if(r.active()){phase.value='uncertain';error.value=message(v);}}finally{if(ticket===generation){busy.value=false;if(current())schedule();}finish(r);}}
 function canClaim(row:MemberCouponIssue){if(!current()||loading.value||busy.value||phase.value==='uncertain'||row.owned||!row.claimable||!data.value?.eligibility.eligible)return false;try{return !journal(auth.uid);}catch{return false;}}
 async function claimOriginal(j:Journal,r:MemberCouponRequests,first:boolean){phase.value='claiming';pendingIssue.value=j.issueId;confirmed.value=null;let result:MemberOwnedCoupon;try{result=await r.claim(j.issueId);}catch(v){if(!r.active())return;if(first&&rejected(v)){try{remove(j);phase.value='idle';}catch{phase.value='uncertain';}error.value=message(v);}else{phase.value='uncertain';error.value='原领取结果尚未确认，请查看结果或继续领取原券。';}return;}if(!r.active())return;confirmedCoupon(j,result);try{const fresh=await r.list(1);if(r.active())adopt(fresh,false);}catch{if(r.active())notice.value='会员优惠券已领取，列表暂未刷新，请稍后刷新';}}
 async function claim(id:number){const row=rows.value.find(v=>v.id===id);if(!row||!canClaim(row))return;await write(async r=>{if(journal(auth.uid))throw Error('请先查看原领取结果');const j:Journal={version:1,uid:auth.uid,issueId:id};save(j);await claimOriginal(j,r,true);});}
 async function readOriginal(){if(!current()||busy.value||loading.value)return;cancel();const ticket=generation,r=request(ticket);loading.value=true;error.value='';try{const j=journal(auth.uid);if(!j){phase.value='idle';return;}await recover(j,r);}catch(v){if(r.active()){phase.value='uncertain';error.value=message(v);}}finally{if(ticket===generation){loading.value=false;if(current())schedule();}finish(r);}}
 async function continueOriginal(){await write(async r=>{const j=journal(auth.uid);if(!j){phase.value='idle';return;}if(await recover(j,r))return;if(r.active())await claimOriginal(j,r,false);});}
 function usable(c:MemberOwnedCoupon){const time=now();return c.status===0&&!c.failed&&(c.start===null||c.start<=time)&&(c.end===null||c.end>=time);}
 function status(c:MemberOwnedCoupon){const time=now();return c.status===1?'已使用':c.status===3?'订单占用中':c.status===2||c.end!==null&&c.end<time?'已过期':c.failed||c.status!==0?'已失效':c.start!==null&&c.start>time?'未到使用时间':'去使用';}
 function useCoupon(id:number){if(!current()||busy.value||loading.value)return;const coupon=rows.value.flatMap(v=>v.owned?[v.owned]:[]).find(v=>v.id===id)??(confirmed.value?.id===id?confirmed.value:null);if(coupon&&usable(coupon))uni.navigateTo({url:'/pages/user/couponProducts?couponId='+coupon.id});}
 function toggleRule(id:number){if(!current()||busy.value||!rows.value.some(v=>v.id===id&&v.rule))return;expanded.value=expanded.value.includes(id)?expanded.value.filter(v=>v!==id):[...expanded.value,id];}
 function membership(){if(current()&&!busy.value)uni.navigateTo({url:'/pages/user/vipOpen'});}
 function wallet(){if(current()&&!busy.value)uni.navigateTo({url:'/pages/user/coupon'});}
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
 onHide(leave);onUnload(()=>{leave();disposed=true;});onReachBottom(()=>{if(current())void load(true);});
 function date(v:number|null){return v===null?'不限':new Date(v*1000).toLocaleDateString('sv-SE');}
 function validity(row:MemberCouponIssue){return row.owned?`${date(row.owned.start)} 至 ${date(row.owned.end)}`:row.validity.kind==='relative'?`领取后${row.validity.days}天内有效`:`${date(row.validity.start)} 至 ${date(row.validity.end)}`;}
 const finished=computed(()=>next.value===null);
 return{data,rows,loggedIn,loading,busy,error,notice,phase,pendingIssue,confirmed,expanded,finished,canClaim,claim,readOriginal,continueOriginal,load,toggleRule,useCoupon,usable,status,validity,membership,wallet,login,amount:memberCouponAmount,scope:(type:number)=>['通用','品类','商品','品牌'][type]??'优惠券'};
}
