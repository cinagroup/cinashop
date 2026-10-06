import { sql } from 'drizzle-orm';
import { check, decimal, foreignKey, index, integer, pgTable, serial, smallint, varchar } from 'drizzle-orm/pg-core';
import { storeCouponIssue } from './activity';

/** Reusable Admin template, distinct from the checkout-authoritative issue. */
export const storeCouponTemplate = pgTable('store_coupon_template', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 64 }).notNull(),
  scopeType: smallint('scope_type').notNull(),
  categoryId: integer('category_id').default(0).notNull(),
  productIds: varchar('product_ids', { length: 500 }).default('').notNull(),
  couponPrice: decimal('coupon_price', { precision: 12, scale: 2 }).notNull(),
  useMinPrice: decimal('use_min_price', { precision: 12, scale: 2 }).default('0.00').notNull(),
  validDays: integer('valid_days').notNull(),
  sort: integer('sort').default(0).notNull(),
  status: smallint('status').default(1).notNull(),
  isDel: smallint('is_del').default(0).notNull(),
  addTime: integer('add_time').notNull(),
}, (t) => [
  check('sct_title_ck', sql`length(btrim(${t.title})) > 0`),
  check('sct_scope_ck', sql`(${t.scopeType} = 0 AND ${t.categoryId} = 0 AND ${t.productIds} = '') OR (${t.scopeType} = 1 AND ${t.categoryId} > 0 AND ${t.productIds} = '') OR (${t.scopeType} = 2 AND ${t.categoryId} = 0 AND CASE WHEN ${t.productIds} ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$' THEN cardinality(string_to_array(${t.productIds}, ',')::integer[]) <= 100 ELSE false END)`),
  check('sct_money_ck', sql`${t.couponPrice} > 0 AND ${t.couponPrice} < 'Infinity'::numeric AND ${t.useMinPrice} >= 0 AND ${t.useMinPrice} < 'Infinity'::numeric`),
  check('sct_days_ck', sql`${t.validDays} BETWEEN 1 AND 3650`),
  check('sct_state_ck', sql`${t.sort} >= 0 AND ${t.status} IN (0, 1) AND ${t.isDel} IN (0, 1) AND ${t.addTime} >= 0`),
  index('sct_catalog_idx').on(t.isDel, t.status, t.sort, t.id),
]);

/** Immutable provenance. cid alone must never adopt historical orphan issues. */
export const storeCouponTemplateIssue = pgTable('store_coupon_template_issue', {
  issueId: integer('issue_id').primaryKey(),
  templateId: integer('template_id').notNull(),
  issuedAt: integer('issued_at').notNull(),
  sourceRevision: varchar('source_revision', { length: 64 }).notNull(),
}, (t) => [
  foreignKey({ name: 'scti_issue_fk', columns: [t.issueId], foreignColumns: [storeCouponIssue.id] }),
  foreignKey({ name: 'scti_template_fk', columns: [t.templateId], foreignColumns: [storeCouponTemplate.id] }),
  check('scti_issued_at_ck', sql`${t.issuedAt} >= 0`),
  check('scti_revision_ck', sql`${t.sourceRevision} ~ '^[a-f0-9]{64}$'`),
  index('scti_template_idx').on(t.templateId, t.issueId),
]);
