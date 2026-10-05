import { and,desc,eq,ilike,sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx,type Container } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { publicProductPictures,renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { AdminFabLinkCatalogService } from './AdminFabLinkCatalogService';
import { ValidateException } from '@/utils/errors';
export class AdminUserCenterCatalogService{
  constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
  categories(parameters:URLSearchParams){return new AdminFabLinkCatalogService(this.container,this.env).categories(parameters);}
  targets(parameters:URLSearchParams){return new AdminFabLinkCatalogService(this.container,this.env).targets(parameters);}
  async assets(parameters:URLSearchParams){
    for(const key of new Set(parameters.keys()))if(!['page','limit','search','pid'].includes(key)||parameters.getAll(key).length!==1)throw new ValidateException('素材查询参数未知或重复');
    const integer=(key:string,fallback:number,min:number,max:number)=>{const raw=parameters.get(key);if(raw===null)return fallback;const value=Number(raw);if(!/^(?:0|[1-9]\d*)$/.test(raw)||!Number.isSafeInteger(value)||value<min||value>max)throw new ValidateException('素材分页或分类无效');return value;};
    const page=integer('page',1,1,10001),limit=integer('limit',20,1,100),pid=integer('pid',0,0,2147483647),offset=(page-1)*limit;
    if(offset>10000)throw new ValidateException('素材分页偏移超过10000');const search=(parameters.get('search')??'').trim();if(search.length>100||/[\u0000-\u001f\u007f]/u.test(search))throw new ValidateException('素材搜索无效');
    const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);
      const where=and(eq(systemAttachment.type,1),eq(systemAttachment.relationId,0),eq(systemAttachment.moduleType,1),eq(systemAttachment.fileType,1),eq(systemAttachment.imageType,8),eq(systemAttachment.pid,pid),search?ilike(systemAttachment.realName,`%${search}%`):undefined,
        sql`${systemAttachment.attDir}='/api/assets/'||${systemAttachment.attId}::text AND ${systemAttachment.name} LIKE 'attachments/admin/1/%'
          AND strpos(${systemAttachment.name},chr(92))=0 AND ${systemAttachment.name} !~ '[[:cntrl:]]'
          AND ${systemAttachment.name} !~ '(^|/)[.]{1,2}(/|$)'
          AND (lower(${systemAttachment.name}) LIKE '%.jpg' OR lower(${systemAttachment.name}) LIKE '%.jpeg' OR lower(${systemAttachment.name}) LIKE '%.png' OR lower(${systemAttachment.name}) LIKE '%.webp' OR lower(${systemAttachment.name}) LIKE '%.gif')
          AND (btrim(${systemAttachment.attType})='' OR replace(lower(btrim(${systemAttachment.attType})),'image/jpg','image/jpeg')=CASE
            WHEN lower(${systemAttachment.name}) LIKE '%.jpg' OR lower(${systemAttachment.name}) LIKE '%.jpeg' THEN 'image/jpeg'
            WHEN lower(${systemAttachment.name}) LIKE '%.png' THEN 'image/png' WHEN lower(${systemAttachment.name}) LIKE '%.webp' THEN 'image/webp' ELSE 'image/gif' END)`);
      const rows=await tx.select({id:systemAttachment.attId,name:systemAttachment.realName,canonical_url:systemAttachment.attDir}).from(systemAttachment).where(where).orderBy(desc(systemAttachment.attId)).limit(limit).offset(offset);
      const[count]=await tx.select({count:sql<number>`count(*)::int`}).from(systemAttachment).where(where),pictures=await publicProductPictures(tx,rows.map(row=>({image:row.canonical_url,type:0,relationId:0})));
      return{rows,count:Number(count?.count??0),pictures};});
    const previews=await renderProductPictures(this.env.APP_KEY,result.pictures);
    return{list:result.rows.flatMap((row,index)=>previews[index]?[{...row,name:row.name||`素材${row.id}`,preview_url:previews[index]}]:[]),count:result.count,page,limit};
  }
}
