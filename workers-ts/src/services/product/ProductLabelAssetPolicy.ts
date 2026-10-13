import type {DbClient} from '@/lib/di';
import {publicProductPictures,renderProductPictures} from '@/services/activity/ProductAssetPolicy';
/** Resolve only persisted label owners through the shared public product media
 * authority, then mint response previews. Never persist the signed results. */
export async function resolveProductLabelIcons(db:DbClient,appKey:string|undefined,
  rows:readonly {icon:string;type:number;relationId:number}[]):Promise<string[]>{
  const refs=await publicProductPictures(db,rows.map(row=>({image:row.icon,type:row.type,relationId:row.relationId})));
  return renderProductPictures(appKey,refs);
}
