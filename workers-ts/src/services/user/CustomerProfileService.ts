import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { systemConfig,user } from '@/models/schema';
import type { AuthUser,Env } from '@/env';
import { ApiException,AuthException,ValidateException } from '@/utils/errors';
import { levelActivationHash,parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { normalizeLevelActivationFields } from './UserLevelService';
import { profileBirthdayParse,profileBirthdayText } from './UserProfileDate';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { profileAvatarIdentity,profileAvatarRead,profileAvatarWrite,renderProfileAvatar } from './UserProfileMediaPolicy';
import { parseProfileInput,profileObject,profileText,type ProfileEditInput } from './UserProfileInput';

export type ProfileFormat='text'|'num'|'date'|'radio'|'id'|'mail'|'phone'|'address';
export interface ProfileField {info:string;tip:string;format:ProfileFormat;label:string;param:string;single:'';singlearr:string[];required:0|1;use:0|1;user_show:0|1;sort:number;value:string}
type Account=typeof user.$inferSelect;
type Winner=Pick<typeof systemConfig.$inferSelect,'id'|'sort'|'value'>;
const formats:Record<ProfileFormat,string>={text:'文本',num:'数字',date:'日期',radio:'单选项',id:'身份证',mail:'邮箱',phone:'手机号',address:'地址'};
const mappings:Record<string,ProfileFormat>={real_name:'text',sex:'radio',birthday:'date',card_id:'id',address:'address',mark:'text'};
function bit(value:unknown):0|1{if(value===undefined||value===0||value==='0'||value===false)return 0;if(value===1||value==='1'||value===true)return 1;throw new ValidateException('资料模板开关无效');}
function fields(winner:Winner|undefined):ProfileField[]{
  const raw=winner?.value.trim()??'';
  if(!raw||['0','false','null','""'].includes(raw))return [];
  const parsed=parseLevelActivationJson(raw);
  if(!Array.isArray(parsed)||parsed.length>64)throw new ValidateException('资料模板须为至多64项数组');
  const definitions=parsed.map(value=>{
    const row=profileObject(value),format=profileText(row.format,16,'资料格式',false) as ProfileFormat;
    if(!Object.hasOwn(formats,format))throw new ValidateException('资料格式不受支持');
    const info=profileText(row.info,80,'资料名称',false),param=row.param===undefined?'':profileText(row.param,32,'资料映射');
    if(param&&mappings[param]!==format)throw new ValidateException('资料映射不受支持');
    const choices=row.singlearr??[];
    if(!Array.isArray(choices)||choices.length>32)throw new ValidateException('单选资料选项无效');
    const singlearr=choices.map(v=>profileText(v,80,'单选项',false));
    if(format==='radio'&&(singlearr.length<2||new Set(singlearr).size!==singlearr.length)
      ||format!=='radio'&&singlearr.length!==0)throw new ValidateException('单选资料选项无效');
    if(param==='sex'&&JSON.stringify(singlearr)!==JSON.stringify(['男','女','保密']))throw new ValidateException('性别选项须按男、女、保密排列');
    const sort=row.sort??0;if(typeof sort!=='number'||!Number.isSafeInteger(sort)||sort<0||sort>2147483647)throw new ValidateException('资料排序无效');
    return{info,tip:row.tip===undefined?'':profileText(row.tip,160,'资料提示'),format,label:row.label===undefined?formats[format]:profileText(row.label,80,'资料标签'),param,single:'' as const,singlearr,required:bit(row.required),use:bit(row.use),user_show:bit(row.user_show),sort,value:''};
  });
  if(new Set(definitions.map(v=>v.info)).size!==definitions.length||new Set(definitions.filter(v=>v.param).map(v=>v.param)).size!==definitions.filter(v=>v.param).length)throw new ValidateException('资料模板名称或映射重复，无法编辑');
  return definitions.filter(v=>v.use===1&&v.user_show===1);
}
function stored(account:Account):Record<string,unknown>[] {
  if(!account.extendInfo)return [];
  const value=parseLevelActivationJson(account.extendInfo);
  if(!Array.isArray(value)||value.length>128||value.some(v=>!v||typeof v!=='object'||Array.isArray(v)))throw new ValidateException('历史扩展资料无效，请联系管理员');
  return value as Record<string,unknown>[];
}
function values(account:Account,definitions:ProfileField[],history:Record<string,unknown>[]):ProfileField[]{
  return definitions.map(definition=>{
    const matches=history.filter(v=>v.info===definition.info);if(matches.length>1)throw new ValidateException('历史扩展资料名称重复，无法编辑');
    let value:unknown=matches[0]?.value??'';
    const columns:Record<string,unknown>={real_name:account.realName,sex:({1:'0',2:'1',0:'2'} as Record<number,string>)[account.sex]??'',birthday:profileBirthdayText(account.birthday),card_id:account.cardId,address:account.addres,mark:account.mark};
    if(definition.param)value=columns[definition.param];
    if(typeof value!=='string'&&typeof value!=='number')throw new ValidateException('历史扩展资料值无效');
    return{...definition,value:String(value)};
  });
}
async function version(account:Account):Promise<string>{return levelActivationHash({domain:'customer-profile-v1',uid:account.uid,pwd:account.pwd,status:account.status,isDel:account.isDel,deleteTime:account.deleteTime,nickname:account.nickname,avatar:account.avatar,extendInfo:account.extendInfo,realName:account.realName,sex:account.sex,birthday:account.birthday,cardId:account.cardId,addres:account.addres,mark:account.mark});}
async function revision(winner:Winner|undefined):Promise<string>{return levelActivationHash({domain:'customer-profile-template-v1',winner:winner??null});}
async function config(tx:DbClient,lock=false):Promise<Winner|undefined>{
  const query=tx.select({id:systemConfig.id,sort:systemConfig.sort,value:systemConfig.value}).from(systemConfig).where(and(eq(systemConfig.menuName,'user_extend_info'),eq(systemConfig.isStore,0))).orderBy(asc(systemConfig.sort),asc(systemConfig.id));
  const rows=await(lock?query.for('share'):query);return rows.at(-1);
}
async function active(tx:DbClient,actor:Pick<AuthUser,'uid'|'pwd'>,lock=false):Promise<Account>{
  const query=tx.select().from(user).where(and(eq(user.uid,actor.uid),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).limit(1);
  const account=(await(lock?query.for('update'):query))[0];
  if(!account||account.pwd!==actor.pwd)throw new AuthException('登录状态已变化，请重新登录');return account;
}
function legacy(account:Account,avatar:string){return{uid:account.uid,account:account.account,nickname:account.nickname,avatar,phone:account.phone,now_money:account.nowMoney,integral:account.integral,brokerage_price:account.brokeragePrice,spread_count:account.spreadCount,spread_uid:account.spreadUid,is_promoter:account.isPromoter};}
export class CustomerProfileService{
  constructor(private readonly container:Container,private readonly env:Env){}
  async read(actor:Pick<AuthUser,'uid'|'pwd'>,rich=false){
    const snapshot=await this.container.db.transaction(async tx=>{
      const db=tx as unknown as DbClient,account=await active(db,actor),avatar=await profileAvatarRead(db,actor.uid,account.avatar);
      if(!rich)return{account,avatar,details:null};
      const winner=await config(db),history=stored(account),definitions=values(account,fields(winner),history);
      return{account,avatar,details:{actor_uid:actor.uid,revision:await revision(winner),version:await version(account),profile:{uid:actor.uid,account:account.account,nickname:account.nickname,avatar:profileAvatarIdentity(account.avatar),avatar_preview:'',phone:account.phone,register_extend_info:definitions,extend_info:history}}};
    },{isolationLevel:'repeatable read',accessMode:'read only'});
    const preview=await renderProfileAvatar(this.env.APP_KEY,snapshot.avatar);
    if(!snapshot.details)return legacy(snapshot.account,parseCanonicalAttachmentId(profileAvatarIdentity(snapshot.account.avatar))===null?snapshot.account.avatar:preview);
    snapshot.details.profile.avatar_preview=preview;return snapshot.details;
  }
  async edit(actor:Pick<AuthUser,'uid'|'pwd'>,value:ProfileEditInput):Promise<void>{
    const input=parseProfileInput(value);
    await this.container.db.transaction(async tx=>{
      const db=tx as unknown as DbClient;
      await db.execute(sql`SET LOCAL lock_timeout='2s'`);
      const account=await active(db,actor,true),patch:Partial<typeof user.$inferInsert>={};
      if(input.nickname!==undefined&&input.nickname!==account.nickname){const nickname=input.profile===1?profileText(input.nickname.trim(),16,'昵称',false):input.nickname;if(nickname!==account.nickname)patch.nickname=nickname;}
      if(input.avatar!==undefined){const avatar=await profileAvatarWrite(db,actor.uid,input.avatar,account.avatar);if(avatar!==account.avatar)patch.avatar=avatar;}
      if(input.profile===1){
        const winner=await config(db,true);
        if(input.version!==await version(account))throw new ApiException('个人资料已变化，请重新读取后保存',409);
        if(input.revision!==await revision(winner))throw new ApiException('资料模板已变化，请重新读取后保存',409);
        const history=stored(account),definitions=values(account,fields(winner),history),submitted=input.extend_info!;
        if(submitted.length!==definitions.length||submitted.some(row=>!definitions.some(definition=>definition.info===row.info)))throw new ValidateException('请完整提交当前可编辑资料');
        // Reuse the audited format/standard-column normalizer, but never persist
        // its activation-specific levelExtendInfo column or accept client metadata.
        for(const definition of definitions){const text=String(submitted.find(field=>field.info===definition.info)!.value);if(definition.required&&text.trim()==='')throw new ValidateException(definition.tip||'请填写'+definition.info);}
        const changedDefinitions=definitions.filter(definition=>String(submitted.find(field=>field.info===definition.info)!.value)!==definition.value);
        for(const definition of changedDefinitions)profileText(String(submitted.find(field=>field.info===definition.info)!.value),1024,'资料值');
        const normalized=normalizeLevelActivationFields(submitted,changedDefinitions.map(definition=>({...definition})));
        const birthdayDefinition=changedDefinitions.find(definition=>definition.param==='birthday');
        if(birthdayDefinition){const value=String(submitted.find(field=>field.info===birthdayDefinition.info)!.value).trim();normalized.fields.birthday=profileBirthdayParse(value);}
        let changed=false;const updated=history.map(row=>({...row}));
        for(const definition of changedDefinitions){
          const row=normalized.extendInfo.find(v=>v.info===definition.info)!;
          let next=String(row.value??'');
          if(definition.format==='radio'&&next!==''){
            const index=definition.singlearr.indexOf(next);if(index>=0)next=String(index);
          }
          // Empty mapped values intentionally clear only that editable column,
          // matching PHP; hidden, removed and unrelated columns remain unchanged.
          const mapped:Record<string,keyof typeof user.$inferInsert>={real_name:'realName',sex:'sex',birthday:'birthday',card_id:'cardId',address:'addres',mark:'mark'};
          if(definition.param){
            const key=mapped[definition.param]!;
            const target=next===''?(key==='birthday'||key==='sex'?0:''):normalized.fields[key];
            if(target!==account[key])Object.assign(patch,{[key]:target});
          }
          if(next!==definition.value){
            changed=true;const index=updated.findIndex(v=>v.info===definition.info);
            if(index>=0)updated[index]={...updated[index],value:next};else updated.push({...definition,value:next});
          }
        }
        if(changed){const serialized=JSON.stringify(updated);if(new TextEncoder().encode(serialized).length>32768)throw new ValidateException('完整扩展资料超过容量');patch.extendInfo=serialized;}
      }
      if(Object.keys(patch).length)await db.update(user).set(patch).where(eq(user.uid,actor.uid));
    });
  }
}
