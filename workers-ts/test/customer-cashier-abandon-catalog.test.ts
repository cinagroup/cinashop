import {describe,expect,it,vi} from 'vitest';
import type {DbClient} from '../src/lib/di';
import {inspectCashierSecondCardAbandon,cashierSecondCardAbandonBaseReadiness,cashierSecondCardAbandonReadiness,
  assertCashierSecondCardAbandonReads,installCashierSecondCardAbandon} from '../src/migrations/runCashierSecondCardAbandon';
import {assertCashierNotAbandoned,readCashierAbandonment} from '../src/services/customer-work/CustomerCashierAbandon';
import {cashierSecondCardAbandonRuntimePrivilegePlan,cashierSecondCardAbandonRuntimeGrantSql} from '../src/migrations/cashierSecondCardAbandonRuntimePlan';
import {assertCashierAbandonHistoricalBasis,assertCashierAuditManualRedNoteCatalog,reviewedCashierAuditCatalogView,CASHIER_ABANDON_TABLE} from '../scripts/data-migration/cashier-abandon-catalog';
import {completeConstructionTableNames,MANUAL_RED_NOTE_ORM_TABLE_NAMES,ERP_ORM_TABLE_NAMES} from './helpers/completeConstructionInventory';
import {INVOICE_MANUAL_RED_NOTE_PINS} from '../src/migrations/invoiceManualRedNoteCatalog';
import type {Catalog} from '../scripts/data-migration/postgres-catalog-audit';

/** These probes prove pre-admission failure without a business/maintenance database.
 * Successful constraints, independent LOGIN ACLs and concurrency use the native PG16 suite. */
describe('cashier abandonment catalog admission boundaries',()=>{
  const key='00000000-0000-4000-8000-000000000001';
  function absent() {const execute=vi.fn().mockResolvedValue([]);return{db:{execute} as unknown as DbClient,execute};}
  it('allows an old read to report unknown but never admits a new write when the ledger is absent',async()=>{
    const {db,execute}=absent();
    expect(await cashierSecondCardAbandonBaseReadiness(db)).toMatchObject({ready:false,present:false});
    expect(await cashierSecondCardAbandonReadiness(db)).toMatchObject({ready:false,available:false});
    await expect(assertCashierSecondCardAbandonReads(db)).resolves.toMatchObject({ready:false,present:false});
    await expect(readCashierAbandonment(db,101,key,'creation')).resolves.toBeNull();
    await expect(assertCashierNotAbandoned(db,101,key,'creation')).rejects.toMatchObject({httpStatus:503});
    expect(execute).toHaveBeenCalledTimes(5);
  });
  it.each([160000,170000])('refuses an unpinned measured shape on PG version %i before querying grants or rows',async(server_version_num)=>{
    const execute=vi.fn().mockResolvedValue([{shape:{unreviewed:true},server_version_num}]),db={execute} as unknown as DbClient;
    const observed=await inspectCashierSecondCardAbandon(db);expect(observed).toMatchObject({present:true,complete:false});
    expect(observed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(assertCashierSecondCardAbandonReads(db)).rejects.toMatchObject({httpStatus:503});
    await expect(assertCashierNotAbandoned(db,101,key,'payment')).rejects.toMatchObject({httpStatus:503});
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it('rejects ambiguous catalog identity rather than using the first candidate',async()=>{
    const db={execute:vi.fn().mockResolvedValue([{shape:{},server_version_num:160000},{shape:{},server_version_num:160000}])} as unknown as DbClient;
    await expect(inspectCashierSecondCardAbandon(db)).rejects.toThrow('ambiguous');
  });
  it.each(['missing','null','inherited'])('requires an own root maintenance client: %s',async(mode)=>{
    const transaction=vi.fn(),db=mode==='inherited'?Object.assign(Object.create({$client:{}}),{transaction}):{transaction,...(mode==='null'?{$client:null}:{})};
    await expect(installCashierSecondCardAbandon(db as unknown as DbClient)).rejects.toThrow('root maintenance client');
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([false,true])('compiles only append/read ledger grants with image profile=%s',images=>{
    const plan=cashierSecondCardAbandonRuntimePrivilegePlan(images),grants=cashierSecondCardAbandonRuntimeGrantSql('reviewed_cashier_runtime',[],images);
    expect(plan.tables.cashier_second_card_abandon_v1).toEqual(['SELECT','INSERT']);
    expect(plan.updateColumns.cashier_second_card_abandon_v1).toBeUndefined();
    expect(grants.filter(statement=>statement.includes('cashier_second_card_abandon_v1')))
      .toEqual(['GRANT SELECT,INSERT ON public.cashier_second_card_abandon_v1 TO "reviewed_cashier_runtime"']);
    expect(Boolean(plan.tables.cashier_second_card_form_session_v1)).toBe(images);
  });
  it('rejects a role identifier that could escape the fixed grant compiler',()=>{
    expect(()=>cashierSecondCardAbandonRuntimeGrantSql('cashier";GRANT ALL TO PUBLIC;--',[])).toThrow();
  });
});

describe('complete historical cashier audit with the separately registered bare manual ORM pair',()=>{
  const manual = [...MANUAL_RED_NOTE_ORM_TABLE_NAMES];
  const current=completeConstructionTableNames('orm');
  const erp=[...ERP_ORM_TABLE_NAMES];
  // The legacy cashier comparison remains the reviewed 286+manual2 scope.
  // Independently commissioned ERP tables are explicit current-only objects.
  const full=current.filter(name=>!erp.some(table=>table===name));
  const mature=full.filter(name=>!manual.some(table=>table===name));
  function catalogRows(present=true):Record<string,unknown>[] {
    return [
      {kind:'table',name:manual[0],present,owned:present,safe:present,fingerprint:present?INVOICE_MANUAL_RED_NOTE_PINS.bareRecord:null},
      {kind:'table',name:manual[1],present,owned:present,safe:present,fingerprint:present?INVOICE_MANUAL_RED_NOTE_PINS.bareReview:null},
      {kind:'function',name:'guard_invoice_manual_red_note',present:false},
      {kind:'function',name:'protect_invoice_manual_red_note',present:false},
    ];
  }
  it('keeps current292 explicit and refuses to waive ERP objects in the historical cashier audit',()=>{
    expect(current).toHaveLength(292); expect(full).toHaveLength(288); expect(mature).toHaveLength(286);
    expect(current.filter(name=>erp.some(table=>table===name))).toEqual(erp);
    expect(current).toEqual([...mature,...manual,...erp].sort());
    expect(()=>assertCashierAbandonHistoricalBasis(current,'orm')).toThrow();
  });
  it.each(['orm','orm_upgrade','orm_default_upgrade','orm_constraints','orm_fk_names','orm_checks','orm_sequences'] as const)
    ('requires the same complete fixed 286-table basis plus both manual tables on %s',path=>{
      expect(assertCashierAbandonHistoricalBasis(full,path)).toEqual({historical:mature,manualTables:manual,actualTables:288});
      expect(()=>assertCashierAuditManualRedNoteCatalog(catalogRows(),path)).not.toThrow();
    });
  it.each(['embedded','external'] as const)('keeps manual maintenance objects absent from %s',path=>{
    const names=path==='external'?[...mature,CASHIER_ABANDON_TABLE].sort():mature;
    expect(assertCashierAbandonHistoricalBasis(names,path).historical).toEqual(names);
    expect(()=>assertCashierAuditManualRedNoteCatalog(catalogRows(false),path)).not.toThrow();
    expect(()=>assertCashierAbandonHistoricalBasis([...names,...manual].sort(),path)).toThrow('exact two');
    expect(()=>assertCashierAuditManualRedNoteCatalog(catalogRows(),path)).toThrow('absent');
  });
  it.each([
    ['missing mature table',full.filter(name=>name!=='user')],
    ['foreign replacement with the same count',full.map(name=>name==='user'?'foreign_same_count':name).sort()],
    ['only one manual table',full.filter(name=>name!==manual[1])],
    ['no manual pair',mature],
    ['unknown extra table',[...full,'unreviewed_extension'].sort()],
    ['duplicate identity',[...full,full[0]].sort()],
  ] as const)('refuses %s before composing any DDL',(_reason,names)=>{
    expect(()=>assertCashierAbandonHistoricalBasis(names,'orm')).toThrow();
  });
  it.each(['changed-column-fingerprint','unsafe-table','foreign-owner','installed-guard','duplicate-object'] as const)
    ('does not waive a changed full manual ORM contract: %s',scenario=>{
      const rows=catalogRows();
      if(scenario==='changed-column-fingerprint')rows[0].fingerprint='0'.repeat(64);
      if(scenario==='unsafe-table')rows[0].safe=false;
      if(scenario==='foreign-owner')rows[0].owned=false;
      if(scenario==='installed-guard')rows[2].present=true;
      if(scenario==='duplicate-object')rows[1]={...rows[0]};
      expect(()=>assertCashierAuditManualRedNoteCatalog(rows,'orm')).toThrow();
    });
  it('retains every raw manual column/index/constraint while removing no historical metadata from the comparison view',()=>{
    const historicalColumn={key:'user.uid',name:'uid',table:'user',type:'integer',notNull:true};
    const manualColumn={key:manual[0]+'.record_json',name:'record_json',table:manual[0],type:'text',notNull:true,default:null,identity:'',generated:'',collation:'pg_catalog.default'};
    const manualIndex={key:manual[1]+'.soimrr_confirmed_red_uq',name:'soimrr_confirmed_red_uq',table:manual[1],definition:"public.store_order_invoice_manual_red_review USING btree (red_document_number) WHERE ((decision)::text = 'confirm'::text)",unique:true,valid:true,ready:true};
    const manualConstraint={key:manual[0]+'.soimrn_json_ck',name:'soimrn_json_ck',table:manual[0],definition:'CHECK (octet_length(record_json) <= 65536)',validated:true};
    const raw:Catalog={tables:[...full,CASHIER_ABANDON_TABLE].sort().map(name=>({key:name,name})),columns:[historicalColumn,manualColumn],indexes:[manualIndex],constraints:[manualConstraint],sequences:[]};
    const before=JSON.stringify(raw),view=reviewedCashierAuditCatalogView(raw,'orm',catalogRows());
    expect(view.historical.tables.map(row=>row.name)).toEqual([...mature,CASHIER_ABANDON_TABLE].sort());
    expect(view.historical.columns).toEqual([historicalColumn]);
    expect(view.manual).toEqual({tables:manual.map(name=>({key:name,name})),columns:[manualColumn],constraints:[manualConstraint],indexes:[manualIndex],sequences:[]});
    expect(JSON.stringify(raw)).toBe(before);
    const changedRows=catalogRows();changedRows[0].fingerprint='0'.repeat(64);
    expect(()=>reviewedCashierAuditCatalogView(raw,'orm',changedRows)).toThrow('column');
    const extra:Catalog={...raw,tables:[...raw.tables,{key:'foreign',name:'foreign'}].sort((a,b)=>a.name.localeCompare(b.name))};
    expect(()=>reviewedCashierAuditCatalogView(extra,'orm',catalogRows())).toThrow();
  });
});
