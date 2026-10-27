import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeProduct, storePromotions, user } from '@/models/schema';
import { AuthException, ValidateException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { V2PromotionCompatibilityService } from '@/services/activity/V2PromotionCompatibilityService';
import { PublicCatalogService } from './PublicCatalogService';
import { RecommendationNavigationService } from './RecommendationNavigationService';
import type { MemberLevelRecommendationsPage } from './MemberLevelRecommendationsInput';

/** A display-only snapshot of the existing hot catalogue. No detection, quote,
 * reward, visit, cache, cart, provider or attachment-object write is performed. */
export class MemberLevelRecommendationsService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  async read(uid: number, paging: MemberLevelRecommendationsPage) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException();
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const [account] = await tx.select({ uid: user.uid }).from(user).where(and(eq(user.uid, uid),
        eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
      if (!account) throw new AuthException('请重新登录');
      const snapshot = createContainerFromDb(tx);
      // Reuse legacy visibility, sort, exact monetary strings and offer policy.
      // is_vip/vip_price are product offers, never proof of paid entitlement.
      const list = await new PublicCatalogService(snapshot, this.env).recommend(uid, { flag: 'hot', ...paging });
      const framed = await new V2PromotionCompatibilityService(snapshot, this.env).decorateProductFrames(list);
      const rows = await new RecommendationNavigationService(snapshot, { strictOwners: true }).decorate(framed);
      const ids = rows.map(row => Number(row.id));
      const persisted = ids.length ? await tx.select({ id: storeProduct.id, image: storeProduct.image,
        type: storeProduct.type, relationId: storeProduct.relationId }).from(storeProduct).where(inArray(storeProduct.id, ids)) : [];
      const products = new Map(persisted.map(row => [row.id, row]));
      const pictures = await publicProductPictures(tx, rows.map(row => {
        const product = products.get(Number(row.id));
        if (!product || product.image !== row.image) throw new ValidateException('推荐商品图片状态不一致');
        // Existing public catalogue validates an actual visible store. As in
        // presale, its media grants only the platform attachment namespace.
        return { image: product.image, ...(product.type === 1 && product.relationId > 0
          ? { type: 0, relationId: 0 } : { type: product.type, relationId: product.relationId }) };
      }), 256);
      const frameIds = [...new Set(rows.flatMap(row => {
        const frame = row.activity_frame;
        return frame && typeof frame === 'object' && !Array.isArray(frame) ? [Number((frame as Record<string, unknown>).id)] : [];
      }))];
      const persistedFrames = frameIds.length ? await tx.select().from(storePromotions).where(and(
        inArray(storePromotions.id, frameIds), eq(storePromotions.type, 1), eq(storePromotions.storeId, 0),
        eq(storePromotions.pid, 0), eq(storePromotions.promotionsType, 5), eq(storePromotions.status, 1), eq(storePromotions.isDel, 0))) : [];
      const frames = new Map(persistedFrames.map(row => [row.id, row]));
      const framePictures = await publicProductPictures(tx, rows.map(row => {
        const frame = row.activity_frame;
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { image: '', type: 0, relationId: 0 };
        const value = frame as Record<string, unknown>, persistedFrame = frames.get(Number(value.id));
        if (!persistedFrame || value.image !== persistedFrame.image || value.name !== persistedFrame.name) {
          throw new ValidateException('推荐商品边框状态不一致');
        }
        return { image: persistedFrame.image, type: 0, relationId: 0 };
      }));
      return { rows, pictures, framePictures };
    });
    // Stable references have already passed persisted ownership/metadata checks.
    const images = await renderProductPictures(this.env.APP_KEY, [...result.pictures, ...result.framePictures]);
    return { owner_uid: uid, ...paging, list: result.rows.map((row, index) => ({ ...row,
      image_source: result.pictures[index], image: images[index],
      activity_frame: Array.isArray(row.activity_frame) ? [] : { ...(row.activity_frame as Record<string, unknown>),
        image_source: result.framePictures[index], image: images[result.rows.length + index] },
    })) };
  }
}
