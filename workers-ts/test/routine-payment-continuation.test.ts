import { describe,expect,it } from 'vitest';
import { routinePaymentAccumulator } from '../scripts/routine-payment-continuation';

const key='71'.repeat(32),secret='owned-payment-diagnostic-key';
const source={schema:'public',name:'user_recharge',oid:'16384',kind:'r',owner:'owned_maintenance',ownerOid:'10'};
const columns=Object.entries({id:23,uid:23,order_id:1043,paid:21,trade_no:1043,price:1700,recharge_type:1043})
  .map(([name,oid])=>({name,oid,namespace:'pg_catalog'}));
const context={database:'owned_database',databaseOid:'16383',observedAt:1800000000};
function accumulator(){const acc=routinePaymentAccumulator(secret,key);acc.context(context);return acc;}
const frame=(row:unknown)=>'71:(0,1):'+JSON.stringify(row);
const finish=(acc:ReturnType<typeof accumulator>)=>acc.finish([{...source,rowCount:'1',digest:'ab'.repeat(32)}],'cd'.repeat(32));
const order={id:41,uid:11,order_id:'owned_order',paid:0,trade_no:'',price:'12.34',recharge_type:''};

describe('bounded diagnostic payment classifier',()=>{
  it('retains false permissions and missing roots for an empty complete inventory',()=>{
    const report=accumulator().finish([],'ab'.repeat(32));
    expect(report).toMatchObject({activationAllowed:false,permitIssued:false,switchCommissioned:false,refundRequestAuthorized:false,
      shippingUploadAuthorized:false,subscriptionSendAuthorized:false,credentials:'not_evaluated',catalogCommissioning:'not_evaluated',
      counts:{originals:0,uses:0,policies:0,localOrders:0}});expect(report.missingSources).toHaveLength(9);
  });
  it('classifies no same-named source outside public',()=>{
    const acc=accumulator(),foreign={...source,schema:'archive'};acc.relation(foreign,columns);acc.row(foreign,frame(order));
    const report=acc.finish([{...foreign,rowCount:'1',digest:'ab'.repeat(32)}],'cd'.repeat(32));
    expect(report.counts.localOrders).toBe(0);expect(report.unclassifiedRelationCount).toBe(1);
  });
  it('refuses missing or custom column types, duplicate sources and partition roots',()=>{
    for(const actual of [columns.slice(1),columns.map(c=>c.name==='id'?{...c,namespace:'public'}:c)])
      expect(()=>accumulator().relation(source,actual)).toThrow('draft incomplete');
    expect(()=>accumulator().relation({...source,kind:'p'},columns)).toThrow('draft incomplete');
    const acc=accumulator();acc.relation(source,columns);expect(()=>acc.relation(source,columns)).toThrow('draft incomplete');
  });
  it('retains exact numeric tokens instead of converting an imprecise decimal to a valid payment',()=>{
    const acc=accumulator();acc.relation(source,columns);
    acc.row(source,'71:(0,1):'+JSON.stringify({...order,price:undefined}).replace(/}$/,',"price":12.34000000000000000000000000001}'));
    expect(finish(acc).localOrders[0].state).toBe('invalid');
  });
  it.each(['0','-1.00','21474836.48','NaN','1.001'])('refuses invalid or out-of-range cents %s',(price)=>{
    const acc=accumulator();acc.relation(source,columns);acc.row(source,frame({...order,price}));
    expect(finish(acc).localOrders[0].state).toBe('invalid');
  });
  it('keeps a physical old paid row without evidence unproven and hides its identifiers',()=>{
    const acc=accumulator();acc.relation(source,columns);acc.row(source,frame({...order,paid:1,recharge_type:'weixin',trade_no:'owned_trade'}));
    const report=finish(acc);expect(report.localOrders[0]).toMatchObject({state:'no_authenticated_original',paid:true});
    for(const raw of ['owned_order','owned_trade',secret,key])expect(JSON.stringify(report)).not.toContain(raw);
  });
  it('reports invalid original and orphan use rows without erasing either',()=>{
    const acc=accumulator();
    for(const [name,layout,row] of [
      ['routine_original_payment_evidence',{evidence_id:1043,order_no:1043,transaction_id:1043,source:1043,source_id:1043,format_version:21,payload:3802,created_at:20,signature:1043},{evidence_id:'bad-original',order_no:'owned_order'}],
      ['routine_payment_account_use',{use_id:1043,evidence_id:1043,payload:3802,created_at:20,signature:1043},{use_id:'orphan-use',evidence_id:'absent'}],
    ] as const){const s={...source,name};acc.relation(s,Object.entries(layout).map(([name,oid])=>({name,oid,namespace:'pg_catalog'})));acc.row(s,frame(row));}
    const report=acc.finish([],'ab'.repeat(32));expect(report.originals[0]).toMatchObject({authenticity:'invalid',binding:'invalid'});
    expect(report.uses[0].authenticity).toBe('original_missing');
  });
  it('refuses retention overflow rather than returning a successful prefix',()=>{
    const acc=accumulator();acc.relation(source,columns);
    expect(()=>{for(let id=1;id<=16385;id++)acc.row(source,frame({...order,id}));}).toThrow('draft incomplete');
  });
  it('requires a distinct bounded authenticator and a single snapshot context',()=>{
    for(const invalid of ['',key,'x'.repeat(4097)])expect(()=>routinePaymentAccumulator(invalid,key)).toThrow('draft incomplete');
    const acc=accumulator();expect(()=>acc.context(context)).toThrow('draft incomplete');
    expect(()=>routinePaymentAccumulator(secret,key).finish([],'ab'.repeat(32))).toThrow('draft incomplete');
  });
});
