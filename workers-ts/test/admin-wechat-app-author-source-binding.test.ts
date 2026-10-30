// Private preparation. No proof or pass is asserted by this file's existence.
import {createHash} from 'node:crypto';
import {readCheckpointAcceptedAuthorView as readFileSync} from './helpers/migrationMergeSourceBinding';
import {checkpointMergePredecessorExecFileSync as execFileSync} from './helpers/migrationMergeSourceBinding';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {describe,expect,it} from 'vitest';
import {buildAdminFrontendApiAuditReport} from './helpers/migrationMergeCheckpointReport';
import {wechatAppAuthorSourceBinding as bound,reverseWechatAppAuthorSource,
 reverseWechatAppAuthorPredecessorPublication,readWechatAppAuthorPredecessor,
 buildWechatAppAuthorPredecessorApiAuditReport,wechatAppAuthorPredecessorExecFileSync,
 pcBaseAuthorSourceBinding,readPcBaseAuthorPredecessor} from './helpers/wechatAppAuthorSourceBinding';

const root=resolve(import.meta.dirname,'../..');
const sha=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const strip=(raw:string)=>raw.replace(/^import[\s\S]*?;\n/gmu,'');
type Origin={file:string;sha256:string;raw_utf8:string};
type Member={path:string;bytes:number;sha256:string};
type Identity=['backend'|'frontend'|'native'|'source',string,string];
type RuntimeGate={name:string;cwd:string;argv:string[];kind:string|null;exit_code:number;
 log:{file:string;sha256:string};execution:{file:string;sha256:string};
 inputs:{file:string;sha256:string;count:number};cases?:{file:string;sha256:string;count:number};host_closure?:{file:string;sha256:string}};
const proof=bound as typeof bound&{
 normalized_helper_sha256:string;
 predecessor_case_identities:Origin;
 runtime_execution_contract:Origin;
 runtime_evidence:RuntimeGate[];
 source_publication_maintenance:{application:{own_files:Array<{file:string;sha256:string;source:string}>};
  types:{exit_code:number;inputs:{file:string;sha256:string;count:number};log:{file:string;sha256:string}};
  phase_contract:{type_gate_proof_present:boolean;type_gate_helper_pin:string;publication_new_json:string}};
};
const readOrigin=(origin:{file:string;sha256:string})=>{
 const raw=readFileSync(origin.file,'utf8');expect(sha(raw),origin.file).toBe(origin.sha256);return raw;
};

describe('fixed PHP native WeChat App author and consumer source preservation',()=>{
 for(const row of proof.sources){
  it('binds complete current and true accepted PC source '+row.file,()=>{
   const raw=read(row.file),before=reverseWechatAppAuthorSource(row.file,raw);
   expect(sha(raw)).toBe(row.after_sha256);expect(sha(before)).toBe(row.before_sha256);
   expect(row.edits).toHaveLength(1);expect(row.edits[0]!.after_source).toBe(raw);
   expect(row.edits[0]!.before_source).toBe(before);
   expect(readWechatAppAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(before);
  });
  it('rejects current drift and a forged whole predecessor '+row.file,()=>{
   const raw=read(row.file);
   for(const changed of [raw.slice(1),raw+'\n',raw+raw])expect(()=>reverseWechatAppAuthorSource(row.file,changed)).toThrow();
   const forged={...proof,sources:proof.sources.map(value=>value===row?{...value,before_sha256:'0'.repeat(64)}:value)};
   expect(()=>reverseWechatAppAuthorSource(row.file,raw,forged)).toThrow();
  });
  if(proof.predecessor_readports.includes(row.file))it('preserves every old assertion and negative fixture '+row.file,()=>{
   expect(strip(row.edits[0]!.after_source)).toBe(strip(row.edits[0]!.before_source));
   expect(row.edits[0]!.after_source).not.toBe(row.edits[0]!.before_source);
  });
 }
 for(const row of proof.full_additions)it('binds the whole addition '+row.file,()=>{
  const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);
  expect(proof.sources.some(value=>value.file===row.file)).toBe(false);
 });
 for(const row of proof.PHP_sources)it('retains the fixed complete PHP source '+row.file,()=>{
  expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
  expect(sha(row.raw_utf8)).toBe(row.sha256);expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes);
  expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);
 });
 const frozen=Object.entries(proof.frozen_predecessor_evidence),observed=Object.entries(proof.observed_unchanged);
 for(let index=0;index<frozen.length;index+=64)it('keeps immutable predecessor evidence chunk '+index,()=>{
  for(const [file,digest]of frozen.slice(index,index+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(digest);
 });
 for(let index=0;index<observed.length;index+=32)it('keeps untouched source chunk '+index,()=>{
  for(const [file,digest]of observed.slice(index,index+32))expect(sha(readFileSync(resolve(root,file))),file).toBe(digest);
 });
 it('partitions the actual source inventory against accepted PC10037',()=>{
  expect(proof.baseline).toEqual({file_count:10037,sha256:'7d13b61f5d1f9f7ba10b2aa223fdd1fdd5961d4a31f7812b336dc5b4606f57ec'});
  expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
  const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[],byName=new Map(before.map(row=>[row.path,row]));
  expect(byName.size).toBe(10037);expect(frozen).toHaveLength(1754);
  expect(proof.frozen_predecessor_evidence).toEqual({...pcBaseAuthorSourceBinding.frozen_predecessor_evidence,
   'workers-ts/audit/pc-base-author-source-binding-20261028.json':'001ede33c9f63ac0f20f8f4f5a466dff45dc0bd195f02233ee45c6bc40c403d5',
   'workers-ts/test/helpers/pcBaseAuthorSourceBinding.ts':'68a87f58013fab4e61db932e620f9f05d93392bf01ebe3bbff2a4a610b1e43b2',
   'workers-ts/docs/php-ts-admin-pc-base-author-20261028.md':'cbe3e19acdcd33d611f8e473912774b5a8827f42c9909171a88fe6350d640840'});
  // Fix the proposed publication paths when the publisher is materialized;
  // arbitrary exclusion lists must never hide an App business/source change.
  expect(proof.publication_outputs_excluded).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md',
   'workers-ts/audit/wechat-app-author-source-binding-20261028.json',
   'workers-ts/test/helpers/wechatAppAuthorSourceBinding.ts',
   'workers-ts/docs/php-ts-admin-wechat-app-author-20261028.md']);
  expect([...proof.generated_outputs_excluded_prefixes].sort()).toEqual(['view/admin-ts/dist/','view/uniapp-ts/dist/','view/pc-ts/dist/','view/kefu-ts/dist/'].sort());
  expect(proof.predecessor_readports).toHaveLength(40);expect(new Set(proof.predecessor_readports).size).toBe(40);
  const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
  const names=[...new Set([...inventory,...before.map(row=>row.path)])].filter(file=>file&&!proof.publication_outputs_excluded.includes(file)
   &&!proof.generated_outputs_excluded_prefixes.some(prefix=>file.startsWith(prefix))).sort();
  expect(proof.controlled_source_manifest.map(row=>row.path)).toEqual(names);
  const changed:string[]=[],added:string[]=[];
  for(const row of proof.controlled_source_manifest){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength,row.path).toBe(row.bytes);
   expect(sha(raw),row.path).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)changed.push(row.path);}
  expect(proof.sources.map(row=>row.file)).toEqual(changed);expect(proof.full_additions.map(row=>row.file)).toEqual(added);
 });
 it('keeps one own literal pin and the true pre-publication type gate',()=>{
  const helper='workers-ts/test/helpers/wechatAppAuthorSourceBinding.ts',raw=read(helper),phases=proof.source_publication_maintenance;
  const normalize=(value:string)=>value.replace(/const WECHAT_APP_AUTHOR_PROOF_SHA='[^']+';/u,"const WECHAT_APP_AUTHOR_PROOF_SHA='<PIN>';");
  expect(raw.match(/const WECHAT_APP_AUTHOR_PROOF_SHA='/gu)).toHaveLength(1);
  expect(sha(normalize(raw))).toBe(proof.normalized_helper_sha256);
  expect(raw).toContain("const WECHAT_APP_AUTHOR_PROOF_SHA='"+sha(read('workers-ts/audit/wechat-app-author-source-binding-20261028.json'))+"';");
  const prior=phases.application.own_files.find(row=>row.file===helper)!;expect(sha(prior.source)).toBe(prior.sha256);
  expect(prior.source).toContain("const WECHAT_APP_AUTHOR_PROOF_SHA='PENDING_WECHAT_APP_AUTHOR_PROOF';");
  expect(normalize(prior.source)).toBe(normalize(raw));expect(phases.types.exit_code).toBe(0);readOrigin(phases.types.log);
  const manifest=JSON.parse(readOrigin(phases.types.inputs))as Member[];
  expect(manifest).toHaveLength(phases.types.inputs.count);expect(manifest.find(row=>row.path===helper)!.sha256).toBe(prior.sha256);
  expect(manifest.some(row=>row.path==='workers-ts/audit/wechat-app-author-source-binding-20261028.json')).toBe(false);
  expect(phases.phase_contract).toEqual({type_gate_proof_present:false,type_gate_helper_pin:'PENDING_WECHAT_APP_AUTHOR_PROOF',publication_new_json:'workers-ts/audit/wechat-app-author-source-binding-20261028.json'});
 });
 it('retains the accepted PC publication images and their true physical manifest origins',()=>{
  const origins=proof.predecessor_publication_origins;
  expect(Object.keys(origins).sort()).toEqual(['app_before_manifest','pc_accepted_manifest','pc_before_manifest','pc_receipt','pc_validation_manifest']);
  for(const origin of Object.values(origins))expect(readOrigin(origin)).toBe(origin.raw_utf8);
  expect(origins.pc_receipt!.sha256).toBe('2041e5352401888aea6bd2b6b728cd62db2f095d3bcc0f35207e8943f1f622f9');
  expect(origins.pc_receipt!.raw_utf8).toBe(proof.predecessor_receipt.raw_utf8);
  const receipt=JSON.parse(origins.pc_receipt!.raw_utf8)as{input_manifest_sha256:string;current_source_manifest_sha256:string;predecessor:{input_manifest_sha256:string}};
  expect(origins.pc_accepted_manifest!.sha256).toBe(receipt.input_manifest_sha256);
  expect(origins.pc_validation_manifest!.sha256).toBe(receipt.current_source_manifest_sha256);
  expect(origins.pc_before_manifest!.sha256).toBe(receipt.predecessor.input_manifest_sha256);
  expect(origins.app_before_manifest!.raw_utf8).toBe(origins.pc_accepted_manifest!.raw_utf8);
  expect(origins.app_before_manifest!.sha256).toBe(proof.baseline.sha256);
  const vm=new Map((JSON.parse(origins.pc_validation_manifest!.raw_utf8)as Member[]).map(row=>[row.path,row]));
  const am=new Map((JSON.parse(origins.pc_accepted_manifest!.raw_utf8)as Member[]).map(row=>[row.path,row]));
  expect(proof.predecessor_publication.map(row=>row.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);
  for(const row of proof.predecessor_publication){
   expect(sha(row.validation_source)).toBe(row.validation_sha256);expect(sha(row.accepted_source)).toBe(row.accepted_sha256);
   expect(readFileSync(row.validation_origin,'utf8')).toBe(row.validation_source);
   expect(readFileSync(row.accepted_origin,'utf8')).toBe(row.accepted_source);
   expect(vm.get(row.file)!.sha256).toBe(row.validation_sha256);expect(am.get(row.file)!.sha256).toBe(row.accepted_sha256);
   expect(row.accepted_source.startsWith(row.validation_source)).toBe(true);
   expect(reverseWechatAppAuthorPredecessorPublication(row.file,row.accepted_source)).toBe(row.validation_source);
   expect(readWechatAppAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(row.validation_source);
   for(const changed of [row.accepted_source+'\n',row.validation_source,row.accepted_source.slice(1)])expect(()=>reverseWechatAppAuthorPredecessorPublication(row.file,changed)).toThrow();
  }
 });
 it('keeps exact PC2214 physical members separate from the unchanged deeper Open449 table',()=>{
  const prefixes=['view/admin-ts/dist/','view/uniapp-ts/dist/','view/pc-ts/dist/','view/kefu-ts/dist/'];
  const accepted=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[];
  const expected=accepted.filter(row=>prefixes.some(prefix=>row.path.startsWith(prefix)));
  const members=proof.predecessor_generated_outputs;
  expect(members).toHaveLength(2214);expect(new Set(members.map(row=>row.path)).size).toBe(2214);
  expect(members.map(({origin:_,...row})=>row)).toEqual(expected);
  const receiptRaw=readOrigin(proof.predecessor_receipt);expect(receiptRaw).toBe(proof.predecessor_receipt.raw_utf8);
  expect(sha(receiptRaw)).toBe('2041e5352401888aea6bd2b6b728cd62db2f095d3bcc0f35207e8943f1f622f9');
  const receipt=JSON.parse(receiptRaw)as{cache_root:string};
  for(const [prefix,count]of [['view/admin-ts/dist/',335],['view/uniapp-ts/dist/',1762],['view/pc-ts/dist/',104],['view/kefu-ts/dist/',13]]as const){
   expect(members.filter(row=>row.path.startsWith(prefix))).toHaveLength(count);
   expect(()=>readWechatAppAuthorPredecessor(resolve(root,prefix+'no-pinned-member.js'))).toThrow();
  }
  for(const row of members){
   expect(resolve(row.origin)).toBe(resolve(receipt.cache_root,'inputs',row.path));
   const physical=readFileSync(row.origin);expect(physical.byteLength).toBe(row.bytes);expect(sha(physical)).toBe(row.sha256);
   const value=readWechatAppAuthorPredecessor(resolve(root,row.path));expect(value.byteLength).toBe(row.bytes);expect(sha(value)).toBe(row.sha256);
  }
  const open=(pcBaseAuthorSourceBinding as typeof pcBaseAuthorSourceBinding&{predecessor_generated_outputs:Array<Member&{origin:string}>}).predecessor_generated_outputs;
  expect(open).toHaveLength(449);expect(new Set(open.map(row=>row.path)).size).toBe(449);
  for(const [prefix,count]of [['view/admin-ts/dist/',333],['view/uniapp-ts/dist/',0],['view/pc-ts/dist/',103],['view/kefu-ts/dist/',13]]as const)
   expect(open.filter(row=>row.path.startsWith(prefix))).toHaveLength(count);
  for(const row of open){const value=readPcBaseAuthorPredecessor(resolve(root,row.path));expect(value.byteLength).toBe(row.bytes);expect(sha(value)).toBe(row.sha256);}
 });
 it('preserves the complete old855 API objects against the real current AST',()=>{
  const actual=buildAdminFrontendApiAuditReport(),previous=buildWechatAppAuthorPredecessorApiAuditReport();
  const canonical=JSON.stringify(actual,null,2)+'\n';
  expect(proof.current_report.file).toBe('workers-ts/audit/admin-frontend-api-contracts.json');
  expect(read(proof.current_report.file)).toBe(canonical);expect(sha(canonical)).toBe(proof.current_report.sha256);
  expect(previous.calls).toHaveLength(855);expect(previous.counts.callSites).toBe(817);
  expect(actual.counts.pathVariants).toBe(actual.calls.length);expect(actual.counts.unregistered).toBe(0);expect(actual.counts.unresolved).toBe(0);
  for(const old of previous.calls)expect(actual.calls).toContainEqual(old);
  expect(actual.calls.filter(row=>!previous.calls.some(old=>isDeepStrictEqual(old,row)))).toEqual(proof.new_api_calls);
  expect(proof.retired_api_calls).toEqual([]);
 });
 it('pins the real accepted PC7141 identities without claiming this source proof is their new runtime pass',()=>{
  const receiptRaw=readOrigin(proof.predecessor_receipt);expect(receiptRaw).toBe(proof.predecessor_receipt.raw_utf8);
  expect(sha(receiptRaw)).toBe('2041e5352401888aea6bd2b6b728cd62db2f095d3bcc0f35207e8943f1f622f9');
  const receipt=JSON.parse(receiptRaw)as{counts:{backend:number;frontend:number;native:number;source:number;unique:number};case_identities:Identity[]};
  expect(receipt.counts).toMatchObject({backend:629,frontend:544,native:130,source:5838,unique:7141});
  const raw=readOrigin(proof.predecessor_case_identities);expect(raw).toBe(proof.predecessor_case_identities.raw_utf8);
  const previous=JSON.parse(raw)as{counts:{unique:number};case_identities:Identity[];source_files:string[]};
  expect(previous.counts.unique).toBe(7141);expect(previous.case_identities).toEqual(receipt.case_identities);
  expect(new Set(previous.case_identities.map(row=>JSON.stringify(row))).size).toBe(7141);
  const sourceFiles=[...new Set(receipt.case_identities.filter(row=>row[0]==='source').map(row=>'workers-ts/'+row[1]))].sort();
  expect(sourceFiles).toHaveLength(40);expect(previous.source_files).toEqual(sourceFiles);
  expect([...proof.predecessor_readports].sort()).toEqual(sourceFiles);
  expect(wechatAppAuthorPredecessorExecFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)).toHaveLength(10037);
  // The new actual full7141 subset check belongs to the final report union and
  // external verifier, after this source gate. Embedding that future result in
  // the proof being tested would create a source/proof/report cycle.
 });
 it('binds actual business commands, results and logs to one complete earlier input',()=>{
  const raw=readOrigin(proof.runtime_execution_contract);expect(raw).toBe(proof.runtime_execution_contract.raw_utf8);
  const contract=JSON.parse(raw)as{jobs:Array<{name:string;cwd:string;argv:string[];kind:string|null}>;
   driver_sha256:string;runtime_jobs_sha256:string;driver:{file:string;sha256:string};
   runtime_jobs:Origin;result_extractor:{file:string;sha256:string};node_reporter:{file:string;sha256:string}};
  expect(contract.driver_sha256).toMatch(/^[a-f0-9]{64}$/u);expect(contract.runtime_jobs_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(contract.driver.sha256).toBe(contract.driver_sha256);readOrigin(contract.driver);
  const jobsRaw=readOrigin(contract.runtime_jobs);expect(jobsRaw).toBe(contract.runtime_jobs.raw_utf8);
  expect(sha(jobsRaw)).toBe(contract.runtime_jobs_sha256);expect(JSON.parse(jobsRaw)).toEqual(contract.jobs);
  expect(contract.result_extractor.sha256).toBe('7cd4fa20705a38998efaf278e324c94c3ea680d66048fd29390706419f4503d7');
  readOrigin(contract.result_extractor);readOrigin(contract.node_reporter);
  expect(proof.runtime_evidence).toHaveLength(contract.jobs.length);expect(new Set(contract.jobs.map(row=>row.name)).size).toBe(contract.jobs.length);
  expect(contract.jobs.length).toBeGreaterThan(0);const commonInput=proof.runtime_evidence[0]!.inputs;
  const inputRaw=readOrigin(commonInput),manifest=JSON.parse(inputRaw)as Member[];
  const manifestByPath=new Map(manifest.map(row=>[row.path,row]));
  expect(manifest).toHaveLength(commonInput.count);expect(manifestByPath.size).toBe(manifest.length);
  for(const file of proof.predecessor_readports)expect(manifestByPath.get(file)!.sha256).toBe(proof.sources.find(row=>row.file===file)!.before_sha256);
  for(const file of ['workers-ts/test/helpers/wechatAppAuthorSourceBinding.ts','workers-ts/test/admin-wechat-app-author-source-binding.test.ts',
   'workers-ts/audit/wechat-app-author-source-binding-20261028.json'])expect(manifestByPath.has(file)).toBe(false);
  for(const row of proof.controlled_source_manifest){
   if(proof.predecessor_readports.includes(row.path)||row.path==='workers-ts/test/admin-wechat-app-author-source-binding.test.ts')continue;
   expect(manifestByPath.get(row.path),row.path).toMatchObject(row);
  }
  for(const [index,gate]of proof.runtime_evidence.entries()){
   expect(contract.jobs[index]).toMatchObject({name:gate.name,cwd:gate.cwd,argv:gate.argv,kind:gate.kind});expect(gate.exit_code).toBe(0);
   readOrigin(gate.log);const execution=JSON.parse(readOrigin(gate.execution))as{
    phase:string;argv:string[];cwd:string;driver_sha256:string;input_manifest_sha256:string;raw_log_sha256:string;
    report_sha256?:string;actual_cases?:number;host_closed?:boolean;exit_code:number;evidence_valid:boolean;source_unchanged:boolean};
   expect(execution).toMatchObject({phase:gate.name,argv:gate.argv,cwd:gate.cwd,driver_sha256:contract.driver_sha256,
    input_manifest_sha256:gate.inputs.sha256,raw_log_sha256:gate.log.sha256,exit_code:0,evidence_valid:true,source_unchanged:true});
   if(gate.kind==='native'||gate.kind==='native-pg16'){
    expect(execution.host_closed).toBe(true);expect(gate.host_closure).toBeDefined();
    const closure=JSON.parse(readOrigin(gate.host_closure!))as{closed:boolean;pg_ctl_exit_code:number;port_connect_errno:number;
     owned_processes:number[];remaining_socket_paths:string[];postmaster_pid_present:boolean;cluster:{host:string;port:number;tests:string[]}};
    expect(closure).toMatchObject({closed:true,pg_ctl_exit_code:3,owned_processes:[],remaining_socket_paths:[],postmaster_pid_present:false});
    expect(closure.port_connect_errno).not.toBe(0);expect(closure.cluster.host).toBe('127.0.0.1');
    expect(closure.cluster.tests).toEqual(gate.argv.filter(arg=>/^test\/[a-z0-9-]+\.test\.ts$/u.test(arg)));
   }
   // Every gate must name the same complete input. Recheck each physical
   // origin/hash without reparsing or repeating the identical inventory checks.
   expect(gate.inputs).toEqual(commonInput);expect(readOrigin(gate.inputs)).toBe(inputRaw);
   if(gate.cases){const cases=JSON.parse(readOrigin(gate.cases))as{
    count:number;identities:Array<[string,string]>;origin:{file:string;sha256:string};files:string[]};
    readOrigin(cases.origin);
    if(gate.kind==='native'||gate.kind==='native-pg16')expect(cases.origin.sha256).toBe(gate.log.sha256);
    expect(execution.report_sha256).toBe(gate.cases.sha256);expect(execution.actual_cases).toBe(gate.cases.count);
    expect(cases.count).toBe(gate.cases.count);expect(cases.identities).toHaveLength(cases.count);
    expect(new Set(cases.identities.map(row=>JSON.stringify(row))).size).toBe(cases.count);}
  }
 });
});
