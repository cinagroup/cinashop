import {describe,expect,it,vi} from 'vitest';
import type {DbClient} from '../src/lib/di';
import {inspectCashierSecondCardAbandon,cashierSecondCardAbandonBaseReadiness,cashierSecondCardAbandonReadiness,
  assertCashierSecondCardAbandonReads,installCashierSecondCardAbandon} from '../src/migrations/runCashierSecondCardAbandon';
import {assertCashierNotAbandoned,readCashierAbandonment} from '../src/services/customer-work/CustomerCashierAbandon';
import {cashierSecondCardAbandonRuntimePrivilegePlan,cashierSecondCardAbandonRuntimeGrantSql} from '../src/migrations/cashierSecondCardAbandonRuntimePlan';

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
