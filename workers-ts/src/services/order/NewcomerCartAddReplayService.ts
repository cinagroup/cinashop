import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart } from '@/models/schema';
import { newcomerCartAddReplay } from '@/models/schema/newcomer_cart_replay';
import { assertNewcomerCartAddReplayReady } from '@/migrations/runNewcomerCartAddReplay';
import { StoreCartService } from '@/services/order/StoreCartService';
import { ApiException, ValidateException } from '@/utils/errors';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CART_REPLAY_LOCK_NAMESPACE = 1313030497;

export interface NewcomerCartAddReplayInput {
  uid: number;
  requestKey: string;
  productId: number;
  activityId: number;
  unique: string;
}

export interface NewcomerCartAddReplayResult {
  id: number;
  cartId: number;
  cartNum: 1;
  replayed: boolean;
}

function conflict(message: string, code: string, cartId?: number): never {
  throw new ApiException(message, 409, { code, ...(cartId ? { cartId } : {}) });
}

async function intentHash(input: NewcomerCartAddReplayInput): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    'newcomer-cart-add-v1', input.uid, input.productId, input.activityId, input.unique, 1,
  ]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function replay(tx: DbClient, input: NewcomerCartAddReplayInput, hash: string) {
  const [prior] = await tx.select().from(newcomerCartAddReplay).where(and(
    eq(newcomerCartAddReplay.uid, input.uid),
    eq(newcomerCartAddReplay.requestKey, input.requestKey),
  )).limit(1);
  if (!prior) return null;
  if (prior.intentHash !== hash) conflict('相同请求标识的新人商品信息已变更', 'request_key_conflict');
  const [cart] = await tx.select().from(storeCart).where(eq(storeCart.id, prior.cartId)).limit(1);
  if (!cart || cart.uid !== input.uid || cart.type !== 7 || cart.isNew !== 1 ||
      cart.productId !== input.productId || cart.activityId !== input.activityId ||
      cart.productAttrUnique !== prior.baseUnique || cart.cartNum !== 1 ||
      cart.isPay !== 0 || cart.isDel !== 0 || cart.status !== 1) {
    conflict('原新人购物车已失效，请核对订单或重新选择', 'cart_terminal', prior.cartId);
  }
  return { id: prior.cartId, cartId: prior.cartId, cartNum: 1, replayed: true } as const;
}

/** The receipt and direct-buy row commit together. No provider/KV call runs
 * within this transaction. A replay never re-runs mutable eligibility rules. */
export async function addNewcomerCartWithReplay(
  container: Container, env: Env, input: NewcomerCartAddReplayInput,
): Promise<NewcomerCartAddReplayResult> {
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0 || input.uid > 2_147_483_647 ||
      !Number.isSafeInteger(input.productId) || input.productId <= 0 ||
      !Number.isSafeInteger(input.activityId) || input.activityId <= 0 ||
      typeof input.unique !== 'string' || !input.unique || input.unique.length > 16 ||
      typeof input.requestKey !== 'string' || !KEY.test(input.requestKey)) {
    throw new ValidateException('新人购物车请求参数无效');
  }
  const hash = await intentHash(input);
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    await assertNewcomerCartAddReplayReady(tx);
    // The user-scoped lock serializes a missing key without touching checkout's
    // user row. The PK remains the final cross-session uniqueness fence.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CART_REPLAY_LOCK_NAMESPACE}, ${input.uid})`);
    const restored = await replay(tx, input, hash);
    if (restored) return restored;
    const result = await new StoreCartService(createContainerFromDb(tx), env).add({
      uid: input.uid, productId: input.productId, activityId: input.activityId,
      unique: input.unique, cartNum: 1, type: 7, isNew: 1,
      newcomerEligibilityFromDb: true,
    });
    const [cart] = await tx.select().from(storeCart).where(eq(storeCart.id, result.id)).limit(1);
    if (!cart || cart.uid !== input.uid || cart.type !== 7 || cart.isNew !== 1 ||
        cart.productId !== input.productId || cart.activityId !== input.activityId ||
        cart.cartNum !== 1 || !cart.productAttrUnique) {
      throw new Error('Newcomer cart receipt cannot bind created row');
    }
    await tx.insert(newcomerCartAddReplay).values({
      uid: input.uid, requestKey: input.requestKey, intentHash: hash,
      cartId: cart.id, baseUnique: cart.productAttrUnique,
      createdAt: Math.floor(Date.now() / 1000),
    });
    return { id: cart.id, cartId: cart.id, cartNum: 1, replayed: false };
  });
}
