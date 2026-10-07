import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

/** Immutable receipt for an authenticated, keyed newcomer direct-buy add. */
export const newcomerCartAddReplay = pgTable('newcomer_cart_add_replay', {
  uid: integer('uid').notNull(),
  requestKey: varchar('request_key', { length: 36 }).notNull(),
  intentHash: varchar('intent_hash', { length: 64 }).notNull(),
  cartId: integer('cart_id').notNull(),
  baseUnique: varchar('base_unique', { length: 16 }).notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [
  primaryKey({ name: 'ncar_pk', columns: [t.uid, t.requestKey] }),
  uniqueIndex('ncar_cart_uq').on(t.cartId),
  check('ncar_identity_ck', sql`${t.uid} > 0 AND ${t.cartId} > 0 AND ${t.createdAt} >= 0
    AND ${t.requestKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ${t.intentHash} ~ '^[0-9a-f]{64}$' AND ${t.baseUnique} <> ''`),
]);
