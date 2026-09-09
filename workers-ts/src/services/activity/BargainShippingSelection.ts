import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeBargain, storeCart, storeProduct, systemStore } from '@/models/schema';
import type { SystemConfigEnv } from '@/services/system/SystemConfigService';
import { readBargainPickupEnabled } from './BargainPickupPolicy';
import { ValidateException } from '@/utils/errors';

/** Advisory UI selection, not an order reservation. The checkout/create path
 * must still validate its current rules. No locks or remote I/O inside the
 * bounded, read-only SQL snapshot, including the authoritative SQL settings.
 */
export async function readBargainShippingSelection(container: Container, _env: SystemConfigEnv, uid: number, cartIds: number[]) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Array.isArray(cartIds) || !cartIds.length || cartIds.length > 200 ||
      cartIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) || new Set(cartIds).size !== cartIds.length) {
    throw new ValidateException('砍价配送购物车参数无效');
  }
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql.raw(`SELECT
      set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    const rows = await tx.select({ cartId: storeCart.id, activityId: storeBargain.id, deliveryType: storeBargain.deliveryType,
      productType: storeProduct.productType, ownerType: storeProduct.type, relationId: storeProduct.relationId })
      .from(storeCart).innerJoin(storeProduct, eq(storeProduct.id, storeCart.productId))
      .innerJoin(storeBargain, and(eq(storeBargain.id, storeCart.activityId), eq(storeBargain.productId, storeProduct.id)))
      .where(and(inArray(storeCart.id, cartIds), eq(storeCart.uid, uid), eq(storeCart.type, 2), eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0), eq(storeCart.status, 1), gt(storeCart.cartNum, 0),
        eq(storeProduct.isDel, 0), eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1),
        eq(storeBargain.isDel, 0), eq(storeBargain.status, 1),
        sql`(${storeBargain.startTime} IS NULL OR ${storeBargain.startTime} <= (clock_timestamp() AT TIME ZONE 'UTC'))
          AND (${storeBargain.stopTime} IS NULL OR ${storeBargain.stopTime} >= (clock_timestamp() AT TIME ZONE 'UTC'))`))
      .orderBy(asc(storeCart.id)).limit(201);
    if (rows.length !== cartIds.length || new Set(rows.map(row => row.activityId)).size !== 1) {
      throw new ValidateException('砍价商品失效、归属不符或需要分开结算');
    }
    const source = rows[0];
    if (![0,1,2,3,4].includes(source.productType) || ![0,1,2].includes(source.ownerType) ||
        (source.ownerType === 0 ? source.relationId !== 0 : source.relationId <= 0)) throw new ValidateException('砍价商品配送归属无效');
    const nonLogistics = [1,2,3].includes(source.productType);
    if (!nonLogistics && source.deliveryType && !/^[123](?:,[123])*$/.test(source.deliveryType)) throw new ValidateException('砍价配送配置无效');
    let methods = nonLogistics ? [1] : source.deliveryType ? [...new Set(source.deliveryType.split(',').map(Number))] : [1,2,3];
    if (source.productType === 4) methods = methods.filter(method => method === 2);
    const pickupEnabled = methods.includes(2) && await readBargainPickupEnabled(tx);
    const stores = methods.includes(2) && pickupEnabled ? await tx.select({ id: systemStore.id, name: systemStore.name,
      introduction: systemStore.introduction, phone: systemStore.phone, address: systemStore.address,
      detailed_address: systemStore.detailedAddress, image: systemStore.image, latitude: systemStore.latitude,
      longitude: systemStore.longitude, valid_time: systemStore.validTime, day_time: systemStore.dayTime })
      .from(systemStore).where(and(eq(systemStore.isShow,1),eq(systemStore.isDel,0),eq(systemStore.isStore,1),
        source.ownerType === 1 ? eq(systemStore.id,source.relationId) : undefined)).orderBy(asc(systemStore.id)).limit(201) : [];
    if (stores.length > 200) throw new ValidateException('可用自提门店超过200家，请联系管理员配置范围');
    if (!stores.length) methods = methods.filter(method => method !== 2);
    methods.sort();
    const shippingTypes = ([1,2] as const).filter(type => type === 1 ? methods.includes(1) || methods.includes(3) : methods.includes(2));
    return { kind: 'bargain' as const, cartIds: [...cartIds], activityId: source.activityId, methods, shippingTypes,
      requiresAddress: !nonLogistics && source.productType !== 4, stores, type: shippingTypes.length === 1 ? shippingTypes[0] : 0 };
  });
}
