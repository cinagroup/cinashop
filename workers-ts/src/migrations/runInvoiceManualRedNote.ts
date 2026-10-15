import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {pricingIdentifier} from './checkoutPricingLockCatalog';
import {lockReviewedGuestRefundEntities} from './runInvoiceEvidence';
import {INVOICE_MANUAL_RED_NOTE_TABLE_SQL,INVOICE_MANUAL_RED_NOTE_PROTECTION_SQL} from './invoiceManualRedNote';
import {inspectInvoiceManualRedNote,INVOICE_MANUAL_RED_NOTE_PINS} from './invoiceManualRedNoteCatalog';
export {inspectInvoiceManualRedNote} from './invoiceManualRedNoteCatalog';
type Root=Pick<DbClient,'transaction'>&Partial<Pick<DbClient,'$client'>>;
async function install(tx:Pick<DbClient,'execute'>,completeEmptyOrm:boolean){
 await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);await tx.execute(sql`SET LOCAL row_security=off`);
 await tx.execute(sql`SELECT set_config('statement_timeout','30000ms',true),set_config('lock_timeout','1000ms',true),set_config('idle_in_transaction_session_timeout','5000ms',true)`);
 await lockReviewedGuestRefundEntities(tx);
 const initial=await inspectInvoiceManualRedNote(tx);
 if(!initial.fresh&&initial.rows.some(r=>r.present===true&&r.owned!==true))throw Error('Manual red-note objects must share the reviewed financial owner');
 if(!initial.fresh&&!initial.bare&&!initial.complete&&[INVOICE_MANUAL_RED_NOTE_PINS.bareRecord,INVOICE_MANUAL_RED_NOTE_PINS.bareReview].some(p=>String(p)==='commissioning-pending')
  &&initial.rows.length===4&&initial.rows.filter(r=>r.kind==='table').every(r=>r.present===true&&r.safe===true&&r.owned===true)&&initial.rows.filter(r=>r.kind==='function').every(r=>r.present===false)){
  console.info('INVOICE_MANUAL_RED_NOTE_COMMISSION',JSON.stringify({phase:'bare-pins',bare:initial.rows,complete:null}));
  throw Error('Manual red-note bare catalog pins require independent commissioning; no schema upgrade authorized');
 }
 if(initial.complete){await tx.execute(sql`LOCK TABLE public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review IN ACCESS EXCLUSIVE MODE NOWAIT`);if(!(await inspectInvoiceManualRedNote(tx)).complete)throw Error('Manual red-note catalog changed during locking');return;}
 if(initial.fresh)await tx.execute(sql.raw(INVOICE_MANUAL_RED_NOTE_TABLE_SQL));
 else if(completeEmptyOrm&&initial.bare){
  await tx.execute(sql`LOCK TABLE public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review IN ACCESS EXCLUSIVE MODE NOWAIT`);
  const [empty]=await tx.execute<{empty:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_note) AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_manual_red_review) AS empty`);
  if(!empty?.empty)throw Error('Manual red-note ORM completion requires empty exact ledgers');
 }else throw Error('Manual red-note schema is drifted or unreviewed');
 const bare=await inspectInvoiceManualRedNote(tx);
 await tx.execute(sql.raw(INVOICE_MANUAL_RED_NOTE_PROTECTION_SQL));
 const complete=await inspectInvoiceManualRedNote(tx);
 if(!complete.complete){
  if(Object.values(INVOICE_MANUAL_RED_NOTE_PINS).some(p=>String(p)==='commissioning-pending'))console.info('INVOICE_MANUAL_RED_NOTE_COMMISSION',JSON.stringify({bare:bare.rows,complete:complete.rows}));
  throw Error('Manual red-note complete catalog fixed pins required; commissioning is not business readiness');
 }
}
function root(db:Root){if(!Object.hasOwn(db,'$client')||!db.$client)throw Error('Manual red-note installation requires explicit root maintenance client');}
export async function runInvoiceManualRedNoteSchema(db:Root,completeEmptyOrm=false){root(db);await db.transaction(tx=>install(tx,completeEmptyOrm),{isolationLevel:'read committed',accessMode:'read write'});}
export async function runInvoiceManualRedNote(db:Root,roles:{adminRole:string;readerRoles:readonly string[]},completeEmptyOrm=false){
 root(db);const admin=pricingIdentifier(roles.adminRole);if(!roles.readerRoles.length||roles.readerRoles.includes(roles.adminRole)||new Set(roles.readerRoles).size!==roles.readerRoles.length)throw Error('Separate explicit manual red-note reader roles required');
 const readers=roles.readerRoles.map(pricingIdentifier);
 await db.transaction(async tx=>{
  await install(tx,completeEmptyOrm);
  const requested=[roles.adminRole,...roles.readerRoles];
  const [safe]=await tx.execute<{safe:boolean}>(sql`WITH RECURSIVE roles(oid) AS(
   SELECT oid FROM pg_roles WHERE rolname IN(${sql.join(requested.map(r=>sql`${r}`),sql`,`)})
   UNION SELECT m.roleid FROM pg_auth_members m JOIN roles r ON r.oid=m.member)
   SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN(${sql.join(requested.map(r=>sql`${r}`),sql`,`)}) AND rolcanlogin)=${requested.length}
   AND NOT EXISTS(SELECT 1 FROM roles x JOIN pg_roles r ON r.oid=x.oid WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(r.oid,'public','CREATE') OR has_database_privilege(r.oid,current_database(),'CREATE') OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_invoice_manual_red_note'),to_regclass('public.store_order_invoice_manual_red_review')) AND c.relowner=r.oid))
   AND NOT EXISTS(SELECT 1 FROM roles r CROSS JOIN(VALUES('public.store_order_invoice_manual_red_note'),('public.store_order_invoice_manual_red_review')) n(name) WHERE has_table_privilege(r.oid,to_regclass(n.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,to_regclass(n.name),'UPDATE,REFERENCES')) AS safe`);
  if(!safe?.safe)throw Error('Manual red-note runtime authorities require reviewed ordinary LOGINs');
  // Never revoke/repair inherited writer access. A reader already carrying it is rejected.
  for(const reader of roles.readerRoles){const [p]=await tx.execute<{safe:boolean}>(sql`WITH RECURSIVE a(oid) AS(SELECT oid FROM pg_roles WHERE rolname=${reader} UNION SELECT m.roleid FROM pg_auth_members m JOIN a ON a.oid=m.member)
   SELECT NOT EXISTS(SELECT 1 FROM a CROSS JOIN(VALUES('public.store_order_invoice_manual_red_note'),('public.store_order_invoice_manual_red_review')) n(name) WHERE has_table_privilege(a.oid,to_regclass(n.name),'INSERT') OR has_any_column_privilege(a.oid,to_regclass(n.name),'INSERT')) AS safe`);if(!p?.safe)throw Error('Manual red-note reader already has writer authority');}
  await tx.execute(sql.raw(`GRANT SELECT,INSERT ON public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review TO ${admin};`));
  for(const reader of readers)await tx.execute(sql.raw(`GRANT SELECT ON public.store_order_invoice_manual_red_note,public.store_order_invoice_manual_red_review TO ${reader};`));
  if(!(await inspectInvoiceManualRedNote(tx)).complete)throw Error('Manual red-note grant catalog post-check failed');
 },{isolationLevel:'read committed',accessMode:'read write'});
}
