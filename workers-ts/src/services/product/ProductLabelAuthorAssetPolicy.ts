import {asc,inArray} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {systemAttachment} from '@/models/schema';
import {publicProductPictures,renderProductPictures} from '@/services/activity/ProductAssetPolicy';
import {parseCanonicalAttachmentId} from '@/services/system/AttachmentService';
import {normalizeLabelIcon} from '../admin/AdminProductLabelInput';

import {ValidateException} from '@/utils/errors';

/** A stable business URL grants no object access. Only exact persisted
 * platform raster attachment metadata may authorize a canonical icon. */
export async function publicProductLabelAuthorImages(db:Pick<DbClient,'select'>,raw:readonly unknown[],lock=false):Promise<string[]>{
 if(raw.length>20000)throw new ValidateException('完整商品标签图标超过容量');
 const refs=raw.map(value=>{try{return normalizeLabelIcon(value);}catch{return '';}});
 const canonical=refs.map(value=>/^\/api\/assets\/[1-9]\d*$/u.test(value)&&Number(value.slice(12))<=2147483647?value:'');
 const ids=[...new Set(canonical.map(parseCanonicalAttachmentId).filter((id):id is number=>id!==null))].sort((a,b)=>a-b);
 if(!ids.length)return refs.map(value=>value.startsWith('/api/assets/')?'':value);
 const query=db.select({id:systemAttachment.attId,path:systemAttachment.attDir}).from(systemAttachment).where(inArray(systemAttachment.attId,ids)).orderBy(asc(systemAttachment.attId));
 const rows=await(lock?query.for('share',{noWait:true}):query),exact=new Set(rows.filter(row=>row.path===`/api/assets/${row.id}`).map(row=>row.id));
 const tokens=ids.filter(id=>exact.has(id)).map(id=>`/api/assets/${id}`),allowed=new Map<string,string>();
 for(let i=0;i<tokens.length;i+=10000){const chunk=tokens.slice(i,i+10000),checked=await publicProductPictures(db,chunk.map(image=>({image,type:0,relationId:0})));chunk.forEach((ref,j)=>allowed.set(ref,checked[j]??''));}
 return refs.map((value,i)=>canonical[i]?allowed.get(canonical[i]!)??'':value.startsWith('/api/assets/')?'':value);
}
export async function renderProductLabelAuthorImages(appKey:string|undefined,refs:readonly string[]):Promise<string[]>{const result:string[]=[];for(let i=0;i<refs.length;i+=10000)result.push(...await renderProductPictures(appKey,refs.slice(i,i+10000)));return result;}
export async function assertProductLabelAuthorIconChange(db:Pick<DbClient,'select'>,previous:string|null,next:string){
 if(previous!==null&&previous===next||!next)return;
 if(!next.startsWith('/api/assets/'))return; // Already validated stable URL; never fetch or mint an object token.
 if((await publicProductLabelAuthorImages(db,[next],true))[0]!==next)throw new ValidateException('请选择当前平台图库中的有效商品标签图标');
}
