import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, systemAttachment } from '@/models/schema';
import { assertProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export interface OutProductSettingsInput { merUse?: 0 | 1; commandWord?: string; videoOpen?: 0 | 1 }
type Product = typeof storeProduct.$inferSelect;
const supplied = (input: Record<string, unknown>, key: string) => Object.hasOwn(input, key) && input[key] !== undefined;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Omitted settings retain the historical normalized shape and receipt hash. */
export function outProductSettingsInput(input: Record<string, unknown>): OutProductSettingsInput {
  const result: OutProductSettingsInput = {};
  for (const [wire, key] of [['mer_use', 'merUse'], ['video_open', 'videoOpen']] as const) {
    if (!supplied(input, wire)) continue;
    const value = input[wire];
    if (value !== 0 && value !== 1 && value !== '0' && value !== '1' && value !== false && value !== true)
      throw new ValidateException(`${wire}须为0或1`);
    result[key] = value === 1 || value === '1' || value === true ? 1 : 0;
  }
  if (supplied(input, 'command_word')) {
    const value = input.command_word;
    if (typeof value !== 'string' || [...value.trim()].length > 255 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value))
      throw new ValidateException('复制口令须为至多255字符的文本');
    result.commandWord = value.trim();
  }
  return result;
}

/** The save coordinator already owns SKU/product locks. A NOWAIT attachment
 * barrier excludes metadata deletion/GC without reversing a waiting writer. */
export async function admitOutProductSettings(tx: DbClient, input: OutProductSettingsInput & { videoLink: string; productType: number }, existing: Product | undefined) {
  if (input.videoOpen === 1 && !input.videoLink) throw new ValidateException('开启商品视频须填写视频地址');
  const assetId = parseCanonicalAttachmentId(input.videoLink);
  if (assetId !== null) await tx.execute(sql`LOCK TABLE ONLY ${systemAttachment} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const validateVideo = input.videoOpen !== undefined || assetId !== null || !existing || input.videoLink !== existing.videoLink;
  if (validateVideo) await assertProductVideoReference(tx, input.videoLink, { type: 0, relationId: 0 }, { allowLegacyRelative: true });
  const asset = assetId === null ? [] : await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, assetId));
  const expected = { merUse: input.merUse ?? existing?.merUse ?? 0, commandWord: input.commandWord ?? existing?.commandWord ?? '',
    videoOpen: input.videoOpen ?? (input.videoLink ? 1 : 0), videoLink: input.videoLink };
  return { values: expected, assert: async (productId: number) => {
    const [product] = await tx.select({ type: storeProduct.type, relationId: storeProduct.relationId, productType: storeProduct.productType,
      isDel: storeProduct.isDel, merUse: storeProduct.merUse, commandWord: storeProduct.commandWord,
      videoOpen: storeProduct.videoOpen, videoLink: storeProduct.videoLink }).from(storeProduct).where(eq(storeProduct.id, productId)).limit(1);
    if (!product || product.type !== 0 || product.relationId !== 0 || product.productType !== input.productType || product.isDel !== 0 ||
      !same({ merUse: product.merUse, commandWord: product.commandWord, videoOpen: product.videoOpen, videoLink: product.videoLink }, expected))
      throw new ValidateException('商品门店代理、复制口令或视频设置已变化');
    if (validateVideo) await assertProductVideoReference(tx, expected.videoLink, { type: 0, relationId: 0 }, { allowLegacyRelative: true });
    if (assetId !== null && !same(await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, assetId)), asset))
      throw new ValidateException('商品视频素材已变化');
  } };
}
