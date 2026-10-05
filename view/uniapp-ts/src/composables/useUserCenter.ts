import { computed,ref,watch } from 'vue';
import { onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { useAdminSession } from '@/stores/adminSession';
import { createUserCenterRequests,type UserCenterRequests } from '@/api/userCenter';
import { parseUserCenterMenu,parseUserCenterStats,userCenterProperties,userCenterCountdown,userCenterDestination,openUserCenterDestination } from '@/utils/userCenter';
import QRCode from 'qrcode-terminal/vendor/QRCode';
import type { UserCenterSnapshot } from '@/types/userCenter';

export function useUserCenter(options:{autoMemberCode?:boolean}={}){
  const auth=useAuthStore(),admin=useAdminSession(),snapshot=ref<UserCenterSnapshot|null>(null),loading=ref(false),error=ref(''),navigationError=ref('');
  const toolsOpen=ref(false),codeOpen=ref(false),codeLoading=ref(false),codeError=ref(''),code=ref(''),codeDeadline=ref(0),clock=ref(Date.now()),showBalance=ref(false);
  let visible=false,disposed=false,generation=0,requests:UserCenterRequests|null=null,codeRequests:UserCenterRequests|null=null,timer:ReturnType<typeof setInterval>|null=null;
  function closeCode(){codeRequests?.abort();codeRequests=null;codeOpen.value=false;codeLoading.value=false;code.value='';codeDeadline.value=0;codeError.value='';}
  function clear(){generation++;requests?.abort();requests=null;closeCode();if(timer)clearInterval(timer);timer=null;snapshot.value=null;loading.value=false;error.value='';navigationError.value='';toolsOpen.value=false;showBalance.value=false;}
  function current(){return visible&&!disposed;}
  async function load(){
    if(!current())return;clear();loading.value=true;const epoch=generation;
    const scope=createUserCenterRequests(()=>current()&&generation===epoch);requests=scope;
    try{
      const menu=parseUserCenterMenu(await scope.request('/menu/user'),scope.owner.uid);
      const stats=parseUserCenterStats(await scope.request('/menu/date'),menu);
      if(!scope.active())return;snapshot.value={menu,stats};clock.value=Date.now();
      timer=setInterval(()=>{
        if(!scope.active()){clear();return;}clock.value=Date.now();
        if(code.value&&clock.value>=codeDeadline.value*1000){code.value='';codeDeadline.value=0;codeError.value='会员码已过期，请重新获取';}
        const pending=snapshot.value?.stats.not_pay_order;
        if(pending&&!Array.isArray(pending)&&pending.stop_time*1000<=clock.value){void load();}
      },1000);
    }catch(e){if(scope.active()){snapshot.value=null;error.value=e instanceof Error?e.message:'个人中心加载失败，请重试';}}
    finally{if(scope.active())loading.value=false;}
  }
  const properties=computed(()=>userCenterProperties(snapshot.value));
  const pendingOrder=computed(()=>{const order=snapshot.value?.stats.not_pay_order;return order&&!Array.isArray(order)&&order.stop_time>clock.value/1000?order:null;});
  const countdown=computed(()=>pendingOrder.value?userCenterCountdown(pendingOrder.value.stop_time,clock.value):'');
  const orderEntries=computed(()=>{const c=snapshot.value?.menu.orderStatusNum;return [
    {name:'待付款',symbol:'¥',count:c?.unpaid_count??0,url:'/pages/order/list?status=0'},
    {name:'待发货',symbol:'包',count:c?.unshipped_count??0,url:'/pages/order/list?status=1'},
    {name:'待收货',symbol:'运',count:c?.received_count??0,url:'/pages/order/list?status=2'},
    {name:'待评价',symbol:'评',count:c?.evaluated_count??0,url:'/pages/order/list?status=3'},
    {name:'售后退款',symbol:'退',count:c?.refund_count??0,url:'/pages/order/refundList'},
  ];});
  function login(){if(!current())return;uni.navigateTo({url:'/pages/auth/login'});}
  function go(url:string,requireAuth=true){
    if(!current()||!snapshot.value)return;
    if(requireAuth&&!auth.isLoggedIn){login();return;}
    const target=userCenterDestination(url);if(!target){navigationError.value='该入口暂不可用，请联系管理员更新';return;}
    if(target.kind==='page'&&target.url.startsWith('/pages/customer-work/')&&snapshot.value.menu.capabilities.work!==true){navigationError.value='当前账号没有手机经营权限';return;}
    navigationError.value='';openUserCenterDestination(target,current);
  }
  function openMenu(group:'menu'|'merMenu'|'poster',index:number){
    const menu=snapshot.value?.menu,block=menu?.diy_data[group];if(!current()||!menu||!block||!block.is_show)return;
    const item=block.list[index];if(!item)return;
    if(group==='merMenu'&&!menu.capabilities.merchant&&!menu.capabilities.writeoff&&!menu.capabilities.deliveryWorkBench&&!menu.capabilities.kefu&&!menu.capabilities.work)return;
    go(item.url,group!=='poster');
  }
  function openProperty(id:number){const item=properties.value.find(x=>x.id===id);if(item)go(item.url);}
  function openOperator(){const m=snapshot.value?.menu,p=m?.operator_profile;if(!m?.capabilities.writeoff||!p?.can_writeoff)return;go(`/pages/operator/writeoff?role=${p.staff_stores.some(s=>!s.identity_conflict)?'staff':'delivery'}`);}
  function openMerchant(target:'statistics'|'unshipped'){const value=snapshot.value;if(!current()||!value?.menu.capabilities.merchant||!value.stats.order.user_order)return;go(target==='statistics'?'/pages/merchant/statistics':'/pages/merchant/orders?status=1');}
  async function logout(){
    if(!current()||!auth.isLoggedIn)return;const scope=createUserCenterRequests(current),owner=scope.owner;
    clear();requests=scope;let serverRevoked=true;try{await scope.request('/logout','GET',{},true);}catch{serverRevoked=false;}
    const same=auth.uid===owner.uid&&auth.token===owner.token&&auth.sessionVersion===owner.version;
    const accepted=scope.active();scope.abort();if(!same||!accepted)return;auth.clear();
    if(!current())return;
    if(serverRevoked)uni.showToast({title:'已退出登录',icon:'success'});
    else uni.showModal({title:'本机已退出',content:'服务器会话撤销未确认，旧会话可能持续到过期。如需立即失效，请修改密码或联系管理员。',showCancel:false});
  }
  async function getMemberCode(){
    if(!current()||!snapshot.value||!auth.isLoggedIn){login();return;}
    codeRequests?.abort();code.value='';codeDeadline.value=0;codeError.value='';codeOpen.value=true;codeLoading.value=true;
    const epoch=generation,scope=createUserCenterRequests(()=>current()&&codeOpen.value&&generation===epoch);codeRequests=scope;
    try{const value=await scope.request<unknown>('/user/rand_code','GET',{},true);
      const row=value as {code?:unknown;actor_uid?:unknown;expires_at?:unknown}|null,now=Math.floor(Date.now()/1000);
      if(!row||row.actor_uid!==scope.owner.uid||typeof row.code!=='string'||!/^\d{6}$/u.test(row.code)||typeof row.expires_at!=='number'||!Number.isSafeInteger(row.expires_at)||row.expires_at<=now||row.expires_at>now+602)throw Error('会员码响应无效，请重新获取');
      if(!scope.active())return;code.value=row.code;codeDeadline.value=row.expires_at;
    }catch(e){if(scope.active())codeError.value=e instanceof Error?e.message:'会员码暂不可用';}
    finally{if(scope.active())codeLoading.value=false;}
  }
  const qrRows=computed(()=>{if(!code.value||codeDeadline.value*1000<=clock.value)return [];const qr=new QRCode(-1,2);qr.addData(code.value);qr.make();const size=qr.getModuleCount();return Array.from({length:size+8},(_,r)=>Array.from({length:size+8},(_,c)=>r>=4&&c>=4&&r<size+4&&c<size+4&&qr.isDark(r-4,c-4)));});
  const shortcuts=computed(()=>{
    const m=snapshot.value?.menu;if(!m)return [];
    const links=[['个人资料','/pages/user/profile'],['修改密码','/pages/user/changePassword'],['手机号管理','/pages/user/phone'],['收货地址','/pages/user/address'],['我的收藏','/pages/user/collect'],['我的足迹','/pages/user/visitHistory'],['我的优惠券','/pages/user/coupon'],['领券中心','/pages/user/couponCenter'],['供应商入驻','/pages/user/supplierApply'],['积分商城','/pages/user/integral'],['每日签到','/pages/user/sign'],['消息中心','/pages/user/message'],['在线客服','/pages/user/kefu'],['意见反馈','/pages/extension/customer_list/feedback'],['商品搜索','/pages/goods/search'],['营销活动','/pages/activity/index'],['幸运抽奖','/pages/activity/lottery']];
    if(m.capabilities.balance)links.push(['余额充值','/pages/user/recharge'],['线下消费收银','/pages/annex/offline_pay/index']);
    if(m.capabilities.member)links.push(['会员等级','/pages/user/level']);if(m.capabilities.paid_member)links.push(['付费会员','/pages/user/vipOpen']);if(m.capabilities.promotion)links.push(['分销中心','/pages/user/finance']);
    if(m.capabilities.invoice)links.push(['我的发票','/pages/user/invoice']);if(m.capabilities.agent_records)links.push(['分销与代理申请记录','/pages/users/agent/record']);
    if(m.capabilities.deliveryWorkBench)links.push(['配送工作台','/pages/delivery/index']);
    if(m.capabilities.kefu&&m.kefu_workbench_url)links.push(['客服工作台',m.kefu_workbench_url]);
    if(m.capabilities.work)links.push(['手机工作台','/pages/customer-work/index'],['商品管理','/pages/customer-work/products'],['用户管理','/pages/customer-work/users']);
    if(m.capabilities.promoter_application)links.push(['申请成为分销员','/pages/users/distributor/apply']);if(m.capabilities.agent_application)links.push(['申请代理商','/pages/users/agent/apply']);
    return links.map(([name,url])=>({name:name!,url:url!}));
  });
  function goAdmin(url:'/pages/behalf/record/index'|'/pages/behalf/user_list/index'){if(current()&&admin.ensureFresh()&&admin.canAssist)uni.navigateTo({url});}
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();if(current())void load();},{flush:'sync'});
  onShow(()=>{visible=true;void load().then(()=>{if(options.autoMemberCode&&current()&&snapshot.value)void getMemberCode();});});onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();});
  return {auth,admin,snapshot,loading,error,navigationError,properties,pendingOrder,countdown,orderEntries,toolsOpen,shortcuts,codeOpen,codeLoading,codeError,code,codeDeadline,clock,qrRows,showBalance,load,login,go,openMenu,openProperty,openOperator,openMerchant,logout,getMemberCode,closeCode,goAdmin};
}
