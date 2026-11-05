import {createHash} from 'node:crypto';
import {closeSync,openSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe,expect,it} from 'vitest';
import {membershipContractSourceContinuity as old,projectMembershipHistoricalSource as originalProject} from './helpers/membershipContractSourceContinuity';
import {RECHARGE_SOURCE_PROOF_FILE,RECHARGE_SOURCE_PROOF_SHA,rechargeNoticeSourceContinuity as proof,
 projectRechargeNoticePredecessor,projectMembershipHistoricalSource,readRechargeNoticePredecessorFile,
 readMembershipContinuityHistoricalFile,type RechargeHistoryImage} from './helpers/rechargeNoticeSourceContinuity';
const root=resolve(import.meta.dirname,'../..');
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const image=(s:string):RechargeHistoryImage=>({bytes:Buffer.byteLength(s),sha256:sha(s),gitBlobSha1:createHash('sha1').update('blob '+Buffer.byteLength(s)+'\0').update(s).digest('hex')});
const actual=(f:string)=>readFileSync(resolve(root,f),'utf8');
describe('actual recharge successor and strict 7e41 historical source boundary',()=>{
 it('binds four business changes, the payload schema and provider type, runner, committed D3 inputs and five explicit reader imports, and unchanged older proofs',()=>{
  expect(sha(readFileSync(resolve(root,RECHARGE_SOURCE_PROOF_FILE)))).toBe(RECHARGE_SOURCE_PROOF_SHA);
  expect(proof.predecessorCommit).toBe('7e41a20eb64c99491847fab136a5890721689654');
  expect(proof.sources.filter(r=>r.kind==='business').map(r=>r.file)).toEqual([
   'workers-ts/src/models/schema/order_outbox.ts','workers-ts/src/services/payment/PaymentCallbackEventService.ts',
   'workers-ts/src/services/payment/PaymentReconciliationService.ts','workers-ts/src/services/payment/RechargePaymentService.ts']);
  expect(proof.sources.filter(r=>r.kind==='validation-runner').map(r=>r.file)).toEqual(['workers-ts/scripts/run-local-finance-postgres.mjs']);
  expect(proof.sources.filter(r=>r.kind==='delivery-payload-schema').map(r=>r.file)).toEqual(['workers-ts/src/models/schema/notification_delivery.ts']);
  expect(proof.sources.filter(r=>r.kind==='delivery-provider-type').map(r=>r.file)).toEqual(['workers-ts/src/services/wechat/WechatNotificationProvider.ts']);
  expect(proof.integrationBaseCommit).toBe('0ecb7405a541722244c9a2acb4f109ce492db340');
  expect(proof.sources.filter(r=>r.kind==='committed-advisory-review').map(r=>r.file)).toEqual(['view/uniapp-ts/scripts/d3-advisory-gate.baseline.json','view/uniapp-ts/scripts/d3-advisory-gate.test.cjs','view/uniapp-ts/scripts/d3-transitive-chain-audit.md']);
  expect(proof.sources.filter(r=>r.kind==='historical-reader-wiring')).toHaveLength(5);
  for(const row of proof.sources){
   const current=actual(row.file),previous=projectRechargeNoticePredecessor(row.file,current);
   expect(image(current)).toEqual(row.current);expect(image(previous)).toEqual(row.predecessor);expect(previous).not.toBe(current);
   expect(row.origin).toEqual({commit:proof.predecessorCommit,path:row.file,gitBlobSha1:row.predecessor.gitBlobSha1});
  }
  for(const row of proof.preserved){const bytes=readFileSync(resolve(root,row.file));expect(bytes.length).toBe(row.bytes);expect(sha(bytes)).toBe(row.sha256);}
  expect(proof.preserved.some(r=>r.file==='workers-ts/test/helpers/membershipContractSourceContinuity.ts')).toBe(true);
 });
 it('presents exactly the original 43+4 full inputs to the unchanged membership leaf, while native disk retains current recharge source',()=>{
  for(const row of [...old.sources,...old.wiring]){
   const current=actual(row.file),previous=projectRechargeNoticePredecessor(row.file,current);
   expect(image(previous)).toEqual(row.current);
   const historical=projectMembershipHistoricalSource(row.file,current);
   expect(image(historical)).toEqual(row.historical);
   expect(originalProject(row.file,previous)).toBe(historical);
  }
  const business=proof.sources.filter(r=>r.kind==='business');expect(business).toHaveLength(4);
  for(const row of business){const current=actual(row.file);expect(current).not.toBe(readRechargeNoticePredecessorFile(resolve(root,row.file),'utf8'));}
 });
 it.each(['prefix','suffix','CRLF','same-size edit','old complete source'] as const)('rejects %s for every complete selected image',kind=>{
  for(const row of proof.sources){
   const current=actual(row.file),previous=projectRechargeNoticePredecessor(row.file,current);
   const changed=kind==='prefix'?'// unknown\n'+current:kind==='suffix'?current+'\n// unknown\n':kind==='CRLF'?current.replace(/\n/g,'\r\n')
    :kind==='same-size edit'?(current[0]==='X'?'Y':'X')+current.slice(1):previous;
   expect(changed).not.toBe(current);expect(()=>projectRechargeNoticePredecessor(row.file,changed)).toThrow('complete current source differs');
   expect(()=>projectMembershipHistoricalSource(row.file,changed)).toThrow('complete current source differs');
  }
 });
 it('leaves the entire old membership test assertion body reconstructable rather than changing its expected source hashes',()=>{
  const file='workers-ts/test/membership-contract-source-continuity.test.ts',before=projectRechargeNoticePredecessor(file,actual(file));
  expect(before).toContain("describe('closed current membership contract source continuity before dated proofs'");
  expect(before).toContain("import { closeSync, openSync, readFileSync } from 'node:fs';");
  const row=proof.sources.find(r=>r.file===file)!;expect(image(before)).toEqual(row.predecessor);
  expect(actual(file)).toContain("describe('dated 7e41 membership contract source continuity before older proofs'");
  const assertions=(s:string)=>s.slice(s.indexOf("  it('pins the independent complete proof"));expect(assertions(actual(file))).toBe(assertions(before));
 });
 it('preserves UTF8, Buffer, URL, byte path, native descriptors and unrelated reads without a global filesystem mock',()=>{
  const row=proof.sources[0]!,name=resolve(root,row.file),current=actual(row.file),before=projectRechargeNoticePredecessor(row.file,current);
  const historical=originalProject(row.file,before);
  for(const p of [name,pathToFileURL(name),Buffer.from(name)]){
   expect(readRechargeNoticePredecessorFile(p,'utf8')).toBe(before);expect(readRechargeNoticePredecessorFile(p)).toEqual(Buffer.from(before));
   expect(readMembershipContinuityHistoricalFile(p,'utf8')).toBe(historical);expect(readMembershipContinuityHistoricalFile(p)).toEqual(Buffer.from(historical));
  }
  expect(()=>readRechargeNoticePredecessorFile(name,'ascii')).toThrow('requires exact UTF8 or bytes');
  expect(()=>readMembershipContinuityHistoricalFile(name,'latin1')).toThrow('requires exact UTF8 or bytes');
  for(const read of [readRechargeNoticePredecessorFile,readMembershipContinuityHistoricalFile]){const fd=openSync(name,'r');try{expect(read(fd,'utf8')).toBe(current);}finally{closeSync(fd);}}
  const unrelated=resolve(root,'workers-ts/tsconfig.json');expect(readRechargeNoticePredecessorFile(unrelated)).toEqual(readFileSync(unrelated));
  expect(projectRechargeNoticePredecessor('unrelated.ts','native bytes')).toBe('native bytes');
  expect(()=>readRechargeNoticePredecessorFile(resolve(root,'.missing-recharge-continuity'))).toThrow();
 });
 it.each(['current hash','predecessor hash','bytes','blob','path','origin','edit range','literal','anchor','overlap','preserved proof','unknown field'] as const)(
  'rejects forged %s metadata before producing a source view',kind=>{
   const p=structuredClone(proof),r=p.sources[0]!,e=r.inverseEdits[0]!;
   if(kind==='current hash')r.current.sha256='0'.repeat(64);if(kind==='predecessor hash')r.predecessor.sha256='0'.repeat(64);if(kind==='bytes')r.current.bytes++;
   if(kind==='blob')r.predecessor.gitBlobSha1='0'.repeat(40);if(kind==='path')r.file+='.other';if(kind==='origin')r.origin.commit='0'.repeat(40);
   if(kind==='edit range')e.start++;if(kind==='literal')e.after.push('// unreviewed\n');if(kind==='anchor')e.anchor[0]+='// unreviewed\n';
   if(kind==='overlap')r.inverseEdits.push(structuredClone(e));if(kind==='preserved proof')p.preserved[0]!.sha256='0'.repeat(64);if(kind==='unknown field')Object.assign(p,{unknown:true});
   expect(()=>projectRechargeNoticePredecessor(proof.sources[0]!.file,actual(proof.sources[0]!.file),p)).toThrow('complete proof differs');
  });
});
