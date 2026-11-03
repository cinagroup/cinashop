import { describe,expect,it } from 'vitest';
import { routineIdentityAccumulator } from '../scripts/routine-identity-continuation';

const key='61'.repeat(32), secret='owned-authenticator';
const relation={schema:'public',name:'user',oid:'16384',kind:'r'};
const columns=[{name:'uid',oid:23,namespace:'pg_catalog'},{name:'status',oid:21,namespace:'pg_catalog'},
  {name:'is_del',oid:21,namespace:'pg_catalog'},{name:'delete_time',oid:1114,namespace:'pg_catalog'}];
const framed=(row:unknown)=>'71:(0,1):'+JSON.stringify(row);
describe('maintenance identity classifier limits and explicit scope',()=>{
  it('lists missing sources and retains false activation flags even for an empty complete inventory',()=>{
    const report=routineIdentityAccumulator(secret,key).finish([], 'ab'.repeat(32));
    expect(report).toMatchObject({activationAllowed:false,permitIssued:false,switchCommissioned:false,
      inventorySourceDigest:'ab'.repeat(32),paymentEvidence:'not_evaluated',catalogCommissioning:'not_evaluated',
      counts:{owners:0,witnesses:0,routineBindings:0}});
    expect(report.missingSources).toEqual(['routine_identity_ownership','routine_identity_witness','user','wechat_user']);
  });
  it('never adopts a same-named table in another schema',()=>{
    const acc=routineIdentityAccumulator(secret,key), foreign={...relation,schema:'archive'};
    acc.relation(foreign,columns);acc.row(foreign,framed({uid:11,status:1,is_del:0,delete_time:null}));
    const report=acc.finish([{...foreign,rowCount:'1',digest:'ab'.repeat(32)}],'ac'.repeat(32));
    expect(report.counts.users).toBe(0);expect(report.unclassifiedRelationCount).toBe(1);expect(report.missingSources).toContain('user');
  });
  it('does not authenticate legacy unmapped physical bindings or assign their UID an AppID',()=>{
    const acc=routineIdentityAccumulator(secret,key), binding={...relation,name:'wechat_user',oid:'16385'};
    acc.relation(relation,columns);acc.relation(binding,[{name:'id',oid:23,namespace:'pg_catalog'},
      {name:'uid',oid:23,namespace:'pg_catalog'},{name:'openid',oid:1043,namespace:'pg_catalog'},
      {name:'user_type',oid:1043,namespace:'pg_catalog'},{name:'is_del',oid:21,namespace:'pg_catalog'}]);
    acc.row(relation,framed({uid:11,status:1,is_del:0,delete_time:null}));
    acc.row(binding,framed({id:71,uid:11,openid:'owned-old-openid',user_type:'routine',is_del:1}));
    const report=acc.finish([{...relation,rowCount:'1',digest:'aa'.repeat(32)},
      {...binding,rowCount:'1',digest:'bb'.repeat(32)}],'cc'.repeat(32));
    expect(report.counts.bindingStates.unmapped).toBe(1);expect(report.bindings[0]).toMatchObject({state:'unmapped',live:false});
    expect(report.accounts).toEqual([]);expect(JSON.stringify(report)).not.toContain('owned-old-openid');
  });
  it('rejects a missing/wrong built-in column type and a partition root',()=>{
    for(const actual of [columns.slice(1),columns.map(c=>c.name==='uid'?{...c,namespace:'public'}:c)])
      expect(()=>routineIdentityAccumulator(secret,key).relation(relation,actual)).toThrow('draft incomplete');
    expect(()=>routineIdentityAccumulator(secret,key).relation({...relation,kind:'p'},columns)).toThrow('draft incomplete');
  });
  it('refuses retention overflow rather than returning a successful prefix',()=>{
    const acc=routineIdentityAccumulator(secret,key);acc.relation(relation,columns);
    expect(()=>{for(let uid=1;uid<=16385;uid++)acc.row(relation,framed({uid,status:1,is_del:0,delete_time:null}));}).toThrow('draft incomplete');
  });
  it('requires a separate bounded record authenticator',()=>{
    for(const invalid of ['',key,'x'.repeat(4097)])expect(()=>routineIdentityAccumulator(invalid,key)).toThrow('draft incomplete');
  });
});
