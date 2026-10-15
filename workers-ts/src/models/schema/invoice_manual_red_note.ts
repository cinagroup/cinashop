import {sql} from 'drizzle-orm';
import {check,index,integer,pgTable,text,uniqueIndex,varchar} from 'drizzle-orm/pg-core';
export const storeOrderInvoiceManualRedNote=pgTable('store_order_invoice_manual_red_note',{
 id:varchar('id',{length:36}).primaryKey(),invoiceId:integer('invoice_id').notNull(),sourceOrderId:integer('source_order_id').notNull(),paymentOrderId:integer('payment_order_id').notNull(),
 uid:integer('uid').notNull(),actorId:integer('actor_id').notNull(),requestHash:varchar('request_hash',{length:64}).notNull(),recordHash:varchar('record_hash',{length:64}).notNull(),
 recordJson:text('record_json').notNull(),createdTime:integer('created_time').notNull(),
},t=>[index('soimrn_invoice').on(t.invoiceId,t.createdTime),
 check('soimrn_identity_ck',sql`${t.id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ${t.invoiceId}>0 AND ${t.sourceOrderId}>0 AND ${t.paymentOrderId}>0 AND ${t.uid}>=0 AND ${t.actorId}>0 AND ${t.createdTime}>0`),
 check('soimrn_hash_ck',sql`${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.recordHash} ~ '^[a-f0-9]{64}$'`),
 check('soimrn_json_ck',sql`octet_length(${t.recordJson})<=65536 AND jsonb_typeof(${t.recordJson}::jsonb)='object' AND ${t.recordJson}::jsonb @> '{"version":"invoice-manual-red-note-v1","currency":"CNY"}'::jsonb`)]);
export const storeOrderInvoiceManualRedReview=pgTable('store_order_invoice_manual_red_review',{
 id:varchar('id',{length:36}).primaryKey(),recordId:varchar('record_id',{length:36}).notNull(),invoiceId:integer('invoice_id').notNull(),sourceOrderId:integer('source_order_id').notNull(),paymentOrderId:integer('payment_order_id').notNull(),
 uid:integer('uid').notNull(),actorId:integer('actor_id').notNull(),decision:varchar('decision',{length:7}).notNull(),originalDocumentNumber:varchar('original_document_number',{length:50}).notNull(),redDocumentNumber:varchar('red_document_number',{length:20}).notNull(),
 requestHash:varchar('request_hash',{length:64}).notNull(),recordHash:varchar('record_hash',{length:64}).notNull(),reviewHash:varchar('review_hash',{length:64}).notNull(),reviewJson:text('review_json').notNull(),createdTime:integer('created_time').notNull(),
},t=>[uniqueIndex('soimrr_record_uq').on(t.recordId),uniqueIndex('soimrr_confirmed_origin_uq').on(t.invoiceId,t.originalDocumentNumber).where(sql`${t.decision}='confirm'`),
 uniqueIndex('soimrr_confirmed_red_uq').on(t.redDocumentNumber).where(sql`${t.decision}='confirm'`),
 check('soimrr_identity_ck',sql`${t.id} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ${t.recordId} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND ${t.invoiceId}>0 AND ${t.sourceOrderId}>0 AND ${t.paymentOrderId}>0 AND ${t.uid}>=0 AND ${t.actorId}>0 AND ${t.createdTime}>0 AND ${t.decision} IN ('confirm','reject') AND btrim(${t.originalDocumentNumber})<>'' AND ${t.originalDocumentNumber} !~ '[[:cntrl:]]' AND ${t.redDocumentNumber} ~ '^[0-9]{8,20}$'`),
 check('soimrr_hash_ck',sql`${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.recordHash} ~ '^[a-f0-9]{64}$' AND ${t.reviewHash} ~ '^[a-f0-9]{64}$'`),
 check('soimrr_json_ck',sql`octet_length(${t.reviewJson})<=4096 AND jsonb_typeof(${t.reviewJson}::jsonb)='object' AND ${t.reviewJson}::jsonb @> '{"version":"invoice-manual-red-review-v1","manual_checked":true}'::jsonb`)]);

