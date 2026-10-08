import { integer, jsonb, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

/** Permanent owner-scoped operation evidence. Installed with the reviewed
 * constraints and immutable triggers by the explicit maintenance installer. */
export const adminAuthorityOperation = pgTable('admin_authority_operation', {
  operationId: uuid('operation_id').primaryKey(),
  actorId: integer('actor_id').notNull(),
  adminType: integer('admin_type').notNull(),
  relationId: integer('relation_id').notNull(),
  operation: varchar('operation', { length: 32 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  revision: varchar('revision', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  result: jsonb('result').$type<{ id: number; created?: boolean; deleted?: boolean } | null>(),
  createdAt: integer('created_at').notNull(),
});
