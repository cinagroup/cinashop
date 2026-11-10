import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,mkdtempSync,openSync,readFileSync as readNativeFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL,URL} from 'node:url';
import {describe,expect,it} from 'vitest';
import * as recharge from './helpers/rechargeNoticeSourceContinuity';
import * as membership from './helpers/membershipContractSourceContinuity';
import {projectProviderTransportPredecessor} from './helpers/providerTransportSourceContinuity';
import {RECHARGE_REFUND_SOURCE_PROOF_FILE,RECHARGE_REFUND_SOURCE_PROOF_SHA,rechargeRefundSourceContinuity as proof,
 projectRechargeRefundPredecessor,peelMembershipHistoricalSourceIfPresent,readRechargeRefundPredecessorFile,
 readRechargeNoticePredecessorFile,readMembershipContinuityHistoricalFile,type RechargeRefundHistoryImage} from './helpers/rechargeRefundSourceContinuity';

const root=resolve(import.meta.dirname,'../..');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const image=(value:string|Uint8Array):RechargeRefundHistoryImage=>({bytes:Buffer.byteLength(value),sha256:sha(value),
 gitBlobSha1:createHash('sha1').update('blob '+Buffer.byteLength(value)+'\0').update(value).digest('hex')});
// The dated v10 image is fixed353 after the complete reviewed CI transport bridge.
const physical=(file:string)=>projectProviderTransportPredecessor(file,readNativeFileSync(resolve(root,file),'utf8'));
const origin=(file:string)=>execFileSync('git',['cat-file','blob',proof.predecessorCommit+':'+file],{cwd:root,encoding:'utf8'});

describe('dated refund physical sources reverse exactly to fixed78240 before unchanged historical leaves',()=>{
 it('pins the explicit v10 notice consumer successor with complete47rows,40feature sources,7reader ports and its preserved physical v9 parent and exact v8/v7/v6/v5/v4/v3/v2/v1 ancestors',()=>{
  expect(sha(readNativeFileSync(resolve(root,RECHARGE_REFUND_SOURCE_PROOF_FILE)))).toBe(RECHARGE_REFUND_SOURCE_PROOF_SHA);
  expect(proof.predecessorCommit).toBe('78240b7801a617ed5b1c1e444860228c066311b8');
  expect(proof.sources).toHaveLength(47);expect(new Set(proof.sources.map(row=>row.file)).size).toBe(47);
  expect(proof.sources.filter(row=>row.kind==='feature-source')).toHaveLength(40);
  expect(proof.schema).toBe('recharge-refund-source-continuity/v10');
  expect(proof.priorProof).toMatchObject({file:'workers-ts/test/fixtures/recharge-refund-callback-http-source-continuity-20261109.json',
   sha256:'702d22cb0c986a0aa43bd77951f61ca19e296be4a7cef39ddb888b76908ae3a9',
   updatedSources:["workers-ts/scripts/run-local-finance-postgres.mjs","workers-ts/src/env.ts","workers-ts/src/index.ts","workers-ts/src/services/order/OrderOutboxService.ts","workers-ts/src/services/order/OrderNotificationDeliveryService.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec.ts","workers-ts/src/services/wechat/RoutineSubscriptionNoticeKinds.ts","workers-ts/src/services/wechat/RoutineSubscriptionRechargeRequest.ts","workers-ts/src/services/wechat/RoutineSubscriptionDeliveryNotice.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatch.ts","workers-ts/src/services/wechat/RoutineSubscriptionRequestEvidenceCodec.ts","workers-ts/scripts/routine-notification-continuation.ts","workers-ts/src/services/order/OrderQueueDeadLetterService.ts","workers-ts/src/services/wechat/RoutineSubscriptionAccessToken.ts","workers-ts/src/services/wechat/RoutineSubscriptionProvider.ts"]});
  const priorRaw=readNativeFileSync(resolve(root,proof.priorProof.file));expect(sha(priorRaw)).toBe(proof.priorProof.sha256);
  const prior=JSON.parse(priorRaw.toString()) as typeof proof;expect(prior.schema).toBe('recharge-refund-source-continuity/v9');
  const v8Raw=readNativeFileSync(resolve(root,prior.priorProof.file));expect(sha(v8Raw)).toBe(prior.priorProof.sha256);
  expect(sha(v8Raw)).toBe('f786143d31046a6820b2a99f9f44839e3c23b801dc6fdd12c717f5e0b72391e4');
  const v8=JSON.parse(v8Raw.toString())as typeof proof;expect(v8.schema).toBe('recharge-refund-source-continuity/v8');
  const v7Raw=readNativeFileSync(resolve(root,v8.priorProof.file));expect(sha(v7Raw)).toBe(v8.priorProof.sha256);
  expect(sha(v7Raw)).toBe('9e36eee479443be268d30a261741f0cf36a10f7493df3f6fc7de4a724545dfaf');
  const v7=JSON.parse(v7Raw.toString())as typeof proof;expect(v7.schema).toBe('recharge-refund-source-continuity/v7');
  const v6Raw=readNativeFileSync(resolve(root,v7.priorProof.file));expect(sha(v6Raw)).toBe(v7.priorProof.sha256);
  expect(sha(v6Raw)).toBe('5f228fadf2d1c41e5e0fae415562829364414ea5d8a063bd38a148e8557168c4');
  const v6=JSON.parse(v6Raw.toString())as typeof proof;expect(v6.schema).toBe('recharge-refund-source-continuity/v6');
  const v5Raw=readNativeFileSync(resolve(root,v6.priorProof.file));expect(sha(v5Raw)).toBe(v6.priorProof.sha256);
  expect(sha(v5Raw)).toBe('2f93be012b6e19cf009e7da91d9abb7889852713e83d692d8f9614276a421aa6');
  const v5=JSON.parse(v5Raw.toString())as typeof proof;expect(v5.schema).toBe('recharge-refund-source-continuity/v5');
  const v4Raw=readNativeFileSync(resolve(root,v5.priorProof.file));expect(sha(v4Raw)).toBe(v5.priorProof.sha256);
  expect(sha(v4Raw)).toBe('5173c5c64c4781e93830195d9c7517d07fee813b6261be57df72d4aa066dd473');
  const v4=JSON.parse(v4Raw.toString())as typeof proof;expect(v4.schema).toBe('recharge-refund-source-continuity/v4');
  expect(prior.sources.filter(row=>!prior.priorProof.updatedSources.includes(row.file))).toEqual(v8.sources.filter(row=>!prior.priorProof.updatedSources.includes(row.file)));expect(v8.sources.slice(1)).toEqual(v7.sources.slice(1));expect(v7.sources.slice(1)).toEqual(v6.sources.slice(1));expect(v6.sources.slice(1)).toEqual(v5.sources.slice(1));expect(v5.sources.slice(1)).toEqual(v4.sources.slice(1));
  const v3Raw=readNativeFileSync(resolve(root,v4.priorProof.file));expect(sha(v3Raw)).toBe(v4.priorProof.sha256);
  expect(sha(v3Raw)).toBe('adf570f96a4283154cac18141208fe71d6b9699a926262769ed987a2ff36f0d0');
  const v3=JSON.parse(v3Raw.toString())as typeof proof;expect(v3.schema).toBe('recharge-refund-source-continuity/v3');
  const v2Raw=readNativeFileSync(resolve(root,v3.priorProof.file));expect(sha(v2Raw)).toBe(v3.priorProof.sha256);
  expect(sha(v2Raw)).toBe('f9fd32f0fb94085336b4144abc5ee43f8f7e887e764ffe66f641c926404cc44e');
  const v2=JSON.parse(v2Raw.toString())as typeof proof;expect(v2.schema).toBe('recharge-refund-source-continuity/v2');
  const ancestorRaw=readNativeFileSync(resolve(root,v2.priorProof.file));expect(sha(ancestorRaw)).toBe(v2.priorProof.sha256);
  expect(sha(ancestorRaw)).toBe('ba9345a4e12e60f260966d068e38de9b1d93a98ba59f78f4fc942f81242ee79c');
  const ancestor=JSON.parse(ancestorRaw.toString())as typeof proof;expect(ancestor.schema).toBe('recharge-refund-source-continuity/v1');
  expect(proof.sources.filter(row=>!prior.sources.some(p=>p.file===row.file)).map(r=>r.file)).toEqual(["workers-ts/src/services/order/OrderNotificationDeliveryService.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec.ts","workers-ts/src/services/wechat/RoutineSubscriptionNoticeKinds.ts","workers-ts/src/services/wechat/RoutineSubscriptionRechargeRequest.ts","workers-ts/src/services/wechat/RoutineSubscriptionDeliveryNotice.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatch.ts","workers-ts/src/services/wechat/RoutineSubscriptionRequestEvidenceCodec.ts","workers-ts/scripts/routine-notification-continuation.ts","workers-ts/src/services/order/OrderQueueDeadLetterService.ts","workers-ts/src/services/wechat/RoutineSubscriptionAccessToken.ts","workers-ts/src/services/wechat/RoutineSubscriptionProvider.ts"]);
  expect(v4.sources.filter(row=>!v3.sources.some(p=>p.file===row.file)).map(r=>r.file)).toEqual(['workers-ts/src/env.ts','workers-ts/src/index.ts']);
  for(const row of proof.sources){const parent=prior.sources.find(old=>old.file===row.file);
   if(!parent){expect(["workers-ts/src/services/order/OrderNotificationDeliveryService.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec.ts","workers-ts/src/services/wechat/RoutineSubscriptionNoticeKinds.ts","workers-ts/src/services/wechat/RoutineSubscriptionRechargeRequest.ts","workers-ts/src/services/wechat/RoutineSubscriptionDeliveryNotice.ts","workers-ts/src/services/wechat/RoutineSubscriptionDispatch.ts","workers-ts/src/services/wechat/RoutineSubscriptionRequestEvidenceCodec.ts","workers-ts/scripts/routine-notification-continuation.ts","workers-ts/src/services/order/OrderQueueDeadLetterService.ts","workers-ts/src/services/wechat/RoutineSubscriptionAccessToken.ts","workers-ts/src/services/wechat/RoutineSubscriptionProvider.ts"]).toContain(row.file);continue;}
   expect(row.predecessor).toEqual(parent.predecessor);expect(row.origin).toEqual(parent.origin);
   if(proof.priorProof.updatedSources.includes(row.file))expect(row.current).not.toEqual(parent.current);else expect(row).toEqual(parent);
  }
  expect(proof.preserved).toEqual(prior.preserved);
  expect(proof.sources.filter(row=>row.kind==='historical-reader-wiring').map(row=>row.file)).toEqual([
   'workers-ts/test/helpers/postMergeSourceBinding.ts','workers-ts/test/helpers/reviewedRouteTailSourceBinding.ts',
   'workers-ts/test/post-merge-source-binding.test.ts','workers-ts/test/membership-contract-source-continuity.test.ts',
   'workers-ts/test/recharge-notice-source-continuity.test.ts','workers-ts/test/reviewed-admin-source-tail-binding.test.ts',
   'workers-ts/test/legacy-php-input-source-binding.test.ts']);
  for(const file of[RECHARGE_REFUND_SOURCE_PROOF_FILE,proof.priorProof.file,'workers-ts/test/helpers/rechargeRefundSourceContinuity.ts',
   'workers-ts/test/recharge-refund-source-continuity.test.ts'])expect(proof.sources.some(row=>row.file===file)).toBe(false);
  expect(proof.inputProvenance.every(row=>row.acceptedByThisProof===false)).toBe(true);
  const runner=proof.sources.find(row=>row.file==='workers-ts/scripts/run-local-finance-postgres.mjs')!;
  const currentRunner=physical(runner.file),v9Runner=currentRunner.replaceAll("    'test/recharge-refund-notice-consumer-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-notice-consumer-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v9Runner)).toBe(prior.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v8Runner=v9Runner.replaceAll("    'test/recharge-refund-callback-http-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-callback-http-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v8Runner)).toBe(v8.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v7Runner=v8Runner.replaceAll("    'test/recharge-refund-counted-first-economic-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-counted-first-economic-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v7Runner)).toBe(v7.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v6Runner=v7Runner.replaceAll("    'test/recharge-refund-mixed-recovery-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-mixed-recovery-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v6Runner)).toBe(v6.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v5Runner=v6Runner.replaceAll("    'test/recharge-refund-callback-economic-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-callback-economic-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v5Runner)).toBe(v5.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v4Runner=v5Runner.replaceAll("    'test/recharge-refund-callback-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-callback-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v4Runner)).toBe(v4.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v3Runner=v4Runner.replaceAll("    'test/recharge-refund-recovery-queue-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-recovery-queue-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v3Runner)).toBe(v3.sources.find(row=>row.file===runner.file)!.current.sha256);
  const v2Runner=v3Runner.replaceAll("    'test/admin-recharge-refund-http-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/admin-recharge-refund-http-native.test.ts',\n")).toHaveLength(3);
  expect(sha(v2Runner)).toBe(v2.sources.find(row=>row.file===runner.file)!.current.sha256);
  expect(sha(v2Runner)).toBe('2e7bc5c1af066309a7f0a47eeb7050a7cd23126027a70696f5b1e56ef12a34a0');
  const priorRunner=v2Runner.replaceAll("    'test/recharge-refund-query-provider-native.test.ts',\n",'');
  expect(currentRunner.split("    'test/recharge-refund-query-provider-native.test.ts',\n")).toHaveLength(3);
  expect(sha(priorRunner)).toBe(ancestor.sources.find(row=>row.file===runner.file)!.current.sha256);
  expect(sha(priorRunner)).toBe('67109cc59ef650477549a8b0377a54ecc4d6240f9877acdd1025c3438c523fcb');
  const providerFile='workers-ts/src/services/wechat/WechatPayService.ts',provider=physical(providerFile);
  expect(image(provider)).toEqual(prior.sources.find(row=>row.file===providerFile)!.current);
  const newMethods='  /** Exactly one GET handoff, consumed before RSA/fetch. No SQL is open. */\n';
  const oldRoutine='  /** Historical Routine uses one authenticated first dispatch, never current\n';
  const newPrivate='\n/** Query-only private verifier entries. No caller rows/JSON can mint these. */\n';
  expect(provider.split(newMethods)).toHaveLength(2);expect(provider.split(oldRoutine)).toHaveLength(2);expect(provider.split(newPrivate)).toHaveLength(2);
  let priorProvider=provider.slice(0,provider.indexOf(newPrivate));
  priorProvider=priorProvider.slice(0,priorProvider.indexOf(newMethods))+priorProvider.slice(priorProvider.indexOf(oldRoutine));
  const imports="import { assertRechargeRefundRuntimeTx,type RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';\n"
   +"import { consumeRechargeRefundQuery,type PreparedRechargeRefundQuery } from '@/services/payment/RechargeRefundQueryClaim';\n"
   +"import { parseRechargeRefundQueryResult,type RechargeRefundQueryAttempt,type RechargeRefundQueryProviderStatus } from '@/services/payment/RechargeRefundQueryCodec';\n"
   +"import { readRechargeRefundQueryAttemptTx } from '@/services/payment/RechargeRefundQueryHistory';\n";
  expect(priorProvider.split(imports)).toHaveLength(2);
  priorProvider=priorProvider.replace(imports,"import { assertRechargeRefundRuntimeTx } from '@/migrations/rechargeRefund';\n");
  expect(sha(priorProvider)).toBe(ancestor.sources.find(row=>row.file===providerFile)!.current.sha256);
  expect(sha(priorProvider)).toBe('c8f10f1695eb11d25c5a5466fcf14dc5a4f9218a94a6c4fc45a887a81d85600c');
  expect(proof.sources.find(row=>row.file==='workers-ts/src/services/order/OrderOutboxService.ts')!.current.sha256)
   .toBe('2edbf668cba6ac99dae579157efac64f190c74b987201824e3bc4d955d906522');
  expect(proof.checkoutTypeBridge).toMatchObject({impactObservationSha256:'c1bd0444355b4147d40d0511019a7b1c423d430cb11a3ff91dc399b29e7a19a0',
   selectedSource30dSha256:'45a2953d8a4b361b1b5fa1b6e1c18d7f890037c93c247d95d0d62d862d54a636',runtimeAcceptance:false});
 });
 for(const row of proof.sources)it('authenticates actual complete bytes and reconstructs exact Git origin: '+row.file,()=>{
  const actual=physical(row.file),before=projectRechargeRefundPredecessor(row.file,actual);
  expect(image(actual)).toEqual(row.current);expect(image(before)).toEqual(row.predecessor);
  expect(before).toBe(origin(row.file));expect(before).not.toBe(actual);
  expect(row.origin).toEqual({commit:proof.predecessorCommit,path:row.file,gitBlobSha1:row.predecessor.gitBlobSha1});
  expect(readRechargeRefundPredecessorFile(resolve(root,row.file),'utf8')).toBe(before);
 });
 it('keeps all nine old proof and leaf artifacts as native physical bytes without rewriting their hashes',()=>{
  expect(proof.preserved).toHaveLength(9);
  for(const row of proof.preserved){const bytes=readNativeFileSync(resolve(root,row.file));
   expect(image(bytes)).toEqual({bytes:row.bytes,sha256:row.sha256,gitBlobSha1:row.gitBlobSha1});
   expect(row.origin).toEqual({commit:proof.predecessorCommit,path:row.file,gitBlobSha1:row.gitBlobSha1});
   const viewed=readRechargeRefundPredecessorFile(resolve(root,row.file));
   expect(Buffer.isBuffer(viewed)).toBe(true);expect(Buffer.compare(viewed,bytes)).toBe(0);
  }
 });
 it('feeds every original15 recharge and43+4 membership full image to unchanged pure projectors',()=>{
  expect(recharge.rechargeNoticeSourceContinuity.sources).toHaveLength(15);
  for(const row of recharge.rechargeNoticeSourceContinuity.sources){
   const fixed=readRechargeRefundPredecessorFile(resolve(root,row.file),'utf8');expect(image(fixed)).toEqual(row.current);
   const prior=recharge.projectRechargeNoticePredecessor(row.file,fixed);
   expect(image(prior)).toEqual(row.predecessor);expect(readRechargeNoticePredecessorFile(resolve(root,row.file),'utf8')).toBe(prior);
  }
  const old=membership.membershipContractSourceContinuity;expect(old.sources).toHaveLength(43);expect(old.wiring).toHaveLength(4);
  for(const row of[...old.sources,...old.wiring]){
   const prior=readRechargeNoticePredecessorFile(resolve(root,row.file),'utf8');expect(image(prior)).toEqual(row.current);
   const historical=membership.projectMembershipHistoricalSource(row.file,prior);expect(image(historical)).toEqual(row.historical);
   expect(readMembershipContinuityHistoricalFile(resolve(root,row.file),'utf8')).toBe(historical);
  }
 });
 for(const kind of['prefix','suffix','CRLF','same-size edit','duplicate full source','old complete source']as const)
  it('rejects '+kind+' for all33 selected physical images, without old-complete fallback',()=>{
   for(const row of proof.sources){
    const actual=physical(row.file),before=projectRechargeRefundPredecessor(row.file,actual);
    const changed=kind==='prefix'?'// unknown\n'+actual:kind==='suffix'?actual+'\n// unknown\n':kind==='CRLF'?actual.replace(/\n/g,'\r\n')
     :kind==='same-size edit'?(actual[0]==='X'?'Y':'X')+actual.slice(1):kind==='duplicate full source'?actual+actual:before;
    expect(changed).not.toBe(actual);expect(()=>projectRechargeRefundPredecessor(row.file,changed)).toThrow('complete current source differs');
   }
  });
 it('peels only an exact new complete image before the old leaves validate their own derived image',()=>{
  const row=proof.sources.find(row=>row.file==='workers-ts/src/models/schema/order_outbox.ts')!,actual=physical(row.file);
  const fixed=projectRechargeRefundPredecessor(row.file,actual),expected=recharge.peelMembershipHistoricalSourceIfPresent(row.file,fixed);
  expect(peelMembershipHistoricalSourceIfPresent(row.file,actual)).toBe(expected);
  expect(peelMembershipHistoricalSourceIfPresent(row.file,fixed)).toBe(expected);
  expect(peelMembershipHistoricalSourceIfPresent(row.file,expected)).toBe(expected);
  const changed=actual+'// unknown\n';expect(peelMembershipHistoricalSourceIfPresent(row.file,changed)).toBe(changed);
  expect(()=>recharge.projectMembershipHistoricalSource(row.file,changed)).toThrow('complete current source differs');
  expect(()=>projectRechargeRefundPredecessor(row.file,fixed)).toThrow('complete current source differs');
  expect(()=>projectRechargeRefundPredecessor('unlisted.ts',actual)).toThrow('selected source absent');
 });
 it('preserves UTF8, Buffer, URL and byte-path views, while native descriptor output stays physical',()=>{
  const row=proof.sources.find(row=>row.file==='workers-ts/src/models/schema/order_outbox.ts')!,name=resolve(root,row.file);
  const actual=readNativeFileSync(name,'utf8'),fixed=projectRechargeRefundPredecessor(row.file,actual);
  expect(actual).not.toBe(fixed);
  const views=[
   [readRechargeRefundPredecessorFile,fixed],
   [readRechargeNoticePredecessorFile,recharge.projectRechargeNoticePredecessor(row.file,fixed)],
   [readMembershipContinuityHistoricalFile,recharge.projectMembershipHistoricalSource(row.file,fixed)],
  ]as const;
  for(const[read,expected]of views){
   for(const path of[name,pathToFileURL(name),Buffer.from(name)]){
    expect(read(path,'utf8')).toBe(expected);expect(read(path,{encoding:'utf-8'})).toBe(expected);
    expect(read(path)).toEqual(Buffer.from(expected));expect(read(path,{encoding:null})).toEqual(Buffer.from(expected));
   }
   for(const encoding of['ascii','latin1','utf16le','base64','hex']as const)
    expect(()=>read(name,encoding)).toThrow('requires exact UTF8 or bytes');
   for(const encoding of[undefined,'utf8','ascii']as const){const fd=openSync(name,'r');
    try{expect(read(fd,encoding)).toEqual(readNativeFileSync(name,encoding));}finally{closeSync(fd);}}
   const unrelated=resolve(root,'workers-ts/tsconfig.json');
   expect(read(unrelated)).toEqual(readNativeFileSync(unrelated));expect(read(unrelated,'ascii')).toBe(readNativeFileSync(unrelated,'ascii'));
   expect(()=>read(resolve(root,'.missing-refund-source-continuity'))).toThrow();
  }
 });
 it('records the explicit old recharge descriptor expectation correction and reconstructs the entire original test',()=>{
  const file='workers-ts/test/recharge-notice-source-continuity.test.ts',actual=physical(file),before=projectRechargeRefundPredecessor(file,actual);
  expect(before).toBe(origin(file));expect(actual).toContain("physical=readNativeFileSync(name,'utf8')");
  expect(actual).toContain("expect(read(fd,'utf8')).toBe(physical)");expect(before).toContain("expect(read(fd,'utf8')).toBe(current)");
  expect(actual).toContain("from './helpers/rechargeNoticeSourceContinuity'");
  expect(actual).toContain("from './helpers/rechargeRefundSourceContinuity'");
  for(const row of proof.sources.filter(row=>row.kind==='historical-reader-wiring'))
   expect(projectRechargeRefundPredecessor(row.file,physical(row.file))).toBe(origin(row.file));
 });
 it('keeps unrelated arbitrary-byte paths and binary contents native and lets native fs refuse non-file URLs',()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'refund-source-native-bytes-'));
  const file=Buffer.concat([Buffer.from(directory+'/'),Buffer.from([255,254])]);
  try{
   writeFileSync(file,Buffer.from([255,0,97]));
   for(const read of[readRechargeRefundPredecessorFile,readRechargeNoticePredecessorFile,readMembershipContinuityHistoricalFile]){
    expect(read(file)).toEqual(readNativeFileSync(file));expect(read(file,'latin1')).toBe(readNativeFileSync(file,'latin1'));
    expect(()=>read(new URL('https://example.invalid/native-fs-protocol-refusal'))).toThrow();
   }
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
 it('keeps checkout source30d type-bridge rebasing explicit without accepting component/runtime behavior',()=>{
  const row=proof.checkoutTypeBridge,current=physical(row.file),literal='Object.getOwnPropertyDescriptors(local) as unknown as PropertyDescriptorMap';
  expect(sha(current)).toBe(row.selectedSource30dSha256);expect(current.split(literal)).toHaveLength(2);
  expect(sha(current.replace(literal,'Object.getOwnPropertyDescriptors(local) as PropertyDescriptorMap'))).toBe(row.impactObservationSha256);
 });
 it('discloses the independent335-name legacy inventory failure and leaves its original gate and metadata unchanged',()=>{
  const debt=proof.inventoryDebt,legacy=JSON.parse(readNativeFileSync(resolve(root,debt.legacyProof),'utf8'))as{current_inventory:string[]};
  const fixed=execFileSync('git',['ls-tree','-r','--name-only','-z',proof.predecessorCommit],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024})
   .split('\0').filter(Boolean).sort();
  expect(legacy.current_inventory).toHaveLength(8385);expect(fixed).toHaveLength(8720);
  expect(debt.legacyExpectedCount).toBe(8385);expect(debt.fixedBaseCount).toBe(8720);
  const old=new Set(legacy.current_inventory),base=new Set(fixed);
  expect(fixed.filter(file=>!old.has(file))).toEqual(debt.preExistingBaseAdditions);expect(debt.preExistingBaseAdditions).toHaveLength(335);
  expect(legacy.current_inventory.filter(file=>!base.has(file))).toEqual(debt.preExistingBaseMissing);expect(debt.preExistingBaseMissing).toEqual([]);
  expect(fixed).not.toEqual(legacy.current_inventory);expect(debt.status).toBe('unresolved independent legacy gate;not repaired or skipped');
 });
 it.each(['current hash','predecessor hash','current bytes','predecessor bytes','blob','path','origin','kind','missing row','duplicate row','row order',
  'edit range','literal','anchor','overlap','preserved proof','inventory debt','provenance','prior proof','unknown field','unknown row field']as const)(
  'rejects forged %s metadata before producing any historical view',kind=>{
   const changed=structuredClone(proof),row=changed.sources[0]!,edit=row.inverseEdits[0]!;
   if(kind==='current hash')row.current.sha256='0'.repeat(64);if(kind==='predecessor hash')row.predecessor.sha256='0'.repeat(64);
   if(kind==='current bytes')row.current.bytes++;if(kind==='predecessor bytes')row.predecessor.bytes++;
   if(kind==='blob')row.predecessor.gitBlobSha1='0'.repeat(40);if(kind==='path')row.file+='.other';if(kind==='origin')row.origin.commit='0'.repeat(40);
   if(kind==='kind')row.kind='historical-reader-wiring';if(kind==='missing row')changed.sources.pop();
   if(kind==='duplicate row')changed.sources.push(structuredClone(row));if(kind==='row order')changed.sources.reverse();
   if(kind==='edit range')edit.start++;if(kind==='literal')edit.after.push('// invented\n');if(kind==='anchor')edit.anchor[0]+='// invented\n';
   if(kind==='overlap')row.inverseEdits.push(structuredClone(edit));if(kind==='preserved proof')changed.preserved[0]!.sha256='0'.repeat(64);
   if(kind==='inventory debt')changed.inventoryDebt.preExistingBaseAdditions.pop();if(kind==='provenance')changed.inputProvenance[0]!.acceptedByThisProof=true;
   if(kind==='prior proof')changed.priorProof.sha256='0'.repeat(64);
   if(kind==='unknown field')Object.assign(changed,{unknown:true});if(kind==='unknown row field')Object.assign(row,{unknown:true});
   expect(()=>projectRechargeRefundPredecessor(proof.sources[0]!.file,physical(proof.sources[0]!.file),changed)).toThrow('complete proof differs');
  });
});

describe('refund continuity metadata is bounded data only before any serialization or projection',()=>{
 const file='workers-ts/src/migrations/checkoutPricingLock.ts';
 const reject=(value:typeof proof)=>expect(()=>projectRechargeRefundPredecessor(file,physical(file),value)).toThrow('complete proof differs');
 it('rejects the reproduced nonenumerable toJSON disguise of unknown metadata without calling it',()=>{
  const changed=structuredClone(proof);let calls=0;Object.assign(changed,{unknown:true});
  Object.defineProperty(changed,'toJSON',{value:()=>{calls++;return proof;},enumerable:false});
  reject(changed);expect(calls).toBe(0);
 });
 it('rejects a toJSON disguise of changed inverse and image metadata without calling it',()=>{
  const changed=structuredClone(proof);let calls=0;
  changed.sources[0]!.current.sha256='0'.repeat(64);changed.sources[0]!.inverseEdits[0]!.before.push('// invented\n');
  Object.defineProperty(changed,'toJSON',{value:()=>{calls++;return proof;},enumerable:false});
  reject(changed);expect(calls).toBe(0);
 });
 it.each(['metadata getter','toJSON getter','array index getter','array toJSON','array function','object function','symbol getter']as const)(
  'refuses executable %s metadata without invoking its callback',kind=>{
   const changed=structuredClone(proof),rows=changed.sources,row=rows[0]!;let calls=0;
   if(kind==='metadata getter')Object.defineProperty(changed,'sources',{get:()=>{calls++;return rows;},enumerable:true});
   if(kind==='toJSON getter')Object.defineProperty(changed,'toJSON',{get:()=>{calls++;return()=>proof;},enumerable:true});
   if(kind==='array index getter')Object.defineProperty(rows,'0',{get:()=>{calls++;return row;},enumerable:true});
   if(kind==='array toJSON')Object.defineProperty(rows,'toJSON',{value:()=>{calls++;return proof.sources;},enumerable:false});
   if(kind==='array function')Object.defineProperty(rows,'0',{value:()=>{calls++;return row;},enumerable:true});
   if(kind==='object function')Object.defineProperty(row,'execute',{value:()=>{calls++;return row;},enumerable:true});
   if(kind==='symbol getter')Object.defineProperty(changed,Symbol('unknown'),{get:()=>{calls++;return row;},enumerable:true});
   reject(changed);expect(calls).toBe(0);
  });
 it.each(['get','ownKeys','getPrototypeOf']as const)('refuses a Proxy before executing its %s trap',kind=>{
  const changed=structuredClone(proof);let calls=0;
  const handler:ProxyHandler<typeof changed.sources>={};
  if(kind==='get')handler.get=(target,key,receiver)=>{calls++;return Reflect.get(target,key,receiver);};
  if(kind==='ownKeys')handler.ownKeys=target=>{calls++;return Reflect.ownKeys(target);};
  if(kind==='getPrototypeOf')handler.getPrototypeOf=target=>{calls++;return Reflect.getPrototypeOf(target);};
  changed.sources=new Proxy(changed.sources,handler);reject(changed);expect(calls).toBe(0);
 });
 it.each(['hole','cycle','nonplain object','nonplain array']as const)('rejects %s metadata before producing a source view',kind=>{
  const changed=structuredClone(proof);
  if(kind==='hole')Reflect.deleteProperty(changed.sources,'0');if(kind==='cycle')Object.assign(changed,{cycle:changed});
  if(kind==='nonplain object')Object.setPrototypeOf(changed.sources[0]!,Date.prototype);
  if(kind==='nonplain array')Object.setPrototypeOf(changed.sources,Object.create(Array.prototype));
  reject(changed);
 });
 it.each(['UTF8 bytes','nodes','depth','array length','object keys']as const)('refuses a proof beyond the fixed %s bound',kind=>{
  const changed=structuredClone(proof);
  if(kind==='UTF8 bytes')changed.boundary='x'.repeat(1048577);
  if(kind==='nodes')Object.assign(changed,{unknown:Array.from({length:8},()=>Array.from({length:8192},()=>0))});
  if(kind==='depth'){let chain:unknown=0;for(let depth=0;depth<25;depth++)chain={child:chain};Object.assign(changed,{unknown:chain});}
  if(kind==='array length')Object.assign(changed,{unknown:Array.from({length:16385},()=>0)});
  if(kind==='object keys')Object.assign(changed,{unknown:Object.fromEntries(Array.from({length:129},(_,index)=>['key'+index,0]))});
  reject(changed);
 });
 it('accepts an ordinary null-prototype JSON proof without executing caller properties',()=>{
  const changed=structuredClone(proof);Object.setPrototypeOf(changed,null);Object.setPrototypeOf(changed.sources[0]!.current,null);
  const row=proof.sources.find(value=>value.file===file)!;
  expect(image(projectRechargeRefundPredecessor(file,physical(file),changed))).toEqual(row.predecessor);
 });
});
