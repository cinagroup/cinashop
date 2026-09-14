import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, smallint, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

/** Content-free, permanent creation evidence; no FK cascade and no expiry. */
export const shippingTemplateCreateReplay = pgTable('shipping_template_create_replay', {
  ownerType: smallint('owner_type').notNull(),
  relationId: integer('relation_id').notNull(),
  actorId: integer('actor_id').notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  templateId: integer('template_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`clock_timestamp()`).notNull(),
}, t => [
  primaryKey({ name: 'stcr_pk', columns: [t.ownerType, t.relationId, t.actorId, t.requestKey] }),
  unique('stcr_template_uq').on(t.templateId),
  check('stcr_scope_ck', sql`(${t.ownerType} = 0 AND ${t.relationId} = 0) OR (${t.ownerType} = 2 AND ${t.relationId} > 0)`),
  check('stcr_identity_ck', sql`${t.actorId} > 0 AND ${t.templateId} > 0`),
  check('stcr_hash_ck', sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('stcr_key_ck', sql`${t.requestKey}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`),
]);
