import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, systemAttachment } from '@/models/schema';
import { outProductSettingsInput, type OutProductSettingsInput } from '@/services/out/OutProductSettings';
import { assertProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { HttpApiException, ValidateException } from '@/utils/errors';

type Product = typeof storeProduct.$inferSelect;
export type SupplierProductSettingsInput = Pick<OutProductSettingsInput, 'commandWord'|'videoOpen'>;
/** Reuse the actual text/flag parser without accepting platform mer_use. */
export function supplierProductSettingsInput(raw: Record<string, unknown>): SupplierProductSettingsInput {
  return outProductSettingsInput({
    ...(Object.hasOwn(raw,'command_word') ? {command_word:raw.command_word} : {}),
    ...(Object.hasOwn(raw,'video_open') ? {video_open:raw.video_open} : {}),
  });
}
export function supplierVideoOpen(input: SupplierProductSettingsInput, videoLink: string,
  existing?: Pick<Product,'videoOpen'|'videoLink'>): number {
  // An unrelated save cannot reopen a retained video. Legacy clients changing
  // the link still get the established nonempty-address default.
  return input.videoOpen ?? (existing && videoLink === existing.videoLink ? existing.videoOpen : videoLink ? 1 : 0);
}
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function admitSupplierProductSettings(tx: DbClient,supplierId:number,
  input: SupplierProductSettingsInput, videoLink:string,existing?:Product) {
  const videoOpen=supplierVideoOpen(input,videoLink,existing);
  if (input.videoOpen===1 && !videoLink) throw new ValidateException('开启商品视频须填写视频地址');
  const assetId=parseCanonicalAttachmentId(videoLink);
  const validateVideo=assetId!==null || !existing || existing.videoLink!==videoLink || input.videoOpen===1;
  if(validateVideo)await assertProductVideoReference(tx,videoLink,{type:2,relationId:supplierId},{allowLegacyRelative:true});
  const asset=assetId===null?[]:await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,assetId));
  const expected={commandWord:input.commandWord??existing?.commandWord??'',videoOpen,videoLink};
  return {values:{videoOpen,...(input.commandWord===undefined?{}:{commandWord:input.commandWord})},
    assert:async(productId:number,expectedMain:Product)=>{
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const [product]=await tx.select().from(storeProduct).where(eq(storeProduct.id,productId));
      if(!product || product.type!==2 || product.relationId!==supplierId || ![0,1,3].includes(product.productType)
        ||product.isDel!==0||product.isShow!==0||product.isVerify!==0||!same(product,expectedMain)
        ||!same({commandWord:product.commandWord,videoOpen:product.videoOpen,videoLink:product.videoLink},expected))
        throw new HttpApiException('商品口令或视频设置保存核对失败，请刷新后重试',409,409);
      if(validateVideo)await assertProductVideoReference(tx,videoLink,{type:2,relationId:supplierId},{allowLegacyRelative:true});
      if(assetId!==null&&!same(await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,assetId)),asset))
        throw new HttpApiException('商品视频素材已变化，请刷新后重试',409,409);
    }};
}
