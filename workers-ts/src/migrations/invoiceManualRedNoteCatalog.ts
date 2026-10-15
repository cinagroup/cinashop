import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {INVOICE_EVIDENCE_CATALOG_SQL} from './invoiceEvidenceCatalog';
import {customerManualGuestIdentityReadiness} from './guestRefundEntityCatalog';
export const INVOICE_MANUAL_RED_NOTE_PINS={
 record:'4168138287be01716ae83f5b0f6266abdfc03c5067d6f576c38535ecb57955eb',review:'580d6ee69807673ccbdff91b315ffb413cffae4e3ace8695c982e1528eb26705',guard:'fad3b659fa4bb261f8ca210d12e61e2995325028cebd049135c2bb63cdccfab7',protect:'82c16a73576786a61ee003ed8ecaf897194c9559f4da22b697b323fd8378c965',
 bareRecord:'6b1ee8342391b5649e06ba5693df808a9d9e01a8511ef9ceb034090662d34f97',bareReview:'c301182c4a0ab71fd30c16274fe0d8bc0d35c141c115b858b8e1b93ae897fcbc',
} as const;
export const INVOICE_MANUAL_RED_NOTE_CATALOG_SQL=INVOICE_EVIDENCE_CATALOG_SQL
 .replace("(VALUES ('store_order_invoice'),('store_order_invoice_evidence'),\n    ('store_order_invoice_allocation'))","(VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review'))")
 .replace("CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']\n        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END","ARRAY['SELECT','INSERT']")
 .replace("(VALUES('capture_invoice_evidence'),('protect_invoice_evidence'))","(VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note'))");
const names={store_order_invoice_manual_red_note:'record',store_order_invoice_manual_red_review:'review',guard_invoice_manual_red_note:'guard',protect_invoice_manual_red_note:'protect'} as const;
type Query=Pick<DbClient,'execute'>;
export async function inspectInvoiceManualRedNote(db:Query){
 const rows=await db.execute<Record<string,unknown>>(sql.raw(INVOICE_MANUAL_RED_NOTE_CATALOG_SQL));
 const pins=INVOICE_MANUAL_RED_NOTE_PINS,seen=new Set<string>();let complete=rows.length===4,bare=rows.length===4,fresh=rows.length===4;
 for(const r of rows){if(typeof r.name!=='string'||!Object.hasOwn(names,r.name)||seen.has(r.name)){complete=bare=fresh=false;continue;}seen.add(r.name);const key=names[r.name as keyof typeof names];
 const absent=r.present===false;fresh=fresh&&absent;
 complete=complete&&r.present===true&&r.safe===true&&typeof r.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(pins[key])&&r.fingerprint===pins[key];
 bare=bare&&(['guard','protect'].includes(key)?absent:r.present===true&&r.safe===true&&r.fingerprint===pins[key==='record'?'bareRecord':'bareReview']&&/^[a-f0-9]{64}$/.test(pins[key==='record'?'bareRecord':'bareReview']));}
 return{complete,bare,fresh,rows};
}
export async function invoiceManualRedNoteReadiness(db:Query,mode:'reader'|'admin-read'|'admin-write'='reader'){
 const writer=mode==='admin-write',permitWriter=mode!=='reader';
 const catalog=await inspectInvoiceManualRedNote(db);if(!catalog.complete)return{ready:false,reason:'manual_red_note_catalog_not_ready',catalog};
 const guest=await customerManualGuestIdentityReadiness(db);if(!guest.ready)return{ready:false,reason:'manual_red_note_guest_entity_catalog_not_ready',catalog};
 const [p]=await db.execute<{ready:boolean}>(sql`WITH RECURSIVE authority(oid) AS(
 SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user) UNION SELECT m.roleid FROM pg_auth_members m JOIN authority a ON a.oid=m.member)
 SELECT current_setting('server_version_num')::integer/10000=16 AND current_user=session_user
 AND EXISTS(SELECT 1 FROM pg_stat_activity b JOIN pg_roles r ON r.oid=b.usesysid WHERE b.pid=pg_backend_pid() AND r.rolname=current_user AND r.rolcanlogin)
 AND (SELECT count(*)=7 AND count(DISTINCT owner)=1 FROM (SELECT relowner AS owner FROM pg_class WHERE oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_invoice'),to_regclass('public.store_order_invoice_evidence'),to_regclass('public.store_order_invoice_manual_red_note'),to_regclass('public.store_order_invoice_manual_red_review')) UNION ALL SELECT proowner FROM pg_proc WHERE oid IN(to_regprocedure('public.guard_invoice_manual_red_note()'),to_regprocedure('public.protect_invoice_manual_red_note()'))) owners)
 AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
  OR has_schema_privilege(r.oid,'public','CREATE') OR has_database_privilege(r.oid,current_database(),'CREATE') OR has_parameter_privilege(r.oid,'session_replication_role','SET') OR has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
  OR EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_invoice_manual_red_note'),to_regclass('public.store_order_invoice_manual_red_review')) AND c.relowner=r.oid))
 AND NOT EXISTS(SELECT 1 FROM (VALUES('public.store_order_invoice_manual_red_note'),('public.store_order_invoice_manual_red_review')) n(name)
  WHERE NOT has_table_privilege(current_user,to_regclass(n.name),'SELECT') OR (${writer} AND NOT has_table_privilege(current_user,to_regclass(n.name),'INSERT')))
 AND NOT EXISTS(SELECT 1 FROM authority a CROSS JOIN(VALUES('public.store_order_invoice_manual_red_note'),('public.store_order_invoice_manual_red_review')) n(name)
  WHERE has_table_privilege(a.oid,to_regclass(n.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,to_regclass(n.name),'UPDATE,REFERENCES')
  OR (NOT ${permitWriter} AND (has_table_privilege(a.oid,to_regclass(n.name),'INSERT') OR has_any_column_privilege(a.oid,to_regclass(n.name),'INSERT')))) AS ready`);
 return{ready:p?.ready===true,reason:p?.ready===true?'':'manual_red_note_runtime_authority_unreviewed',catalog};
}
