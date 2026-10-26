import { and, asc, eq, ilike, ne, sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemUserLevel, user, userLevel } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ApiErrorCode, AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { assertAdminAuthoritySession, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { distributorColor, distributorImage } from './AdminDistributorLevelInput';
import { parseLevelActivationJson } from './AdminLevelActivationInput';

type Level = typeof systemUserLevel.$inferSelect;
type Values = Partial<typeof systemUserLevel.$inferInsert>;
export type AdminLevelDefinitionRow = Level & { icon_preview: string; image_preview: string };
export interface AdminLevelDefinitionPage { list: AdminLevelDefinitionRow[]; count: number; page: number; limit: number }
export const ADMIN_LEVEL_BODY_BYTES = 64 * 1024;
const INT_MAX = 2147483647;
const EDIT_FIELDS = ['name','grade','discount','exp_num','icon','image','color','is_show','explain'] as const;
const bad = (message: string): never => { throw new ValidateException(message); };
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) bad(`${label}须为${minimum}至${maximum}的整数`);
  return value as number;
}
export function adminLevelDefinitionId(value: unknown): number {
  if (!['number','string'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || Number(value) > INT_MAX) bad('会员等级ID无效');
  return Number(value);
}
function text(value: unknown, maximum: number, label: string, multiline = false): string {
  if (typeof value !== 'string' || [...value].length > maximum || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)
    || [...value].some(c => { const n=c.codePointAt(0)!; return n>=0xd800&&n<=0xdfff; })) bad(`${label}格式无效或过长`);
  return value as string;
}
function discount(value: unknown): string {
  if (!['number','string'].includes(typeof value)) bad('享受折扣须为0至100且最多两位小数');
  const match=/^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) bad('享受折扣须为0至100且最多两位小数');
  const units=BigInt(match![1]!)*100n+BigInt((match![2]??'').padEnd(2,'0'));
  if(units>10000n)bad('享受折扣须为0至100');
  return `${units/100n}.${String(units%100n).padStart(2,'0')}`;
}
export async function readAdminLevelDefinitionBody(request: Request): Promise<unknown> {
  return parseLevelActivationJson(await readBoundedUtf8Text(request,ADMIN_LEVEL_BODY_BYTES));
}
function object(value: unknown): Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))bad('等级请求须为JSON对象');
  const body=value as Record<string,unknown>;
  if(Object.keys(body).some(key=>!['id',...EDIT_FIELDS].includes(key)))bad('等级请求包含未知字段');
  return body;
}
function queryNumber(query: URLSearchParams,key: string,fallback: number,maximum: number): number {
  const value=query.get(key);if(value===null)return fallback;
  if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>maximum)bad(`${key}分页参数无效`);
  return Number(value);
}
export function parseAdminLevelDefinitionQuery(query: URLSearchParams) {
  if(!query.has('paged'))return null;
  for(const key of query.keys())if(!['paged','page','limit','title','is_show'].includes(key)||query.getAll(key).length!==1)bad('等级查询字段未知或重复');
  if(query.get('paged')!=='1')bad('paged须为1');
  const page=queryNumber(query,'page',1,10000),limit=queryNumber(query,'limit',10,100),offset=(page-1)*limit;
  if(offset>100000)bad('等级分页偏移超过100000');
  const title=text(query.get('title')??'',255,'等级名称查询').trim(),raw=query.get('is_show');
  if(raw!==null&&raw!==''&&raw!=='0'&&raw!=='1')bad('是否显示须为0或1');
  return{page,limit,offset,title,isShow:raw===null||raw===''?undefined:Number(raw)};
}
function conditions(query: NonNullable<ReturnType<typeof parseAdminLevelDefinitionQuery>>): SQL {
  const parts:SQL[]=[eq(systemUserLevel.isDel,0)];
  if(query.isShow!==undefined)parts.push(eq(systemUserLevel.isShow,query.isShow));
  if(query.title)parts.push(ilike(systemUserLevel.name,`%${query.title.replace(/[\\%_]/gu,'\\$&')}%`));
  return and(...parts)!;
}
/** Admin CRUD only. The existing published media policy remains the authority;
 * the default legacy array and all pricing/eligibility DTOs are unchanged. */
export class AdminLevelDefinitionService {
  constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
  private async read<T>(actor:AdminAuthorityActor,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    assertAdminAuthoritySession(actor);
    return withTx(this.container,async tx=>{
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const [live]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      if(!live||live.adminType!==1||live.relationId!==0||live.status!==1||live.isDel!==0)throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_BANNED);
      if(!timingSafeEqual(new TextEncoder().encode(md5(live.pwd)),new TextEncoder().encode(actor.authVersion)))throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
      if(live.level!==0){const{keys}=await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);if(!hasAdminPermission(keys,'level.view'))throw new AuthException('会员等级查看权限已变化',ApiErrorCode.ERR_AUTH);}
      const result=await work(tx);assertAdminAuthoritySession(actor);return result;
    });
  }
  async list(query:URLSearchParams,actor:AdminAuthorityActor):Promise<Level[]|AdminLevelDefinitionPage>{
    const input=parseAdminLevelDefinitionQuery(query);
    if(!input)return this.read(actor,tx=>tx.select().from(systemUserLevel).where(eq(systemUserLevel.isDel,0)).orderBy(asc(systemUserLevel.grade)));
    const result=await this.read(actor,async tx=>{
      const where=conditions(input),[stats]=await tx.select({count:sql<number>`COUNT(*)::int`}).from(systemUserLevel).where(where);
      const rows=await tx.select().from(systemUserLevel).where(where).orderBy(asc(systemUserLevel.grade),asc(systemUserLevel.id)).limit(input.limit).offset(input.offset);
      const pictures=await publicProductPictures(tx,rows.flatMap(row=>[{image:row.icon,type:0,relationId:0},{image:row.image,type:0,relationId:0}]));
      return{rows,pictures,count:stats?.count??0};
    });
    const pictures=await renderProductPictures(this.env.APP_KEY,result.pictures);
    return{list:result.rows.map((row,index)=>({...row,icon_preview:pictures[index*2]!,image_preview:pictures[index*2+1]!})),count:result.count,page:input.page,limit:input.limit};
  }
  private write<T>(actor:AdminAuthorityActor,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    return withAdminAuthorityWriteTx(this.container,actor,'level.manage',async tx=>{
      // A single catalogue relation fence precedes every Admin invariant read,
      // including creates on an empty catalogue. No user-table lock is needed.
      await tx.execute(sql`LOCK TABLE ${systemUserLevel} IN SHARE ROW EXCLUSIVE MODE`);
      return work(tx);
    });
  }
  private async media(tx:DbClient,values:Values){
    const references=[values.icon,values.image].filter((v):v is string=>typeof v==='string');
    const ids=[...new Set(references.map(parseCanonicalAttachmentId).filter((v):v is number=>v!==null))].sort((a,b)=>a-b);
    for(const id of ids)await tx.select({id:systemAttachment.attId}).from(systemAttachment).where(eq(systemAttachment.attId,id)).for('share');
    const allowed=await publicProductPictures(tx,references.map(image=>({image,type:0,relationId:0})));
    if(allowed.some((reference,index)=>reference!==references[index]))bad('等级图标或背景不可用或不属于平台');
  }
  async save(value:unknown,actor:AdminAuthorityActor):Promise<{id:number}>{
    const body=object(value),id=body.id===undefined||body.id===0?0:adminLevelDefinitionId(body.id);
    if(!EDIT_FIELDS.some(key=>Object.hasOwn(body,key)))bad('至少提交一个可编辑等级字段');
    return this.write(actor,async tx=>{
      const current=id?(await tx.select().from(systemUserLevel).where(and(eq(systemUserLevel.id,id),eq(systemUserLevel.isDel,0))).limit(1).for('update'))[0]:undefined;
      if(id&&!current)throw new NotFoundException('会员等级不存在或已删除');
      const values:Values={};
      for(const key of EDIT_FIELDS){
        if(!Object.hasOwn(body,key)){if(!current)bad(`新增等级缺少${key}`);continue;}
        const value=body[key];
        if(key==='grade'||key==='exp_num'){
          const prior=current?.[key==='grade'?'grade':'expNum'];
          const next=value===prior&&typeof prior==='number'?prior:integer(value,1,INT_MAX,key==='grade'?'等级':'解锁经验');
          if(!current||next!==prior)values[key==='grade'?'grade':'expNum']=next;
        }else if(key==='discount'){
          const next=discount(value);if(!current||next!==current.discount)values.discount=next;
        }else if(key==='is_show'){
          const next=integer(value,0,1,'是否显示');if(!current||next!==current.isShow)values.isShow=next;
        }else{
          const maximum=key==='explain'?10000:key==='color'?32:255;
          const next=text(value,maximum,key,key==='explain'),prior=current?.[key];
          if(current&&next===prior)continue;
          if(!next.trim())bad(`${key}不能为空`);
          values[key]=key==='icon'||key==='image'?distributorImage(next):key==='color'?distributorColor(next):key==='name'?next.trim():next;
        }
      }
      const grade=values.grade??current?.grade,exp=values.expNum??current?.expNum,name=values.name??current?.name;
      if(grade===undefined||exp===undefined||name===undefined)throw Error('Incomplete level candidate');
      if(values.name!==undefined){const rows=await tx.select({id:systemUserLevel.id}).from(systemUserLevel).where(and(eq(systemUserLevel.isDel,0),ne(systemUserLevel.id,id),sql`lower(btrim(${systemUserLevel.name}))=lower(${name})`)).limit(1);if(rows.length)bad('等级名称不可重复');}
      if(values.grade!==undefined||values.expNum!==undefined){
        const duplicate=await tx.select({id:systemUserLevel.id}).from(systemUserLevel).where(and(eq(systemUserLevel.isDel,0),ne(systemUserLevel.id,id),sql`(${systemUserLevel.grade}=${grade} OR ${systemUserLevel.expNum}=${exp})`)).limit(1);if(duplicate.length)bad('等级或解锁经验不可重复');
        const previous=(await tx.select({exp:systemUserLevel.expNum}).from(systemUserLevel).where(and(eq(systemUserLevel.isDel,0),ne(systemUserLevel.id,id),sql`${systemUserLevel.grade}<${grade}`)).orderBy(sql`${systemUserLevel.grade} DESC`,asc(systemUserLevel.id)).limit(1))[0];
        const next=(await tx.select({exp:systemUserLevel.expNum}).from(systemUserLevel).where(and(eq(systemUserLevel.isDel,0),ne(systemUserLevel.id,id),sql`${systemUserLevel.grade}>${grade}`)).orderBy(asc(systemUserLevel.grade),asc(systemUserLevel.id)).limit(1))[0];
        if(previous&&exp<=previous.exp)bad('解锁经验必须大于上一等级');if(next&&exp>=next.exp)bad('解锁经验必须小于下一等级');
      }
      await this.media(tx,values);
      if(current){if(Object.keys(values).length)await tx.update(systemUserLevel).set(values).where(eq(systemUserLevel.id,id));return{id};}
      const[created]=await tx.insert(systemUserLevel).values({...values,name,grade,expNum:exp,isForever:1,validDate:0,isPay:0,money:'0.00',merId:0,isDel:0,addTime:Math.floor(Date.now()/1000)}).returning({id:systemUserLevel.id});
      if(!created)throw Error('Missing created membership level');return created;
    });
  }
  async remove(value:unknown,actor:AdminAuthorityActor):Promise<null>{
    const id=adminLevelDefinitionId(value);
    return this.write(actor,async tx=>{
      // Existing grant writers hold FOR SHARE on this exact persisted row.
      // Lock first, then READ COMMITTED occupancy query sees completed grants.
      const[current]=await tx.select().from(systemUserLevel).where(eq(systemUserLevel.id,id)).limit(1).for('update');
      if(!current||current.isDel!==0)return null;
      const[occupant]=await tx.select({uid:user.uid}).from(user).where(eq(user.level,id)).limit(1);
      if(occupant)bad('存在用户已是该等级，无法删除');
      await tx.update(userLevel).set({isDel:1}).where(eq(userLevel.levelId,id));
      await tx.update(systemUserLevel).set({isDel:1}).where(eq(systemUserLevel.id,id));return null;
    });
  }
}
