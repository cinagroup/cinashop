import {sql} from 'drizzle-orm';
import {withTx,type Container} from '@/lib/di';
import type {Env} from '@/env';
import {ProductWordsService} from './ProductWordsService';
import {publicHotwordAuthorImages,renderHotwordAuthorImages} from './HotwordAuthorAssetPolicy';
/** Preserve the mature public20/filter/DTO. Publication authority is resolved
 * only from these persisted visible rows in the same read snapshot. */
export class PublicHotwordService{
 constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
 async publicKeywords(){
  const snapshot=await withTx(this.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
   const rows=await new ProductWordsService({...this.container,db:tx}).publicKeywords();
   const canonical=rows.map(row=>/^\/api\/assets\/[1-9]\d*$/u.test(row.icon)?row.icon:'');
   const authorized=await publicHotwordAuthorImages(tx,canonical);
   return {rows,canonical,authorized};
  });
  const previews=await renderHotwordAuthorImages(this.env.APP_KEY,snapshot.authorized);
  // An unauthorized old business URL retains its existing unsigned projection;
  // it grants no attachment access. Only a validated canonical gains a token.
  return snapshot.rows.map((row,i)=>({...row,icon:snapshot.canonical[i]&&previews[i]?previews[i]!:row.icon}));
 }
}
