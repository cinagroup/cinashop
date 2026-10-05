import { and,eq,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx,type Container } from '@/lib/di';
import { systemAttachment,systemDise,systemGroup,systemGroupData,systemLog } from '@/models/schema';
import { NotFoundException,ValidateException } from '@/utils/errors';
import { lockDiseCatalogForMutation,themeDeadlines,themeHash } from '@/services/content/ThemeReadService';
import { USER_CENTER_GROUP_NAMES,USER_CENTER_MAX_BYTES,UserCenterDesignReadService,userCenterDesignCatalog,projectUserCenterDesign,type UserCenterListModule } from '@/services/content/UserCenterDesignReadService';
import { fabImage,fabLink } from './AdminFabSettingsInput';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { userCenterDesignInput,userCenterDesignOperationId,UserCenterDesignRejected,UserCenterDesignStaleVersion } from './AdminUserCenterDesignInput';
import type { UserCenterDesignReceipt } from '../../../../view/common/userCenterDesign';
export const USER_CENTER_DESIGN_LOCK_NAMESPACE=731_723;
const JOURNAL_TYPE='user_center_design',receiptPath=(id:string)=>`/config/user-center-design/receipt/${id}`;
function parseReceipt(value:string,operationId:string):UserCenterDesignReceipt|null{const match=/^update;id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(value);return match&&Number(match[1])<=2147483647?{operation:'update',id:Number(match[1]),operationId,payloadHash:match[2]}:null;}
function actorId(actor:{id:number}){if(!actor||!Number.isSafeInteger(actor.id)||actor.id<=0||actor.id>2147483647)throw new ValidateException('管理员身份无效');return actor.id;}
export class AdminUserCenterDesignService{
  constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
  read(){return new UserCenterDesignReadService(this.container,this.env).read();}
  receipt(value:unknown,actor:{id:number}){const operationId=userCenterDesignOperationId(value),id=actorId(actor);return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
    const rows=await tx.select({action:systemLog.action}).from(systemLog).where(and(eq(systemLog.type,JOURNAL_TYPE),eq(systemLog.path,receiptPath(operationId)),eq(systemLog.adminId,id))).limit(2);
    if(!rows.length)throw new NotFoundException('个人中心设计回执不存在');const receipt=rows.length===1?parseReceipt(rows[0].action,operationId):null;if(!receipt)throw new ValidateException('个人中心设计回执异常，结果未知');return receipt;});}
  async save(input:unknown,actor:{id:number}){const id=actorId(actor),{operationId,canonical}=userCenterDesignInput(input),payloadHash=await themeHash(canonical);
    return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);await themeDeadlines(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(${USER_CENTER_DESIGN_LOCK_NAMESPACE},0)`);
      const journals=await tx.select({action:systemLog.action,actor:systemLog.adminId}).from(systemLog).where(and(eq(systemLog.type,JOURNAL_TYPE),eq(systemLog.path,receiptPath(operationId)))).limit(2);
      if(journals.length){const receipt=journals.length===1?parseReceipt(journals[0].action,operationId):null;if(!receipt||journals[0].actor!==id||receipt.payloadHash!==payloadHash)throw new ValidateException('操作标识已用于其他个人中心请求');return receipt;}
      // Ordered locks and fixed-name INSERTs serialize cooperating runtime APIs.
      // High-privilege raw group-alias imports require the same maintenance protocol.
      await lockDiseCatalogForMutation(tx);
      await tx.select({id:systemGroup.id}).from(systemGroup).where(sql`lower(btrim(${systemGroup.configName})) IN ('routine_my_banner','routine_my_menus')`).orderBy(systemGroup.id).for('share');
      await tx.execute(sql`LOCK TABLE ${systemGroupData} IN SHARE ROW EXCLUSIVE MODE`);
      const catalog=await userCenterDesignCatalog(tx);if(catalog.revision!==canonical.revision)throw new UserCenterDesignStaleVersion(operationId,payloadHash);
      const projected=await projectUserCenterDesign(tx,catalog);if(!projected.snapshot.editable||!projected.snapshot.value)throw new UserCenterDesignRejected(operationId,payloadHash);
      const reject=(message:string)=>{throw new UserCenterDesignRejected(operationId,payloadHash,message);};
      const seen=new Set<string>(),references:string[]=[];
      for(const module of ['poster','menu','merMenu'] as const){
        const items=canonical.value[module].list;
        if(module==='merMenu'){
          const old=projected.snapshot.value.merMenu.list;
          if(items.length!==old.length||items.some(item=>item.sourceId===null)||new Set(items.map(item=>item.sourceId)).size!==old.length||old.some(item=>!items.some(next=>next.sourceId===item.sourceId&&next.url===item.url&&'type' in next&&next.type===2)))reject('商家管理项目只能排序、改名和更换图片，身份与目标不能变更');
        }
        for(const item of items){
          const prior=item.sourceId?projected.sources.get(item.sourceId):undefined;
          if(item.sourceId&&(!prior||prior.module!==module||seen.has(item.sourceId)))reject('个人中心项目来源不匹配或重复');if(item.sourceId)seen.add(item.sourceId);
          try{fabImage(item.pic);}catch{reject('个人中心图片须为稳定有效地址');}
          try{fabLink(item.url);}catch{if(!prior||prior.original.url!==item.url)reject('新跳转目标须有可执行页面');}
          references.push(item.pic);
        }
      }
      const ids=[...new Set(references.map(parseCanonicalAttachmentId).filter((value):value is number=>value!==null))].sort((a,b)=>a-b);
      for(const assetId of ids)await tx.select({id:systemAttachment.attId}).from(systemAttachment).where(eq(systemAttachment.attId,assetId)).for('share');
      const available=await publicProductPictures(tx,references.map(image=>({image,type:0,relationId:0})));if(references.some((image,index)=>image!==available[index]))reject('个人中心素材已失效或不属于平台');
      const now=Math.floor(Date.now()/1000),value:Record<string,unknown>={...(projected.source??{})};
      for(const module of ['member','order','orderStatic','poster','menu','merMenu'] as const){
        const prior=projected.source?.[module],base=prior&&typeof prior==='object'&&!Array.isArray(prior)?prior as Record<string,unknown>:{};
        const current=canonical.value[module];value[module]={...base,...current};
        if('list' in current)(value[module] as Record<string,unknown>).list=current.list.map(item=>{const source=item.sourceId?projected.sources.get(item.sourceId):null;const{sourceId,...fields}=item;return{...(source?.original??{}),...fields};});
      }
      const serialized=JSON.stringify(value);if(new TextEncoder().encode(serialized).byteLength>USER_CENTER_MAX_BYTES)reject('个人中心配置超过安全容量');
      // Preserve disabled group rows and all safe unknown wrappers on retained items.
      // Removed active rows become inactive, retaining their original opaque
      // history; a visual edit never silently erases an imported group row.
      for(const name of USER_CENTER_GROUP_NAMES){
        let group:{id:number}|undefined=catalog.groups.find(group=>group.configName===name);
        if(!group){[group]=await tx.insert(systemGroup).values({name:name==='routine_my_banner'?'个人中心广告':'个人中心菜单',info:'个人中心六模块配置',configName:name,fields:JSON.stringify([{title:'name',name:'名称',type:'input'},{title:'pic',name:'图片',type:'upload'},{title:'url',name:'链接',type:'input'},...(name==='routine_my_menus'?[{title:'type',name:'类型',type:'radio'}]:[])])}).returning();}
        const modules:UserCenterListModule[]=name==='routine_my_banner'?['poster']:['menu','merMenu'];
        const items=modules.flatMap(module=>canonical.value[module].list.map(item=>({item,module}))),retained=new Set<number>();
        for(let index=0;index<items.length;index++){
          const{item}=items[index],prior=item.sourceId?projected.sources.get(item.sourceId):undefined,original=prior?.groupOriginal??{},next={...original};
          for(const[key,field]of Object.entries(item)){if(key==='sourceId')continue;const old=original[key];next[key]=old&&typeof old==='object'&&!Array.isArray(old)?{...old as Record<string,unknown>,value:field}:{type:key==='pic'?'upload':key==='type'?'radio':'input',value:field};}
          const record={gid:group!.id,value:JSON.stringify(next),sort:items.length-index,status:1};
          if(prior?.groupRow?.gid===group!.id){retained.add(prior.groupRow.id);const{gid,...updates}=record;await tx.update(systemGroupData).set(updates).where(eq(systemGroupData.id,prior.groupRow.id));}
          else await tx.insert(systemGroupData).values({...record,addTime:now});
        }
        for(const old of catalog.data.filter(row=>row.gid===group!.id&&row.status===1))if(!retained.has(old.id))await tx.update(systemGroupData).set({status:0}).where(and(eq(systemGroupData.id,old.id),eq(systemGroupData.gid,group!.id)));
      }
      let resultId:number;const row=catalog.member[0],version=crypto.randomUUID();
      if(row){resultId=row.id;await tx.update(systemDise).set({value:serialized,version,updateTime:sql<number>`GREATEST(${systemDise.updateTime}+1,${now})`}).where(eq(systemDise.id,row.id));}
      else{const[created]=await tx.insert(systemDise).values({templateName:'member',type:3,name:'个人中心',title:'个人中心六模块',value:serialized,status:0,isShow:0,isDel:0,isDiy:1,version,addTime:now,updateTime:now}).returning({id:systemDise.id});resultId=created.id;}
      await tx.insert(systemLog).values({adminId:id,type:JOURNAL_TYPE,path:receiptPath(operationId),page:JOURNAL_TYPE,method:'POST',action:`update;id=${resultId};payload=${payloadHash}`,addTime:now});
      return{operation:'update' as const,id:resultId,operationId,payloadHash};
    });
  }
}
