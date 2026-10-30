import {createHash} from 'node:crypto';
import {readWechatAppAuthorPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {wechatAppAuthorPredecessorExecFileSync as execFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {describe,expect,it} from 'vitest';
import {buildWechatAppAuthorPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {PC_BASE_KEYS,PC_BASE_OPEN_RESERVED_KEYS,normalizePcBaseReplacement,type PcBaseFiling} from '../../view/common/pcBase';
import {parsePcBaseIntentSave,pcBaseIntentPending,type PcBaseFieldIntents} from '../../view/common/pcBaseIntent';
import {retainPcFooterKeyOrder,sortedPcFooterRows} from '../src/services/pc/PcFooterOrder';
import {pcBaseAuthorSourceBinding as bound,reversePcBaseAuthorSource,reversePcBaseAuthorPredecessorPublication,readPcBaseAuthorPredecessor,readWechatOpenAuthorPredecessor,readWechatBaseAuthorPredecessor,readWechatMenuAuthorPredecessor,readBargainRecordsPredecessor,buildPcBaseAuthorPredecessorApiAuditReport,pcBaseAuthorPredecessorExecFileSync,wechatOpenAuthorPredecessorExecFileSync,wechatBaseAuthorPredecessorExecFileSync,wechatMenuAuthorPredecessorExecFileSync,bargainRecordsPredecessorExecFileSync,wechatOpenAuthorSourceBinding,wechatBaseAuthorSourceBinding,wechatMenuAuthorSourceBinding,bargainRecordsSourceBinding} from './helpers/wechatAppAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../..');
const sha=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const read=(name:string)=>readFileSync(resolve(root,name),'utf8');
const strip=(raw:string)=>raw.replace(/^import[\s\S]*?;\n/gmu,'');
type Origin={file:string;sha256:string;raw_utf8:string};
type Member={path:string;bytes:number;sha256:string};
type Generated=Member&{origin:string};
type ApiReport=ReturnType<typeof buildAdminFrontendApiAuditReport>;
const proof=bound as typeof bound&{
 baseline_manifest:Origin;predecessor_receipt:Origin;normalized_helper_sha256:string;
 controlled_source_manifest:Member[];publication_outputs_excluded:string[];generated_outputs_excluded_prefixes:string[];
 predecessor_generated_outputs:Generated[];predecessor_source_report:Origin;
 new_api_calls:ApiReport['calls'];
 runtime_execution_contract:Origin;
 runtime_evidence:Array<{name:string;cwd:string;argv:string[];exit_code:number;log:string;sha256:string;inputs:{file:string;sha256:string;count:number};execution_contract_sha256:string;driver_sha256:string;runtime_jobs_sha256:string}>;
 source_publication_maintenance:{application:{own_files:Array<{file:string;sha256:string;source:string}>};types:{exit_code:number;inputs:{file:string;sha256:string;count:number}};phase_contract:{type_gate_proof_present:boolean;type_gate_helper_pin:string;publication_new_json:string}};
};
describe('fixed PHP PC base author and real public consumer source preservation',()=>{
 for(const row of proof.sources){
  it('binds complete current and true prior source '+row.file,()=>{
   const raw=read(row.file),before=reversePcBaseAuthorSource(row.file,raw);
   expect(sha(raw)).toBe(row.after_sha256);expect(sha(before)).toBe(row.before_sha256);
   expect(readPcBaseAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(before);
   expect(before.replace(row.edits[0]!.before_source,()=>row.edits[0]!.after_source)).toBe(raw);
  });
  it('rejects current drift and forged complete predecessor '+row.file,()=>{
   const raw=read(row.file);for(const altered of [raw.slice(1),raw+'\n',raw+raw])expect(()=>reversePcBaseAuthorSource(row.file,altered)).toThrow();
   const fake={...proof,sources:proof.sources.map(value=>value===row?{...value,before_sha256:'0'.repeat(64)}:value)};
   expect(()=>reversePcBaseAuthorSource(row.file,raw,fake)).toThrow();
  });
  if(proof.predecessor_readports.includes(row.file))it('preserves all old assertion bytes and negative fixtures '+row.file,()=>{
   const edit=row.edits[0]!;expect(strip(edit.after_source)).toBe(strip(edit.before_source));expect(edit.after_source).not.toBe(edit.before_source);
   expect(edit.after_source).not.toMatch(/from ['"]\.\/helpers\/wechatOpenAuthorSourceBinding['"]/u);
  });
 }
 for(const row of proof.full_additions)it('binds the whole new file '+row.file,()=>{
  const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(proof.sources.some(value=>value.file===row.file)).toBe(false);
 });
 for(const row of proof.PHP_sources)it('retains complete fixed PHP source '+row.file,()=>{
  expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes);expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);
 });
 const frozen=Object.entries(proof.frozen_predecessor_evidence),observed=Object.entries(proof.observed_unchanged);
 for(let index=0;index<frozen.length;index+=64)it('keeps frozen predecessor chunk '+index,()=>{for(const [file,hash]of frozen.slice(index,index+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
 for(let index=0;index<observed.length;index+=32)it('keeps untouched consumer chunk '+index,()=>{for(const [file,hash]of observed.slice(index,index+32))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});

 it('binds the acceptedOpen8234 inventory and exact changed/new source partition',()=>{
  expect(proof.baseline).toEqual({file_count:8234,sha256:'afbd08c966dd69d4349c140b2624b3ba7c74f2049c838366787ecdd1f801eaa5'});
  expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
  const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[],byName=new Map(before.map(row=>[row.path,row]));
  expect(byName.size).toBe(8234);expect(frozen).toHaveLength(1751);expect(proof.predecessor_readports).toHaveLength(39);expect(new Set(proof.predecessor_readports).size).toBe(39);
  const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
  const names=[...new Set([...inventory,...before.map(row=>row.path)])].filter(name=>name&&!proof.publication_outputs_excluded.includes(name)&&!proof.generated_outputs_excluded_prefixes.some(prefix=>name.startsWith(prefix))).sort();
  expect(proof.controlled_source_manifest.map(row=>row.path)).toEqual(names);
  const changed:string[]=[],added:string[]=[];
  for(const row of proof.controlled_source_manifest){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength,row.path).toBe(row.bytes);expect(sha(raw),row.path).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)changed.push(row.path);}
  expect(proof.sources.map(row=>row.file)).toEqual(changed);expect(proof.full_additions.map(row=>row.file)).toEqual(added);
  expect(proof.publication_outputs_excluded).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md','workers-ts/audit/pc-base-author-source-binding-20261028.json','workers-ts/test/helpers/pcBaseAuthorSourceBinding.ts','workers-ts/docs/php-ts-admin-pc-base-author-20261028.md']);
  for(const prefix of ['view/admin-ts/dist/','view/uniapp-ts/dist/','view/pc-ts/dist/','view/kefu-ts/dist/'])expect(proof.generated_outputs_excluded_prefixes).toContain(prefix);
 });
 it('normalizes only this helper own pin and preserves the accepted Open helper and proof',()=>{
  const raw=read('workers-ts/test/helpers/pcBaseAuthorSourceBinding.ts');expect(raw).toMatch(/const PC_BASE_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u);
  expect(sha(raw.replace(/const PC_BASE_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u,"const PC_BASE_AUTHOR_PROOF_SHA='<PIN>';"))).toBe(proof.normalized_helper_sha256);
  expect(sha(read('workers-ts/test/helpers/wechatOpenAuthorSourceBinding.ts'))).toBe('5d6419db8dc69e333f11ba90d3471f7c4c948a3df24738d45ce0850ea3c8f8aa');
  expect(sha(read('workers-ts/audit/wechat-open-author-source-binding-20261027.json'))).toBe('fe4fc0b33f35c07dc4d93934841d17195462c60206301237c5564b5dc3d6344f');
 });
 it('binds both complete append-only ledger images to five immutable physical origins',()=>{
  expect(Object.keys(proof.predecessor_publication_origins).sort()).toEqual(['open_accepted_manifest','open_before_manifest','open_receipt','open_validation_manifest','pc_before_manifest']);
  for(const row of Object.values(proof.predecessor_publication_origins)){expect(sha(row.raw_utf8)).toBe(row.sha256);expect(readFileSync(row.file,'utf8')).toBe(row.raw_utf8);}
  const vm=new Map((JSON.parse(proof.predecessor_publication_origins.open_validation_manifest!.raw_utf8)as Member[]).map(row=>[row.path,row]));
  const am=new Map((JSON.parse(proof.predecessor_publication_origins.open_accepted_manifest!.raw_utf8)as Member[]).map(row=>[row.path,row]));
  expect(proof.predecessor_publication.map(row=>row.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);
  for(const row of proof.predecessor_publication){expect(readFileSync(row.validation_origin,'utf8')).toBe(row.validation_source);expect(readFileSync(row.accepted_origin,'utf8')).toBe(row.accepted_source);expect(sha(row.validation_source)).toBe(vm.get(row.file)!.sha256);expect(sha(row.accepted_source)).toBe(am.get(row.file)!.sha256);expect(reversePcBaseAuthorPredecessorPublication(row.file,row.accepted_source)).toBe(row.validation_source);expect(readPcBaseAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(row.validation_source);for(const altered of [row.accepted_source+'\n',row.validation_source,row.accepted_source.slice(1)])expect(()=>reversePcBaseAuthorPredecessorPublication(row.file,altered)).toThrow();}
 });
 it('keeps8234 acceptedOpen8097 Base8076 Menu8057 Bargain8033 inventory ports distinct',()=>{
  const args=['ls-files','-co','--exclude-standard','-z'],options={cwd:root,encoding:'utf8'};
  for(const [reader,count]of [[pcBaseAuthorPredecessorExecFileSync,8234],[wechatOpenAuthorPredecessorExecFileSync,8097],[wechatBaseAuthorPredecessorExecFileSync,8076],[wechatMenuAuthorPredecessorExecFileSync,8057],[bargainRecordsPredecessorExecFileSync,8033]]as const)expect(reader('git',args,options).split('\0').filter(Boolean)).toHaveLength(count);
  expect(()=>pcBaseAuthorPredecessorExecFileSync('git',['status'],options)).toThrow();expect(()=>pcBaseAuthorPredecessorExecFileSync('git',args,{...options,cwd:resolve(root,'..')})).toThrow();
 });
 it('routes all449 Open generated outputs and the four deeper admin views to exact physical origins',()=>{
  expect(proof.predecessor_generated_outputs).toHaveLength(449);
  for(const [prefix,count]of [['view/admin-ts/dist/',333],['view/uniapp-ts/dist/',0],['view/pc-ts/dist/',103],['view/kefu-ts/dist/',13]]as const)expect(proof.predecessor_generated_outputs.filter(row=>row.path.startsWith(prefix))).toHaveLength(count);
  const views=[{rows:proof.predecessor_generated_outputs,reader:readPcBaseAuthorPredecessor,count:449},{rows:(wechatOpenAuthorSourceBinding as typeof wechatOpenAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatOpenAuthorPredecessor,count:331},{rows:(wechatBaseAuthorSourceBinding as typeof wechatBaseAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatBaseAuthorPredecessor,count:329},{rows:(wechatMenuAuthorSourceBinding as typeof wechatMenuAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatMenuAuthorPredecessor,count:327},{rows:(bargainRecordsSourceBinding as typeof bargainRecordsSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readBargainRecordsPredecessor,count:321}];
  for(const view of views){expect(view.rows).toHaveLength(view.count);for(const row of view.rows){const raw=view.reader(resolve(root,row.path));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(sha(readFileSync(row.origin))).toBe(row.sha256);}}
  for(const prefix of ['view/admin-ts/dist/','view/uniapp-ts/dist/','view/pc-ts/dist/','view/kefu-ts/dist/'])expect(()=>readPcBaseAuthorPredecessor(resolve(root,prefix+'no-pinned-member.js'))).toThrow();
 });
 it('binds all5568 accepted Open file/fullName identities in39 files without changing old receipts',()=>{
  expect(sha(proof.predecessor_receipt.raw_utf8)).toBe('1d6a7cb57e7fae54d60a4103c7f27f84cfe560ab9d425439913e4e7d2532b34d');expect(JSON.parse(proof.predecessor_receipt.raw_utf8)).toMatchObject({status:'accepted',counts:{source:5568}});
  const report=JSON.parse(proof.predecessor_source_report.raw_utf8)as{success:boolean;testResults:Array<{name:string;assertionResults:Array<{fullName:string;status:string}>}>};
  expect(readFileSync(proof.predecessor_source_report.file,'utf8')).toBe(proof.predecessor_source_report.raw_utf8);expect(sha(proof.predecessor_source_report.raw_utf8)).toBe(proof.predecessor_source_report.sha256);expect(report.success).toBe(true);
  const ids=report.testResults.flatMap(file=>file.assertionResults.map(row=>{expect(row.status).toBe('passed');return file.name.split('/workers-ts/').at(-1)+'\0'+row.fullName;}));expect(report.testResults).toHaveLength(39);expect(ids).toHaveLength(5568);expect(new Set(ids).size).toBe(5568);
 });
 it('runs actual current AST and preserves all849 whole previous API call objects',()=>{
  const actual=buildAdminFrontendApiAuditReport(),previous=buildPcBaseAuthorPredecessorApiAuditReport();expect(sha(JSON.stringify(actual,null,2)+'\n')).toBe(proof.current_report.sha256);
  expect(previous.counts.callSites).toBe(811);expect(previous.calls).toHaveLength(849);expect(actual.counts.unregistered).toBe(0);expect(actual.counts.unresolved).toBe(0);expect(proof.retired_api_calls).toEqual([]);
  for(const old of previous.calls)expect(actual.calls).toContainEqual(old);
  const added=actual.calls.filter(row=>!previous.calls.some(old=>isDeepStrictEqual(row,old)));expect(added).toEqual(proof.new_api_calls);expect(added.length).toBeGreaterThan(0);
  for(const call of added)expect(call).toMatchObject({registered:true,availability:'executable'});
 });
 it('keeps fresh source types separate from later proof JSON and one own literal pin',()=>{
  const phases=proof.source_publication_maintenance,raw=readFileSync(phases.types.inputs.file,'utf8');expect(sha(raw)).toBe(phases.types.inputs.sha256);const rows=JSON.parse(raw)as Member[];expect(rows).toHaveLength(phases.types.inputs.count);expect(phases.types.exit_code).toBe(0);expect(rows.some(row=>row.path==='workers-ts/audit/pc-base-author-source-binding-20261028.json')).toBe(false);
  expect(phases.phase_contract.type_gate_proof_present).toBe(false);expect(phases.phase_contract.type_gate_helper_pin).toBe('PENDING_PC_BASE_AUTHOR_PROOF');expect(phases.phase_contract.publication_new_json).toBe('workers-ts/audit/pc-base-author-source-binding-20261028.json');
  const prior=phases.application.own_files.find(row=>row.file==='workers-ts/test/helpers/pcBaseAuthorSourceBinding.ts')!;expect(sha(prior.source)).toBe(prior.sha256);expect(rows.find(row=>row.path===prior.file)!.sha256).toBe(prior.sha256);expect(prior.source).toContain("const PC_BASE_AUTHOR_PROOF_SHA='PENDING_PC_BASE_AUTHOR_PROOF';");
  const current=read(prior.file),normalize=(value:string)=>value.replace(/const PC_BASE_AUTHOR_PROOF_SHA='[^']+';/u,"const PC_BASE_AUTHOR_PROOF_SHA='<PIN>';");expect(normalize(current)).toBe(normalize(prior.source));expect(current).toContain("const PC_BASE_AUTHOR_PROOF_SHA='"+sha(read('workers-ts/audit/pc-base-author-source-binding-20261028.json'))+"';");
 });
 it('binds every actual business job command and raw log to one earlier complete source input',()=>{
  const origin=proof.runtime_execution_contract;expect(sha(origin.raw_utf8)).toBe(origin.sha256);expect(readFileSync(origin.file,'utf8')).toBe(origin.raw_utf8);
  const contract=JSON.parse(origin.raw_utf8)as{jobs:Array<{name:string;cwd:string;argv:string[]}>;driver_sha256:string;runtime_jobs_sha256:string;node_reporter:{file:string;sha256:string}};
  expect(contract.jobs.length).toBeGreaterThanOrEqual(13);expect(new Set(contract.jobs.map(row=>row.name)).size).toBe(contract.jobs.length);expect(proof.runtime_evidence).toHaveLength(contract.jobs.length);expect(sha(readFileSync(contract.node_reporter.file))).toBe(contract.node_reporter.sha256);
  const inputSHA=proof.runtime_evidence[0]!.inputs.sha256;
  for(const [index,gate]of proof.runtime_evidence.entries()){
   expect({name:gate.name,cwd:gate.cwd,argv:gate.argv}).toEqual(contract.jobs[index]);expect(gate.exit_code).toBe(0);expect(gate.execution_contract_sha256).toBe(origin.sha256);expect(gate.driver_sha256).toBe(contract.driver_sha256);expect(gate.runtime_jobs_sha256).toBe(contract.runtime_jobs_sha256);expect(sha(readFileSync(gate.log))).toBe(gate.sha256);
   const raw=readFileSync(gate.inputs.file,'utf8');expect(sha(raw)).toBe(gate.inputs.sha256);expect(gate.inputs.sha256).toBe(inputSHA);const rows=JSON.parse(raw)as Member[];expect(rows).toHaveLength(gate.inputs.count);expect(new Set(rows.map(row=>row.path)).size).toBe(rows.length);
   for(const file of ['workers-ts/test/helpers/pcBaseAuthorSourceBinding.ts','workers-ts/test/admin-pc-base-author-source-binding.test.ts','workers-ts/audit/pc-base-author-source-binding-20261028.json'])expect(rows.some(row=>row.path===file)).toBe(false);
   for(const file of proof.predecessor_readports)expect(rows.find(row=>row.path===file)!.sha256).toBe(proof.sources.find(row=>row.file===file)!.before_sha256);
  }
 });
 it('requires complete thirteen-field intents and never accepts Open or client raw-preservation material',()=>{
  expect(PC_BASE_KEYS).toEqual(['pc_logo','bast_number','first_number','product_phone_buy_url','contact_number','company_address','copyright','seo_title','site_keywords','site_description','links_open','links_list','filing_list']);
  const input={request_id:'11111111-1111-4111-8111-111111111111',revision:'a'.repeat(64),confirmed:true as const,fields:Object.fromEntries(PC_BASE_KEYS.map(key=>[key,{action:'keep'}]))as PcBaseFieldIntents};
  expect(parsePcBaseIntentSave(input)).toEqual(input);expect(pcBaseIntentPending(input,101)).toEqual({version:1,domain:'pc_base',actor_id:101,request_id:input.request_id});
  for(const key of PC_BASE_OPEN_RESERVED_KEYS)expect(()=>parsePcBaseIntentSave({...input,fields:{...input.fields,[key]:{action:'keep'}}})).toThrow();
  for(const key of ['raw','original_url','value','credential'])expect(()=>parsePcBaseIntentSave({...input,fields:{...input.fields,pc_logo:{action:'keep',[key]:'private'}}})).toThrow();
  expect(()=>parsePcBaseIntentSave({...input,settings:{}})).toThrow();
 });
 it('retains valid HTTP media and authored quantities over100 without claiming consumer cardinality from parsing',()=>{
  expect(normalizePcBaseReplacement('pc_logo','http://cdn.example.test/logo.png')).toBe('http://cdn.example.test/logo.png');expect(normalizePcBaseReplacement('bast_number',151)).toBe(151);expect(normalizePcBaseReplacement('first_number',101)).toBe(101);
  expect(()=>normalizePcBaseReplacement('pc_logo','/api/assets/1?signature=private')).toThrow();expect(()=>normalizePcBaseReplacement('links_list',[{name:'unsafe',url:'javascript:alert(1)',sort:0}])).toThrow();
 });
 it('preserves validated historical footer key order and canonical prefix order before ticket signing',()=>{
  const original=[{name:'A',icon:'/z.png',url:'',sort:0},{name:'Z',icon:'/a.png',url:'',sort:0}];
  const safe=retainPcFooterKeyOrder(original,normalizePcBaseReplacement('filing_list',original));expect(Object.keys(safe[0]!)).toEqual(['name','icon','url','sort']);expect(sortedPcFooterRows(safe).map(row=>row.name)).toEqual(['A','Z']);
  const canonical:PcBaseFiling[]=[{icon:'/api/assets/992050',name:'',url:'',sort:0},{icon:'/api/assets/99205',name:'',url:'',sort:0}];expect(sortedPcFooterRows(canonical).map(row=>row.icon)).toEqual(['/api/assets/99205','/api/assets/992050']);
 });
});
