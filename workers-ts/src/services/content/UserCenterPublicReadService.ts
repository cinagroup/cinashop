import { and,asc,desc,eq,isNull,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx,createContainerFromDb,type Container } from '@/lib/di';
import { systemAttachment,systemUserLevel,user,storeOrder,storeOrderCartInfo,storeService } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { normalizeConfigScalar } from '@/utils/config';
import { themeDeadlines,themeHash } from './ThemeReadService';
import { readUserCenterDesignSnapshot,renderUserCenterDesignSnapshot } from './UserCenterDesignReadService';
import { fabImage,fabLink } from '@/services/admin/AdminFabSettingsInput';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { publicProductPictures,renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { StoreOrderWriteoffService } from '@/services/order/StoreOrderWriteoffService';
import { unshippedOrderStatusPredicate } from '@/services/order/OrderReadStatusPredicate';
import { readStoreManagerIdentities } from '@/services/store/StoreManagerScope';
import { readDeliveryPrincipal } from '@/services/store/DeliveryPrincipalScope';
import { readCustomerWorkScope } from '@/services/customer-work/CustomerWorkScope';
import { kefuWorkBenchOrigin,isLegacyKefuWorkBenchTarget,legacyKefuWorkBenchTarget,isConfiguredKefuWorkBenchTarget } from '@/services/kefu/KefuWorkBenchEntry';
import { UserFinanceReadService } from '@/services/user/UserFinanceReadService';
import { orderCancelHours } from '@/services/payment/OrderPaymentPolicy';
import { userUnreadMessageCount } from '@/services/message/UserMessageVisibility';
import { cloneUserCenterDesign,publicUserCenterDesignValue,type UserCenterDesignSnapshot } from '../../../../view/common/userCenterDesign';
const integer=(value:unknown)=>Number.isSafeInteger(Number(value))?Number(value):0;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const CONFIG_KEYS=['member_func_status','member_card_status','brokerage_func_status','store_brokerage_apply','balance_func_status','division_open','division_apply_open','routine_contact_type','level_activate_status','video_func_status','invoice_func_status','order_cancel_time','order_activity_time','order_seckill_time','order_bargain_time','order_pink_time','rebate_points_orders_time'];
export class UserCenterPublicReadService{
  constructor(private readonly container:Container,private readonly env:Env){}
  private async snapshot(uid:number){
    if(!Number.isSafeInteger(uid)||uid<0||uid>2147483647)throw new ValidateException('用户身份无效');
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);const scoped=createContainerFromDb(tx),now=Math.floor(Date.now()/1000);
      const accounts=uid?await tx.select({uid:user.uid,nickname:user.nickname,phone:user.phone,avatar:user.avatar,nowMoney:user.nowMoney,integral:user.integral,brokeragePrice:user.brokeragePrice,isPromoter:user.isPromoter,spreadOpen:user.spreadOpen,level:user.level,levelStatus:user.levelStatus,isEverLevel:user.isEverLevel,isMoneyLevel:user.isMoneyLevel,overdueTime:user.overdueTime,divisionType:user.divisionType,divisionStatus:user.divisionStatus,divisionEndTime:user.divisionEndTime})
        .from(user).where(and(eq(user.uid,uid),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).limit(1):[];
      const account=accounts[0];if(uid&&!account)throw new ValidateException('请重新登录');
      const settings=await scoped.systemConfigDao.getValuesWithPresence(CONFIG_KEYS),configs=Object.fromEntries(Object.entries(settings).map(([key,item])=>[key,normalizeConfigScalar(item.value)]));
      const enabled=(key:string,fallback=false)=>settings[key]?.exists?configs[key]==='1'||configs[key]==='true':fallback;
      const divisionValid=!account||account.divisionType===0||account.divisionStatus===1&&account.divisionEndTime>now;
      const operator=uid?await new StoreOrderWriteoffService(scoped,this.env).operatorProfile(uid):{can_writeoff:false,staff_stores:[],delivery:null,delivery_identity_conflict:false};
      const manager=uid?await readStoreManagerIdentities(tx,uid):null,stores=manager?.stores.map(item=>item.store_id)??[];
      const deliveryPrincipal=uid?await readDeliveryPrincipal(tx,uid):null;
      const workScope=uid?await readCustomerWorkScope(tx,uid,false):null;
      const kefuIdentities=uid?await tx.select({id:storeService.id}).from(storeService).where(and(eq(storeService.uid,uid),eq(storeService.status,1),eq(storeService.accountStatus,1),eq(storeService.isDel,0))).limit(1):[];
      const kefuRole=kefuIdentities.length>0,kefuOrigin=kefuWorkBenchOrigin(this.env),kefuWorkbenchUrl=kefuRole&&kefuOrigin?`${kefuOrigin}/mobile_list`:'';
      const writeoffStores=operator.staff_stores.filter(item=>!item.identity_conflict).map(item=>item.store_id);
      const capabilities={balance:enabled('balance_func_status'),member:enabled('member_func_status'),paid_member:enabled('member_card_status'),promotion:!!account&&enabled('brokerage_func_status')&&account.isPromoter===1&&account.spreadOpen===1&&divisionValid,video:enabled('video_func_status',true),invoice:enabled('invoice_func_status'),kefu:kefuRole,work:!!workScope,merchant:stores.length>0,deliveryWorkBench:!!deliveryPrincipal?.contexts.length,writeoff:operator.can_writeoff&&!operator.delivery_identity_conflict&&(writeoffStores.length>0||operator.delivery!==null),promoter_application:!!account&&account.isPromoter!==1&&enabled('brokerage_func_status')&&enabled('store_brokerage_apply'),agent_application:!!account&&account.isPromoter===1&&enabled('brokerage_func_status')&&enabled('division_open')&&enabled('division_apply_open')&&account.divisionType===0,agent_records:!!account};
      const design=await readUserCenterDesignSnapshot(tx);
      // Malformed/duplicate configured templates stay diagnosed and hidden. Only
      // genuinely missing configuration receives PHP's documented defaults.
      const snapshot:UserCenterDesignSnapshot=design.snapshot.value?design.snapshot:{...design.snapshot,value:cloneUserCenterDesign(),imagePreviews:{poster:[],menu:[],merMenu:[]}};
      const value=snapshot.value!,issues=[...snapshot.issues];
      if(!design.snapshot.value){value.member.property=[];value.poster.is_show=0;value.menu.is_show=0;value.merMenu.is_show=0;value.orderStatic.is_show=0;}
      value.member.property=value.member.property.filter(id=>id===0?capabilities.balance:id===4?capabilities.video:id>=6?capabilities.promotion:true);
      for(const module of ['poster','menu','merMenu'] as const){const kept=value[module].list.flatMap((item,index)=>{
        const legacyKefu=isLegacyKefuWorkBenchTarget(item.url);
        const kefuTarget=legacyKefu?legacyKefuWorkBenchTarget(item.url,kefuOrigin):'';
        if(legacyKefu&&!kefuRole)return[];
        if(legacyKefu&&!kefuTarget){issues.push(`user_center_${module}_kefu_entry_unavailable`);return[];}
        const knownKefuOrigins=[this.env.PUBLIC_KEFU_ORIGIN??'',...(this.env.KEFU_AUTH_ALLOWED_ORIGINS??'').split(',').map(origin=>origin.trim())];
        if(knownKefuOrigins.some(origin=>isConfiguredKefuWorkBenchTarget(item.url,origin))){
          if(!kefuRole)return[];
          if(!kefuOrigin){issues.push(`user_center_${module}_kefu_entry_unavailable`);return[];}
        }
        let target;try{target=fabLink(kefuTarget||item.url);}catch{issues.push(`user_center_${module}_historical_target_partial`);return[];}
        const path=target.target.split('?',1)[0],original=item.url.split('?',1)[0];
        if((path==='/pages/user/balanceLogs'||path==='/pages/user/recharge')&&!capabilities.balance)return[];
        if((path==='/pages/user/finance'||path==='/pages/user/spread')&&!capabilities.promotion)return[];
        if((original==='/pages/users/user_vip/index'||path==='/pages/user/level')&&!capabilities.member)return[];
        if(path==='/pages/user/vipOpen'&&!capabilities.member)return[];
        if(path==='/pages/annex/vip_paid/index'&&!capabilities.paid_member)return[];
        if(path==='/pages/operator/writeoff'&&!capabilities.writeoff)return[];
        if(path.startsWith('/pages/merchant/')&&!capabilities.merchant)return[];
        if(path.startsWith('/pages/customer-work/')&&!capabilities.work)return[];
        if(path.startsWith('/pages/delivery/')&&!capabilities.deliveryWorkBench)return[];
        if(path==='/pages/user/invoice'&&!capabilities.invoice)return[];
        // Authorization follows the actual target across every module. The old
        // item type and its placement do not grant a staff or manager capability.
        if(path==='/pages/users/agent/record'&&!capabilities.agent_records)return[];
        if(original==='/pages/users/agent/apply'&&!capabilities.agent_application)return[];
        if(original==='/pages/users/distributor/apply'&&!capabilities.promoter_application)return[];
        const pic=snapshot.imagePreviews[module][index];if(!pic){issues.push(`user_center_${module}_picture_unavailable`);return[];}
        const next={...item};if(kefuTarget)next.url=kefuTarget;if(path.startsWith('/pages/customer-work/'))next.url=target.target;if(original==='/pages/users/user_vip/index'&&enabled('level_activate_status')&&account?.levelStatus===0)next.url='/pages/annex/vip_grade_active/index';
        return[{item:next,pic}];});value[module].list=kept.map(entry=>entry.item) as typeof value[typeof module]['list'];snapshot.imagePreviews[module]=kept.map(entry=>entry.pic);}
      snapshot.issues=[...new Set(issues)];
      const profile:Record<string,unknown>=account?{uid,nickname:account.nickname,phone:account.phone,avatar:'',now_money:capabilities.balance?account.nowMoney:'0.00',integral:account.integral,brokerage_price:capabilities.promotion?account.brokeragePrice:'0.00',is_promoter:account.isPromoter,level_name:'',vip_discount:'',pay_vip_status:capabilities.paid_member&&(account.isEverLevel===1||account.isMoneyLevel===1&&account.overdueTime>now),commissionCount:'0.00'}:{};
      let avatar='';if(account){try{avatar=account.avatar?fabImage(account.avatar):'';}catch{snapshot.issues.push('user_center_avatar_invalid');}
        const id=parseCanonicalAttachmentId(avatar);if(id){const rows=await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,id)).limit(1),asset=rows[0];
          const isOwner=asset?.type===3&&asset.relationId===uid&&asset.moduleType===3&&asset.fileType===1&&asset.imageType===8&&asset.attDir===avatar&&asset.name.startsWith(`attachments/user/${uid}/`)&&!/[\\\u0000-\u001f\u007f]/u.test(asset.name)&&!asset.name.split('/').some(piece=>piece==='.'||piece==='..')&&/\.(?:jpe?g|png|gif|webp)$/i.test(asset.name)&&/^image\/(?:jpeg|jpg|png|gif|webp)$/i.test(asset.attType.trim());
          if(!isOwner)avatar=(await publicProductPictures(tx,[{image:avatar,type:0,relationId:0}]))[0];}
      }
      let counters:Record<string,unknown>={order_count:0,unpaid_count:0,unshipped_count:0,received_count:0,evaluated_count:0,refund_count:0},commission:Record<string,unknown>|[]=[],order:Record<string,unknown>={user_order:false},notPay:Record<string,unknown>|null=null;
      if(account){
        const [stats]=await tx.execute<Record<string,unknown>>(sql`SELECT
          (SELECT count(*)::int FROM store_coupon_user WHERE uid=${uid} AND status=0 AND is_fail=0 AND (end_time IS NULL OR end_time>=CURRENT_TIMESTAMP)) AS "couponCount",
          (SELECT count(*)::int FROM user_relation WHERE uid=${uid} AND type='collect' AND category='product') AS "collectProductCount",
          (SELECT count(*)::int FROM user_relation WHERE uid=${uid} AND type='collect' AND category='video') AS "collectVideoCount",
          (SELECT count(DISTINCT product_id)::int FROM store_product_log WHERE uid=${uid} AND type='visit' AND delete_time IS NULL) AS visit_num,
          (SELECT count(*)::int FROM "user" WHERE spread_uid=${uid} AND is_del=0 AND delete_time IS NULL) AS spread_user_count,
          (SELECT count(*)::int FROM store_order WHERE spread_uid=${uid} AND paid=1 AND type=0 AND is_del=0 AND is_system_del=0 AND refund_status IN(0,3)) AS spread_order_count,
          ${userUnreadMessageCount(uid)} AS service_num`);
        Object.assign(profile,stats,{collectVideoCount:capabilities.video?integer(stats.collectVideoCount):0,spread_user_count:capabilities.promotion?integer(stats.spread_user_count):0,spread_order_count:capabilities.promotion?integer(stats.spread_order_count):0});
        const [counts]=await tx.execute<Record<string,unknown>>(sql`SELECT count(*)::int AS order_count,count(*) FILTER(WHERE paid=0 AND status=0 AND refund_status=0)::int AS unpaid_count,
          count(*) FILTER(WHERE ${unshippedOrderStatusPredicate()})::int AS unshipped_count,
          count(*) FILTER(WHERE paid=1 AND ((status IN(1,5) AND shipping_type=1) OR (status IN(0,5) AND shipping_type=2)) AND refund_status IN(0,3))::int AS received_count,
          count(*) FILTER(WHERE paid=1 AND status=2 AND refund_status IN(0,3))::int AS evaluated_count,
          (SELECT count(*)::int FROM store_order_refund r JOIN store_order original ON original.id=r.store_order_id AND original.uid=r.uid WHERE r.uid=${uid} AND r.is_cancel=0 AND r.is_del=0 AND r.refund_type IN(0,1,2,3,4,5,6)) AS refund_count
          FROM store_order WHERE uid=${uid} AND is_del=0 AND is_system_del=0 AND pid>=0`);counters=counts;
        if(account.level>0&&capabilities.member){const [level]=await tx.select({name:systemUserLevel.name,discount:systemUserLevel.discount}).from(systemUserLevel).where(and(eq(systemUserLevel.id,account.level),eq(systemUserLevel.isShow,1),eq(systemUserLevel.isDel,0))).limit(1);if(level){profile.level_name=level.name;profile.vip_discount=level.discount;}}
        if(capabilities.promotion){const financial=await UserFinanceReadService.commissionSummary(scoped,uid,now);profile.commissionCount=financial.withdrawable;commission={brokerage_price:account.brokeragePrice,number:profile.spread_user_count,order_num:profile.spread_order_count};}
        if(stores.length){const [merchant]=await tx.execute<Record<string,unknown>>(sql`SELECT COALESCE(sum(pay_price),0)::numeric(14,2)::text AS price,count(*)::int AS num,count(*) FILTER(WHERE ${unshippedOrderStatusPredicate()})::int AS consignment FROM store_order WHERE store_id IN(${sql.join(stores.map(id=>sql`${id}`),sql`,`)}) AND pid IN(0,-1) AND paid=1 AND is_del=0 AND is_system_del=0 AND refund_status IN(0,3)`);order={user_order:true,...merchant};}
        const [unpaid]=await tx.select({id:storeOrder.id,orderId:storeOrder.orderId,payPrice:storeOrder.payPrice,payType:storeOrder.payType,type:storeOrder.type,addTime:storeOrder.addTime}).from(storeOrder).where(and(eq(storeOrder.uid,uid),eq(storeOrder.pid,0),eq(storeOrder.paid,0),eq(storeOrder.status,0),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).orderBy(desc(storeOrder.addTime),desc(storeOrder.id)).limit(1);
        if(unpaid){const hours=orderCancelHours(unpaid.type,configs),stopTime=hours>0?unpaid.addTime+Math.ceil(hours*3600):0;if(stopTime>now){const [cart]=await tx.select({value:storeOrderCartInfo.cartInfo}).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,unpaid.id)).orderBy(asc(storeOrderCartInfo.id)).limit(1);let info:Record<string,unknown>={};try{info=object(object(JSON.parse(cart?.value??'{}')).productInfo);}catch{}
          const [image]=await publicProductPictures(tx,[{image:info.image??'',type:0,relationId:0}]);notPay={id:unpaid.id,order_id:unpaid.orderId,pay_price:unpaid.payPrice,pay_type:unpaid.payType,type:unpaid.type,add_time:unpaid.addTime,img:image,store_name:typeof info.store_name==='string'?info.store_name.slice(0,256):'',stop_time:stopTime};}}
      }
      const contact=integer(configs.routine_contact_type);
      // Both HTTP reads bind the same pre-signing, observable and authorization
      // facts. Auth bookkeeping, current clock, xmin and expiring signatures are
      // deliberately absent: they are not user-center output authority.
      const consistencyKey=await themeHash({actor_uid:uid,snapshot,profile,avatar,capabilities,operator,managerStores:stores,deliveryPrincipal,workScope,kefuWorkbenchUrl,counters,commission,order,notPay,contact,configs});
      return{uid,snapshot,profile,avatar,capabilities,operator,counters,commission,order,notPay,contact,consistencyKey,kefuWorkbenchUrl,workScope};
    });
    // Read the current qualification again after the repeatable-read snapshot;
    // a concurrent revocation must not publish a stale global work entry.
    const currentWork=uid?await readCustomerWorkScope(this.container.db,uid,false):null;
    if(currentWork?.scope_key!==result.workScope?.scope_key)throw new ValidateException('手机经营权限已变化，请刷新');
    return result;
  }
  async menu(uid:number){const read=await this.snapshot(uid),snapshot=await renderUserCenterDesignSnapshot(this.env,read.snapshot),[avatar]=await renderProductPictures(this.env.APP_KEY,[read.avatar]);read.profile.avatar=avatar;const value=publicUserCenterDesignValue(snapshot.value!,snapshot.imagePreviews);
    return{actor_uid:uid,consistency_key:read.consistencyKey,profile:uid?read.profile:null,capabilities:read.capabilities,kefu_workbench_url:read.kefuWorkbenchUrl,operator_profile:read.operator,orderStatusNum:read.counters,user_center_design_state:{revision:snapshot.revision,configured:snapshot.configured,issues:snapshot.issues},diy_data:value,routine_my_menus:[...value.menu.list,...value.merMenu.list],routine_my_banner:value.poster.list,routine_spread_banner:[],routine_contact_type:read.contact};}
  async data(uid:number){const read=await this.snapshot(uid);if(read.notPay){const [image]=await renderProductPictures(this.env.APP_KEY,[String(read.notPay.img??'')]);read.notPay.img=image;}return{actor_uid:uid,consistency_key:read.consistencyKey,design_revision:read.snapshot.revision,commission:read.commission,order:read.order,not_pay_order:read.notPay};}
}
