import type {DbClient} from '@/lib/di';
import {ValidateException} from '@/utils/errors';
import {classifyProductMediaReference} from '../../../../view/common/productMediaReference';
import {publicProductPictures,renderProductPictures,type ProductPicture} from '@/services/activity/ProductAssetPolicy';
/** The category mobile-picture column accepts 512 characters. Canonical assets
 * retain the existing product owner, object-key and raster MIME authority.
 * Static pictures do not inherit the unrelated 255-character product-slot cap. */
export async function publicProductCategoryPictures(db:Pick<DbClient,'select'>,values:readonly ProductPicture[]):Promise<string[]>{
  if(values.length>10000)throw new ValidateException('分类图片超过完整预览容量');
  const validOwner=(row:ProductPicture)=>[0,1].includes(row.type)?row.relationId===0:row.type===2&&Number.isSafeInteger(row.relationId)&&row.relationId>0&&row.relationId<=2147483647;
  const classified=values.map(row=>validOwner(row)&&row.image!==''?classifyProductMediaReference(row.image):null);
  const indexes=classified.flatMap((value,index)=>value?.kind==='asset'?[index]:[]);
  const verified=await publicProductPictures(db,indexes.map(index=>({...values[index],image:classified[index]?.kind==='asset'?classified[index].reference:''})));
  const bySlot=new Map(indexes.map((index,position)=>[index,verified[position]]));
  return classified.map((value,index)=>value?.kind==='asset'?bySlot.get(index)??'':value?.kind==='public'&&value.reference.length<=512?value.reference:'');
}
export async function renderProductCategoryPictures(appKey:string|undefined,references:readonly string[]){return renderProductPictures(appKey,references);}