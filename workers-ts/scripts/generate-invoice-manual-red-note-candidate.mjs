// Generates only the independent reviewed maintenance candidate from literal DDL.
// It is not an execution/installation entry point and never scans migration authority.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
function literal(file,name){const source=readFileSync(resolve(root,file),'utf8').replaceAll('\r\n','\n');const start=source.indexOf('export const '+name+' = `');const compact=source.indexOf('export const '+name+'=`');const at=start>=0?start:compact;if(at<0)throw Error('Exact literal missing: '+name);const begin=source.indexOf('`',at)+1,end=source.indexOf('`;',begin);if(end<0)throw Error('Exact literal terminator missing');const raw=source.slice(begin,end);if(raw.includes('${'))throw Error('Interpolated SQL is not candidate source');return raw.replaceAll('\\\\','\\');}
const invoice=literal('src/migrations/invoiceEvidenceCatalog.ts','INVOICE_EVIDENCE_CATALOG_SQL'),split=literal('src/migrations/refundOrderSplitCatalog.ts','REFUND_SPLIT_CATALOG_SQL');
const table=literal('src/migrations/invoiceManualRedNote.ts','INVOICE_MANUAL_RED_NOTE_TABLE_SQL'),protection=literal('src/migrations/invoiceManualRedNote.ts','INVOICE_MANUAL_RED_NOTE_PROTECTION_SQL');
const red=invoice.replace("(VALUES ('store_order_invoice'),('store_order_invoice_evidence'),\n    ('store_order_invoice_allocation'))","(VALUES ('store_order_invoice_manual_red_note'),('store_order_invoice_manual_red_review'))")
 .replace("CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']\n        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END","ARRAY['SELECT','INSERT']")
 .replace("(VALUES('capture_invoice_evidence'),('protect_invoice_evidence'))","(VALUES('guard_invoice_manual_red_note'),('protect_invoice_manual_red_note'))");
const oldPins=[['store_order_invoice','fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646'],['store_order_invoice_evidence','f0aac4be250c1e1800b50e4b274d629be0156048ca8383d25a2c90d41cb9f71c'],['store_order_invoice_allocation','aba9ff86c3f88283979765a86e0d39e8df53dde31926a1585c95e6e7c6a66395'],['capture_invoice_evidence','4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7'],['protect_invoice_evidence','b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056'],['store_order_refund_split','6d8d309a74d565d2389ce69d0573c3992589c9ff2ee8b15d72b0982ca90f5667'],['store_order_fulfillment_branch','ed0a0a41327ab4ac75ffd73ef8939e90548acc80a836ccc0d8ac8f349e09321d'],['protect_refund_order_split','c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38']];
const pinSource=readFileSync(resolve(root,'src/migrations/invoiceManualRedNoteCatalog.ts'),'utf8'),pin=name=>{const m=pinSource.match(new RegExp('\\b'+name+":'([^']+)'"));if(!m)throw Error('Fixed pin missing');return m[1];};
const newPins=[['store_order_invoice_manual_red_note',pin('record')],['store_order_invoice_manual_red_review',pin('review')],['guard_invoice_manual_red_note',pin('guard')],['protect_invoice_manual_red_note',pin('protect')]];
const tuples=rows=>rows.map(([n,p])=>"('"+n+"','"+p+"')").join(',');
const sql=`-- Independent owner-only manual red-note candidate; NOT a generic migration.
-- No automatic installation, tax-provider claim, historical backfill, or runtime grants.
BEGIN;
SET LOCAL search_path=public,pg_temp;
SET LOCAL row_security=off;
SELECT set_config('statement_timeout','30000ms',true),set_config('lock_timeout','1000ms',true),set_config('idle_in_transaction_session_timeout','5000ms',true);
DO $manual_red_install$
DECLARE matched integer;objects jsonb;bare_objects jsonb;
BEGIN
 IF current_schema()<>'public' OR current_setting('server_version_num')::integer/10000<>16 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' OR current_setting('session_replication_role')<>'origin' OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') OR NOT pg_try_advisory_xact_lock(731611,0) THEN RAISE EXCEPTION 'Manual red-note candidate requires reviewed bounded PG16 owner transaction'; END IF;
 LOCK TABLE public.store_order_invoice,public.store_order_invoice_evidence,public.store_order_invoice_allocation,public.store_order_refund_split,public.store_order_fulfillment_branch IN ACCESS EXCLUSIVE MODE NOWAIT;
 SELECT count(*) INTO matched FROM (SELECT * FROM (${invoice}) i UNION ALL SELECT * FROM (${split}) s) c JOIN (VALUES ${tuples(oldPins)}) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched<>8 THEN RAISE EXCEPTION 'Complete original guest entity catalog and financial owner required'; END IF;
 SELECT count(*) INTO matched FROM (${red}) c JOIN (VALUES ${tuples(newPins)}) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched=4 THEN RETURN; END IF;
 IF to_regclass('public.store_order_invoice_manual_red_note') IS NOT NULL OR to_regclass('public.store_order_invoice_manual_red_review') IS NOT NULL OR to_regprocedure('public.guard_invoice_manual_red_note()') IS NOT NULL OR to_regprocedure('public.protect_invoice_manual_red_note()') IS NOT NULL THEN RAISE EXCEPTION 'Manual red-note candidate only installs fresh absent objects; ORM completion uses explicit inspected runner'; END IF;
 EXECUTE $red_note_tables$${table}$red_note_tables$;
 SELECT jsonb_agg(to_jsonb(c)) INTO bare_objects FROM (${red}) c;
 EXECUTE $red_note_protection$${protection}$red_note_protection$;
 SELECT jsonb_agg(to_jsonb(c)) INTO objects FROM (${red}) c;
 SELECT count(*) INTO matched FROM (${red}) c JOIN (VALUES ${tuples(newPins)}) expected(name,pin) USING(name) WHERE c.present AND c.owned AND c.safe AND c.fingerprint=expected.pin;
 IF matched<>4 THEN RAISE NOTICE 'INVOICE_MANUAL_RED_NOTE_COMMISSION %',jsonb_build_object('bare',bare_objects,'complete',objects);RAISE EXCEPTION 'Manual red-note fixed catalog pins required; no business readiness'; END IF;
END $manual_red_install$;
COMMIT;
`;
writeFileSync(resolve(root,'src/migrations/maintenance/0181_invoice_manual_red_note.sql'),sql);
