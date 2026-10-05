import { and,asc,desc,eq,isNull,sql } from 'drizzle-orm';
import { withTx,type Container } from '@/lib/di';
import type { Env } from '@/env';
import { deliveryService,systemStore,systemStoreStaff,user } from '@/models/schema';
import { NotFoundException,ValidateException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { deliveryId,requireFreshDeliveryActor,type DeliveryActor } from './DeliveryPrincipalScope';
import { DeliveryReadService,deliveryActorPictures,normalizeMobileDeliveryPage,type DeliveryActionReader } from './DeliveryReadService';
export { parseLegacyDeliveryTimeRange,normalizeMobileDeliveryPage,type DeliveryTimeRange } from './DeliveryReadService';

/** Legacy output adapters use the same current principal and DAO predicates. */
export class StoreMobileDeliveryService {
  private readonly reader:DeliveryReadService;
  constructor(private readonly container:Container,private readonly env:Partial<Pick<Env,'APP_KEY'>>={},actionReader?:DeliveryActionReader){this.reader=new DeliveryReadService(container,env,actionReader);}
  private async selectedQuery(uid:DeliveryActor|number,query:Record<string,string>):Promise<Record<string,string>>{
    if(query.scope_kind!==undefined||query.delivery_id!==undefined)return query;
    const context=await this.reader.context(uid),storeId=query.store_id===undefined||query.store_id===''?undefined:query.store_id==='0'?0:deliveryId(query.store_id,'门店');
    const choices=storeId!==undefined&&storeId>0?context.data.contexts.filter(row=>row.kind==='store'&&row.store_id===storeId):context.data.contexts;
    if(choices.length!==1)throw new ValidateException('请明确选择配送上下文；重复或多个身份不能使用旧默认入口');
    const selection=choices[0];if(storeId===0&&selection.kind!=='platform')throw new ValidateException('门店配送身份不能使用平台聚合范围');
    const {time,data,...rest}=query;if(time!==undefined&&data!==undefined&&time!==data)throw new ValidateException('配送日期参数冲突');
    return{...rest,scope_kind:selection.kind,store_id:String(selection.store_id),delivery_id:String(selection.delivery_id),scope_key:context.scope_key,...(data!==undefined||time!==undefined?{data:data??time}: {})};
  }
  async info(uid:DeliveryActor|number){const context=await this.reader.context(uid);if(context.data.contexts.length!==1) return{selected:null,contexts:context.data.contexts,conflicts:context.data.conflicts,scope_key:context.scope_key,store_info:context.data.contexts.filter(row=>row.kind==='store').map(row=>({id:row.store_id,name:row.name})),issues:context.issues};const selected=context.data.contexts[0];return{id:selected.delivery_id,uid:context.actor_uid,type:selected.kind==='platform'?0:1,relation_id:selected.store_id,nickname:selected.nickname,user_nickname:selected.nickname,avatar:selected.avatar,phone:selected.phone,status:1,scope_key:context.scope_key,store_info:selected.kind==='store'?[{id:selected.store_id,name:selected.name}]:[],contexts:context.data.contexts,issues:context.issues};}
  async statistics(uid:DeliveryActor|number,query:Record<string,string>){const value=await this.reader.statistics(uid,await this.selectedQuery(uid,query));return{...value.data,scope_key:value.scope_key,consistency_key:value.consistency_key,issues:value.issues};}
  async data(uid:DeliveryActor|number,query:Record<string,string>){const value=await this.reader.daily(uid,await this.selectedQuery(uid,query));return value.data.list.map(row=>({...row,time:row.date.slice(5)}));}
  async orders(uid:DeliveryActor|number,query:Record<string,string>){const value=await this.reader.orders(uid,await this.selectedQuery(uid,query));return{data:{unsend:value.data.unsend,send:value.data.send},list:value.data.list.map(row=>({...row,cart_id:row.cartInfo.map(cart=>cart.cart_id),_info:row.cartInfo.map(cart=>({cart_info:cart}))})),count:value.data.count,page:value.data.page,limit:value.data.limit,scope_key:value.scope_key,consistency_key:value.consistency_key,issues:value.issues};}
  /** Clerk roster is an independent legacy contract, never a delivery grant. */
  async deliveryList(uidValue:DeliveryActor|number,query:Record<string,string>){const uid=deliveryId(typeof uidValue==='number'?uidValue:uidValue.uid,'用户');if(Object.keys(query).some(key=>!['page','limit'].includes(key)))throw new ValidateException('配送员列表参数无效');const {limit,offset}=normalizeMobileDeliveryPage(query.page,query.limit),rows=await withTx(this.container,async db=>{await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(db);if(typeof uidValue!=='number')await requireFreshDeliveryActor(db,uidValue);
    const staff=await db.select({id:systemStoreStaff.id,storeId:systemStoreStaff.storeId}).from(systemStoreStaff).innerJoin(systemStore,eq(systemStore.id,systemStoreStaff.storeId)).innerJoin(user,eq(user.uid,systemStoreStaff.uid)).where(and(eq(systemStoreStaff.uid,uid),eq(systemStoreStaff.status,1),eq(systemStoreStaff.isDel,0),eq(systemStore.isStore,1),eq(systemStore.isShow,1),eq(systemStore.isDel,0),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).orderBy(asc(systemStoreStaff.id)).limit(2);
    if(!staff.length)throw new NotFoundException('店员不存在或所属门店已停用');if(staff.length!==1)throw new ValidateException('店员身份存在重复，请选择明确门店');
    const rows=await db.select({id:deliveryService.id,uid:deliveryService.uid,avatar:deliveryService.avatar,wx_name:deliveryService.nickname,phone:deliveryService.phone,status:deliveryService.status,add_time:deliveryService.addTime,user_nickname:user.nickname}).from(deliveryService).innerJoin(user,eq(user.uid,deliveryService.uid)).where(and(eq(deliveryService.type,1),eq(deliveryService.relationId,staff[0].storeId),eq(deliveryService.status,1),eq(deliveryService.isDel,0),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).orderBy(desc(deliveryService.id)).limit(limit).offset(offset);
    const result=[];for(const {user_nickname,...row}of rows){const [avatar]=await deliveryActorPictures(db,row.uid,[row.avatar]);result.push({...row,avatar,nickname:user_nickname||row.wx_name});}return result;});const images=await renderProductPictures(this.env.APP_KEY,rows.map(row=>row.avatar));return rows.map((row,index)=>({...row,avatar:images[index]}));
  }
}
