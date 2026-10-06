import { isPublicUserCenterDesignValue, isUserCenterPublicImage, USER_CENTER_PROPERTY_OPTIONS } from '../../../common/userCenterDesign';
import { resolveRegisteredPageRoute,TAB_ROUTES } from '@/config/navigation';
import { API_BASE } from '@/utils/request';
import type { UserCenterMenu,UserCenterStats,UserCenterSnapshot,CollectionPage,CollectionProduct,CollectionVideo } from '@/types/userCenter';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const text=(v:unknown,max=256)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const multilineText=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const money=(v:unknown)=>typeof v==='string'&&/^\d{1,12}(?:\.\d{1,2})?$/u.test(v);
const flag=(v:unknown)=>v===true||v===false||v===0||v===1;
const rev=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message);}

/** All previews share one protocol/decoding validator and an actual platform origin. */
export function userCenterMedia(value:unknown):string {
  const safe=isUserCenterPublicImage(value)?value:'';return safe.startsWith('/')?`${API_BASE}${safe}`:safe;
}
/** Exact diagnostic codes remain in the API snapshot; the product UI uses readable text. */
export function userCenterIssueText(issue:string):string {
  if(issue.endsWith('_kefu_entry_unavailable'))return '客服工作台入口暂未开通，请联系管理员';
  if(issue==='user_center_avatar_invalid')return '头像暂不可用，可在个人资料中重新设置';
  if(issue.endsWith('_picture_unavailable'))return '部分图片暂不可用，请稍后重试';
  if(issue.endsWith('_historical_target_partial'))return '部分历史入口暂不可用，请联系管理员更新';
  if(issue.endsWith('_duplicate'))return '个人中心设置存在重复，请联系管理员修复';
  if(issue.includes('_legacy_')||issue.endsWith('_missing'))return '部分历史设置需要更新，已显示当前可用内容';
  return '部分内容暂不可用，请联系管理员确认个人中心设置';
}
export type UserCenterDestination={kind:'page';url:string;tab:boolean}|{kind:'external';url:string}|{kind:'mini';path:string;appId:string};
/** Do not depend on the browser URL global in a native mini-program runtime. */
export function userCenterDestination(value:unknown):UserCenterDestination|null {
  if(typeof value!=='string'||!value||value.length>2048||value!==value.trim())return null;
  const marker=value.indexOf('@APPID=');
  if(marker>=0){
    const appId=value.slice(marker+7),path=value.slice(0,marker);if(value.indexOf('@APPID=',marker+1)>=0||!/^wx[a-f0-9]{16}$/iu.test(appId))return null;
    let layer=path;for(let i=0;i<4;i++){if(!layer||/[\u0000-\u0020\u007f\\#]/u.test(layer)||layer.startsWith('//')||/^[a-z][a-z\d+.-]*:/iu.test(layer)||!/^\/?[a-z0-9_.%/-]+$/iu.test(layer.split('?')[0]!)||layer.split('?')[0]!.split('/').some(x=>x==='.'||x==='..'))return null;if(!/%[a-f0-9]{2}/iu.test(layer))return {kind:'mini',path,appId};try{layer=decodeURIComponent(layer);}catch{return null;}}
    return null;
  }
  if(!isUserCenterPublicImage(value))return null;
  if(/^https?:\/\//iu.test(value))return {kind:'external',url:value};
  if(value.includes('#'))return null;const at=value.indexOf('?'),path=at<0?value:value.slice(0,at),query=at<0?'':value.slice(at+1);
  if(!/^\/pages\/[a-z0-9_/-]+$/iu.test(path))return null;
  const target=resolveRegisteredPageRoute(path,query);return target?{kind:'page',url:target,tab:TAB_ROUTES.has(target.split('?')[0]!)}:null;
}
export function openUserCenterDestination(target:UserCenterDestination,current:()=>boolean):void {
  if(!current())return;const fail=()=>{if(current())uni.showToast({title:'入口暂时无法打开，请重试',icon:'none'});};
  if(target.kind==='page'){if(target.tab)uni.switchTab({url:target.url.split('?')[0]!,fail});else uni.navigateTo({url:target.url,fail});return;}
  if(target.kind==='mini'){
    // #ifdef MP-WEIXIN
    if(typeof uni.navigateToMiniProgram==='function'){uni.navigateToMiniProgram({appId:target.appId,path:target.path,envVersion:'release',fail});return;}
    // #endif
    uni.showToast({title:'当前平台不支持打开外部小程序',icon:'none'});return;
  }
  // #ifdef H5
  if(typeof window!=='undefined'){const opened=window.open(target.url,'_blank','noopener,noreferrer');if(opened)opened.opener=null;else fail();return;}
  // #endif
  // #ifndef H5
  uni.navigateTo({url:`/pages/common/fabWebView?url=${encodeURIComponent(target.url)}`,fail});
  // #endif
}
export function parseUserCenterMenu(value:unknown,uid:number):UserCenterMenu {
  assert(record(value)&&value.actor_uid===uid&&rev(value.consistency_key),'个人中心账号响应不一致，请刷新');
  assert(isPublicUserCenterDesignValue(value.diy_data),'个人中心配置响应无效，请重试');
  const state=value.user_center_design_state,caps=value.capabilities,counts=value.orderStatusNum,profile=value.profile;
  assert(record(state)&&rev(state.revision)&&typeof state.configured==='boolean'&&Array.isArray(state.issues)&&state.issues.every(x=>text(x,500)),'个人中心配置诊断无效，请重试');
  assert(!state.issues.some(issue=>typeof issue==='string'&&issue!=='user_center_avatar_invalid'&&/(?:_duplicate|_invalid|_overflow|_ambiguous)$/u.test(issue)),'个人中心配置异常，请联系管理员修复后刷新');
  assert(record(caps)&&['balance','member','paid_member','promotion','video','merchant','writeoff','deliveryWorkBench','invoice','promoter_application','agent_application','agent_records'].every(k=>typeof caps[k]==='boolean'),'个人中心权限响应无效，请刷新');
  assert(caps.kefu===undefined||typeof caps.kefu==='boolean','客服角色响应无效，请刷新');
  assert(caps.work===undefined||typeof caps.work==='boolean','手机经营角色响应无效，请刷新');
  const kefuUrl=value.kefu_workbench_url;
  assert(kefuUrl===undefined||kefuUrl===''||(uid>0&&caps.kefu===true&&typeof kefuUrl==='string'&&/^https:\/\/[^/?#]+\/mobile_list$/u.test(kefuUrl)&&userCenterDestination(kefuUrl)?.kind==='external'),'客服工作台入口响应无效，请刷新');
  assert(record(counts)&&['order_count','unpaid_count','unshipped_count','received_count','evaluated_count','refund_count'].every(k=>integer(counts[k])),'个人订单统计无效，请重试');
  if(uid>0){
    assert(record(profile)&&profile.uid===uid&&text(profile.nickname,100)&&text(profile.phone,32)&&text(profile.avatar,8192)&&text(profile.level_name,100),'个人资料响应无效，请重试');
    assert(['integral','couponCount','collectProductCount','collectVideoCount','visit_num','service_num','spread_user_count','spread_order_count'].every(k=>integer(profile[k]))&&['now_money','commissionCount','brokerage_price'].every(k=>money(profile[k]))&&flag(profile.is_promoter)&&flag(profile.pay_vip_status),'个人资产响应无效，请重试');
    assert(profile.vip_discount===''||(typeof profile.vip_discount==='string'&&/^\d{1,3}(?:\.\d{1,2})?$/u.test(profile.vip_discount)&&Number(profile.vip_discount)<=100)||(typeof profile.vip_discount==='number'&&Number.isFinite(profile.vip_discount)&&profile.vip_discount>=0&&profile.vip_discount<=100),'会员折扣响应无效');
  }else{
    assert(profile===null||(record(profile)&&profile.uid===0&&!profile.phone&&!profile.avatar&&!profile.nickname),'匿名响应包含无效账号资料');
    assert(Object.values(counts).every(x=>x===0)&&!caps.merchant&&!caps.writeoff&&!caps.deliveryWorkBench&&!caps.promotion&&!caps.promoter_application&&!caps.agent_application&&!caps.agent_records&&!caps.kefu&&!caps.work,'匿名响应包含无效账号权限');
  }
  const operator=value.operator_profile;
  assert(operator===null||(record(operator)&&typeof operator.can_writeoff==='boolean'&&Array.isArray(operator.staff_stores)&&operator.staff_stores.every(s=>record(s)&&integer(s.id)&&s.id>0&&integer(s.store_id)&&s.store_id>0&&text(s.store_name,100)&&typeof s.identity_conflict==='boolean')&&typeof operator.delivery_identity_conflict==='boolean'&&(operator.delivery===null||(record(operator.delivery)&&integer(operator.delivery.id)&&operator.delivery.id>0&&text(operator.delivery.nickname,100)))),'核销角色响应无效，请刷新');
  assert(!caps.writeoff||(record(operator)&&operator.can_writeoff===true&&operator.delivery_identity_conflict===false&&((operator.staff_stores as Array<Record<string,unknown>>).some(s=>s.identity_conflict===false)||operator.delivery!==null)),'核销权限与角色不一致，请刷新');
  assert(integer(value.routine_contact_type)&&[0,1].includes(value.routine_contact_type as number),'客服入口配置无效');
  assert(caps.merchant||caps.writeoff||caps.deliveryWorkBench||caps.kefu||caps.work||value.diy_data.merMenu.list.length===0,'商家入口缺少当前账号授权');
  for(const group of ['poster','menu','merMenu'] as const)for(const item of value.diy_data[group].list){
    const target=userCenterDestination(item.url);
    assert(target?.kind!=='page'||!target.url.startsWith('/pages/customer-work/')||caps.work===true,'手机经营入口缺少当前账号授权');
  }
  return value as unknown as UserCenterMenu;
}
export function parseUserCenterStats(value:unknown,menu:UserCenterMenu):UserCenterStats {
  assert(record(value)&&value.actor_uid===menu.actor_uid&&value.design_revision===menu.user_center_design_state.revision&&value.consistency_key===menu.consistency_key,'个人中心配置或账号权限已变化，请刷新后查看');
  const c=value.commission,o=value.order,n=value.not_pay_order;
  assert((Array.isArray(c)&&c.length===0)||(record(c)&&menu.capabilities.promotion&&money(c.brokerage_price)&&integer(c.number)&&integer(c.order_num)),'推广统计响应无效');
  assert(record(o)&&typeof o.user_order==='boolean'&&(!o.user_order||(menu.capabilities.merchant&&money(o.price)&&integer(o.num)&&integer(o.consignment))),'商家统计缺少当前账号授权');
  assert(n===null||(Array.isArray(n)&&n.length===0)||(record(n)&&menu.actor_uid>0&&integer(n.id)&&n.id>0&&text(n.order_id,64)&&/^[A-Za-z0-9_-]+$/u.test(n.order_id as string)&&money(n.pay_price)&&text(n.img,8192)&&text(n.store_name,256)&&integer(n.stop_time)),'待付款订单响应无效');
  return value as unknown as UserCenterStats;
}
export function userCenterProperties(snapshot:UserCenterSnapshot|null){
  if(!snapshot?.menu.profile||snapshot.menu.actor_uid<1)return [];
  const {diy_data,profile,capabilities}=snapshot.menu;
  if(diy_data.member.style===3||diy_data.member.style===4)return [];
  return USER_CENTER_PROPERTY_OPTIONS.filter(item=>diy_data.member.property.includes(item.id)&&(item.id!==0||capabilities.balance)&&(item.id!==4||capabilities.video)&&(item.id<6||capabilities.promotion&&!!profile.is_promoter))
    .map(item=>({...item,value:String(profile[item.field as keyof typeof profile]),target:userCenterDestination(item.url)}));
}
export function collectionKind(value:unknown):'product'|'video'{if(value===undefined||value==='0'||value===0)return 'product';if(value==='1'||value===1)return 'video';throw Error('收藏分类参数无效');}
export function parseCollectionProducts(value:unknown):CollectionPage<CollectionProduct>{
  assert(record(value)&&Array.isArray(value.list)&&integer(value.count),'商品收藏响应无效');
  const ids=new Set<number>();assert(value.list.every(x=>record(x)&&integer(x.id)&&x.id>0&&!ids.has(x.id)&&(ids.add(x.id),true)&&text(x.store_name,256)&&text(x.image,8192)&&money(x.price)),'商品收藏记录无效');
  return value as unknown as CollectionPage<CollectionProduct>;
}
export function parseCollectionVideos(value:unknown,uid:number):CollectionPage<CollectionVideo>{
  assert(record(value)&&value.actor_uid===uid&&Array.isArray(value.list)&&integer(value.count),'视频收藏账号响应无效');
  const ids=new Set<number>();assert(value.list.every(x=>record(x)&&integer(x.id)&&x.id>0&&!ids.has(x.id)&&(ids.add(x.id),true)&&x.video_id===x.id&&text(x.image,8192)&&text(x.site_name,100)&&text(x.wap_login_logo,8192)&&multilineText(x.desc,10000)&&text(x.video_url,8192)&&integer(x.like_num)&&typeof x.available==='boolean'&&[0,1].includes(x.is_fail as number)&&(!x.available||!x.is_fail&&!!userCenterMedia(x.video_url))),'视频收藏记录无效');
  return value as unknown as CollectionPage<CollectionVideo>;
}
export function userCenterCountdown(deadline:number,now:number):string {
  const seconds=Math.max(0,deadline-Math.floor(now/1000));if(!seconds)return '订单已到期，请刷新';
  const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
