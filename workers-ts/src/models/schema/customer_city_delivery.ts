import { sql } from 'drizzle-orm';
import { bigint, bigserial, check, foreignKey, index, integer, jsonb, pgTable, smallint, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

export const CUSTOMER_CITY_JOB_STATUSES = ['PENDING', 'PROCESSING', 'ADMITTED', 'UNKNOWN', 'REJECTED', 'REVOKED', 'CANCELLED', 'DELIVERED'] as const;
export type CustomerCityJobStatus = typeof CUSTOMER_CITY_JOB_STATUSES[number];
export type CustomerCityProvider = 'dada' | 'uu';
/** Original admission authority is immutable; processing never impersonates an Admin. */
export const customerCityDeliveryJob = pgTable('customer_city_delivery_job', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorUid: integer('actor_uid').notNull(), serviceId: integer('service_id').notNull(),
  actorAuthVersion: varchar('actor_auth_version', { length: 32 }).notNull(), actorExpiresAt: integer('actor_expires_at').notNull(),
  scopeKey: varchar('scope_key', { length: 64 }).notNull(), requestKey: varchar('request_key', { length: 36 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(), intentHash: varchar('intent_hash', { length: 64 }).notNull(),
  requestedOrderId: integer('requested_order_id').notNull(), rootOrderId: integer('root_order_id').notNull(), orderId: integer('order_id').notNull(),
  customerUid: integer('customer_uid').notNull(), storeId: integer('store_id').notNull(), supplierId: integer('supplier_id').notNull(),
  provider: varchar('provider', { length: 8 }).$type<CustomerCityProvider>().notNull(),
  providerOrderId: varchar('provider_order_id', { length: 32 }).notNull(),
  intent: jsonb('intent').$type<Record<string, unknown>>().notNull(),
  status: varchar('status', { length: 16 }).$type<CustomerCityJobStatus>().default('PENDING').notNull(),
  leaseToken: varchar('lease_token', { length: 36 }).default('').notNull(), leaseUntil: integer('lease_until').default(0).notNull(),
  lastErrorCode: varchar('last_error_code', { length: 64 }).default('').notNull(),
  addTime: integer('add_time').notNull(), updateTime: integer('update_time').notNull(),
}, t => [
  uniqueIndex('ccdjob_actor_request_uq').on(t.actorUid, t.requestKey),
  uniqueIndex('ccdjob_provider_order_uq').on(t.provider, t.providerOrderId),
  index('ccdjob_root_status').on(t.rootOrderId, t.status, t.id),
  index('ccdjob_dispatch').on(t.status, t.leaseUntil, t.id),
  check('ccdjob_identity_ck', sql`${t.actorUid}>0 AND ${t.serviceId}>0 AND ${t.requestedOrderId}>0 AND ${t.rootOrderId}>0 AND ${t.orderId}>0 AND ${t.customerUid}>0 AND ${t.storeId}>=0 AND ${t.supplierId}>=0`),
  check('ccdjob_keys_ck', sql`${t.requestKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${t.requestHash} ~ '^[0-9a-f]{64}$' AND ${t.intentHash} ~ '^[0-9a-f]{64}$' AND ${t.scopeKey} ~ '^[0-9a-f]{64}$' AND ${t.actorAuthVersion} ~ '^[0-9a-f]{32}$'`),
  check('ccdjob_provider_ck', sql`${t.provider} IN ('dada','uu') AND ${t.providerOrderId} ~ '^[A-Za-z0-9._:-]{1,32}$'`),
  check('ccdjob_status_ck', sql`${t.status} IN ('PENDING','PROCESSING','ADMITTED','UNKNOWN','REJECTED','REVOKED','CANCELLED','DELIVERED')`),
  check('ccdjob_intent_ck', sql`jsonb_typeof(${t.intent})='object' AND octet_length(${t.intent}::text)<=131072`),
  check('ccdjob_time_ck', sql`${t.actorExpiresAt}>0 AND ${t.addTime}>0 AND ${t.updateTime}>=${t.addTime} AND ${t.leaseUntil}>=0`),
]);
export const customerCityDeliveryAttempt = pgTable('customer_city_delivery_attempt', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), jobId: bigint('job_id', { mode: 'number' }).notNull(),
  requestKey: varchar('request_key', { length: 36 }).notNull(),
  phase: varchar('phase', { length: 16 }).$type<'QUOTING'|'QUOTED'|'ISSUING'|'ACCEPTED'|'UNKNOWN'|'REJECTED'|'REVOKED'>().notNull(),
  quote: jsonb('quote').$type<Record<string, unknown>>().default({}).notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().default({}).notNull(),
  errorCode: varchar('error_code', { length: 64 }).default('').notNull(),
  startedTime: integer('started_time').notNull(), issuedTime: integer('issued_time').default(0).notNull(), updateTime: integer('update_time').notNull(),
}, t => [
  foreignKey({ name:'ccdattempt_job_fk', columns:[t.jobId], foreignColumns:[customerCityDeliveryJob.id] }).onDelete('restrict'),
  uniqueIndex('ccdattempt_job_uq').on(t.jobId),
  check('ccdattempt_phase_ck', sql`${t.phase} IN ('QUOTING','QUOTED','ISSUING','ACCEPTED','UNKNOWN','REJECTED','REVOKED')`),
  check('ccdattempt_json_ck', sql`jsonb_typeof(${t.quote})='object' AND jsonb_typeof(${t.result})='object' AND octet_length(${t.quote}::text)<=32768 AND octet_length(${t.result}::text)<=32768`),
  check('ccdattempt_key_ck', sql`${t.requestKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ${t.startedTime}>0 AND ${t.issuedTime}>=0 AND ${t.updateTime}>=${t.startedTime}`),
]);
/** Callback authority is an exact durable attempt, never the newest legacy record. */
export const customerCityDeliveryBinding = pgTable('customer_city_delivery_binding', {
  jobId: bigint('job_id', { mode:'number' }).primaryKey(), attemptId: bigint('attempt_id', { mode:'number' }).notNull(),
  deliveryOrderId: integer('delivery_order_id').notNull(), orderId: integer('order_id').notNull(), rootOrderId: integer('root_order_id').notNull(),
  customerUid: integer('customer_uid').notNull(), storeId: integer('store_id').notNull(), supplierId: integer('supplier_id').notNull(),
  provider: varchar('provider', { length:8 }).$type<CustomerCityProvider>().notNull(), providerOrderId: varchar('provider_order_id', { length:32 }).notNull(),
  active: smallint('active').default(1).notNull(), addTime: integer('add_time').notNull(), updateTime: integer('update_time').notNull(),
}, t => [
  foreignKey({ name:'ccdbinding_job_fk', columns:[t.jobId], foreignColumns:[customerCityDeliveryJob.id] }).onDelete('restrict'),
  foreignKey({ name:'ccdbinding_attempt_fk', columns:[t.attemptId], foreignColumns:[customerCityDeliveryAttempt.id] }).onDelete('restrict'),
  uniqueIndex('ccdbinding_delivery_uq').on(t.deliveryOrderId), uniqueIndex('ccdbinding_provider_uq').on(t.provider,t.providerOrderId),
  uniqueIndex('ccdbinding_active_order_uq').on(t.orderId).where(sql`${t.active}=1`),
  check('ccdbinding_identity_ck', sql`${t.deliveryOrderId}>0 AND ${t.orderId}>0 AND ${t.rootOrderId}>0 AND ${t.customerUid}>0 AND ${t.storeId}>=0 AND ${t.supplierId}>=0 AND ${t.active} IN (0,1)`),
  check('ccdbinding_provider_ck', sql`${t.provider} IN ('dada','uu') AND ${t.providerOrderId} ~ '^[A-Za-z0-9._:-]{1,32}$' AND ${t.addTime}>0 AND ${t.updateTime}>=${t.addTime}`),
]);
