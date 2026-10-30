import { integer, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

/** Owner receipts contain no password, OTP, phone or browser credential. */
export const adminProfileOperation = pgTable('admin_profile_operation', {
  operationId: uuid('operation_id').primaryKey(), actorId: integer('actor_id').notNull(),
  operation: varchar('operation', { length: 16 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(), createdAt: integer('created_at').notNull(),
});
/** This realm is deliberately separate from platform/user attachment libraries. */
export const adminProfileAvatar = pgTable('admin_profile_avatar', {
  avatarId: uuid('avatar_id').primaryKey(), actorId: integer('actor_id').notNull(),
  objectKey: varchar('object_key', { length: 200 }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(), mime: varchar('mime', { length: 32 }).notNull(),
  size: integer('size').notNull(), createdAt: integer('created_at').notNull(),
});
