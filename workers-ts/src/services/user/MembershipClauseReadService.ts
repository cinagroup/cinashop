import {desc,eq,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import type {Env} from '@/env';
import {agreement} from '@/models/schema';
import {parseCanonicalAttachmentId,signAttachmentReferences} from '@/services/system/AttachmentService';
import {publicDiyPresentationImages,publicDiyPresentationVideos} from '@/services/content/DiyPresentationVideoPolicy';
import {canonicalDiyPresentationReference,diyPresentationHtmlMediaReferences,mapDiyPresentationHtmlMedia,sanitizeDiyPresentationHtml} from '../../../../view/common/diyPresentationHtml';
import {ValidateException} from '@/utils/errors';

export const MEMBERSHIP_CLAUSE_HTML_BYTES=4_000_000;
export interface MembershipClauseDocument{id:number;type:1;title:string;content_preview:string}
export interface MembershipClauseRead{owner_uid:number;member_explain:''|MembershipClauseDocument}

/** The article editing canonicalizer has a separate200000-character limit.
 * This dedicated read projection keeps the full4MB clause contract while
 * reusing the unchanged safe grammar and platform image/video predicates. */
function stableReference(value:string):string{
 const reference=canonicalDiyPresentationReference(value);
 try{const u=new URL(reference);if(u.protocol==='https:'&&!u.username&&!u.password&&/^\/api\/assets\/[1-9]\d*$/u.test(u.pathname)){const local=canonicalDiyPresentationReference(u.pathname+u.search+u.hash);if(parseCanonicalAttachmentId(local)!==null)return local;}}catch{/* ordinary relative reference */}
 return reference;
}
async function previewClause(db:Pick<DbClient,'select'>,key:string|undefined,content:string):Promise<string>{
 const clean=sanitizeDiyPresentationHtml(mapDiyPresentationHtmlMedia(content,stableReference)),slots=diyPresentationHtmlMediaReferences(clean);
 if(slots.length>9999)throw new ValidateException('会员协议正文图片与视频超过完整9999项预览容量');
 const images=await publicDiyPresentationImages(db,slots.filter(v=>v.kind==='image').map(v=>v.value)),videos=await publicDiyPresentationVideos(db,slots.filter(v=>v.kind==='video').map(v=>v.value));let image=0,video=0;
 const approved=slots.map(v=>v.kind==='image'?images[image++]!:videos[video++]!);
 const html=sanitizeDiyPresentationHtml(mapDiyPresentationHtmlMedia(clean,(_reference,_kind,index)=>approved[index]!));
 const references=[...new Set(approved.filter(v=>parseCanonicalAttachmentId(v)!==null))],tickets=references.length?await signAttachmentReferences(key,references):[],byReference=new Map(references.map((v,index)=>[v,tickets[index]!]));
 return mapDiyPresentationHtmlMedia(html,reference=>byReference.get(reference)??reference);
}

/** Additive authenticated projection of the persisted PHP membership clause.
 * Public payVip and every legacy membership DTO retain their own semantics. */
export class MembershipClauseReadService{
 constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
 async read(uid:number):Promise<MembershipClauseRead>{
  if(!Number.isSafeInteger(uid)||uid<=0)throw new ValidateException('会员协议读取身份无效');
  return withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
   const [row]=await tx.select().from(agreement).where(eq(agreement.type,1)).orderBy(desc(agreement.sort),desc(agreement.id)).limit(1);
   if(!row||row.type!==1||row.status!==1)return{owner_uid:uid,member_explain:''};
   // The durable type1 record, not request HTML or attachment IDs, authorizes
   // the existing platform-only media projection inside this same snapshot.
   const content=row.content??'';
   if(typeof content!=='string'||Buffer.byteLength(content)>MEMBERSHIP_CLAUSE_HTML_BYTES)throw new ValidateException('会员协议超过完整4MB UTF8读取容量');
   let preview:string;
   try{preview=await previewClause(tx,this.env.APP_KEY,content);}
   catch(error){if(error instanceof ValidateException||error instanceof Error&&error.message.startsWith('DIY'))throw new ValidateException(error.message.replaceAll('DIY','会员协议'));throw error;}
   if(Buffer.byteLength(preview)>MEMBERSHIP_CLAUSE_HTML_BYTES)throw new ValidateException('会员协议超过完整4MB UTF8预览容量');
   return{owner_uid:uid,member_explain:{id:row.id,type:1,title:row.title,content_preview:preview}};
  });
 }
}
