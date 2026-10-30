import {createHash} from 'node:crypto';
import {readPcBaseAuthorPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {pcBaseAuthorPredecessorExecFileSync as execFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildPcBaseAuthorPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {WECHAT_OPEN_KEYS,WECHAT_OPEN_AUTHORITY_KEY,parseWechatOpenSave,wechatOpenPending} from '../../view/common/wechatOpen';
import {wechatOpenAuthorSourceBinding as bound,reverseWechatOpenAuthorSource,reverseWechatOpenAuthorPredecessorPublication,readWechatOpenAuthorPredecessor,readWechatBaseAuthorPredecessor,readWechatMenuAuthorPredecessor,readBargainRecordsPredecessor,buildWechatOpenAuthorPredecessorApiAuditReport,wechatOpenAuthorPredecessorExecFileSync,wechatBaseAuthorPredecessorExecFileSync,wechatMenuAuthorPredecessorExecFileSync,bargainRecordsPredecessorExecFileSync,wechatBaseAuthorSourceBinding,wechatMenuAuthorSourceBinding,bargainRecordsSourceBinding} from './helpers/wechatAppAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../..');
const sha=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const read=(name:string)=>readFileSync(resolve(root,name),'utf8');
const strip=(raw:string)=>raw.replace(/^import[\s\S]*?;\n/gmu,'');
type Origin={file:string;sha256:string;raw_utf8:string};
type Member={path:string;bytes:number;sha256:string};
type Generated=Member&{origin:string};
const proof=bound as typeof bound&{baseline_manifest:Origin;predecessor_receipt:Origin;normalized_helper_sha256:string;controlled_source_manifest:Member[];publication_outputs_excluded:string[];generated_outputs_excluded_prefixes:string[];predecessor_generated_outputs:Generated[];predecessor_source_report:Origin;source_publication_maintenance:{application:{own_files:Array<{file:string;sha256:string;source:string}>};types:{inputs:{file:string;sha256:string;count:number}};phase_contract:{type_gate_proof_present:boolean;type_gate_helper_pin:string;publication_new_json:string}}};
describe('fixed PHP Wechat open author and real login runtime source preservation',()=>{
 for(const row of proof.sources){
  it('binds complete current and true prior source '+row.file,()=>{
   const raw=read(row.file),before=reverseWechatOpenAuthorSource(row.file,raw);expect(sha(raw)).toBe(row.after_sha256);expect(sha(before)).toBe(row.before_sha256);
   expect(readWechatOpenAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(before);expect(before.replace(row.edits[0]!.before_source,()=>row.edits[0]!.after_source)).toBe(raw);
  });
  it('rejects current drift and forged complete predecessor '+row.file,()=>{
   const raw=read(row.file);for(const altered of [raw.slice(1),raw+'\n',raw+raw])expect(()=>reverseWechatOpenAuthorSource(row.file,altered)).toThrow();
   const fake={...proof,sources:proof.sources.map(value=>value===row?{...value,before_sha256:'0'.repeat(64)}:value)};expect(()=>reverseWechatOpenAuthorSource(row.file,raw,fake)).toThrow();
  });
  if(proof.predecessor_readports.includes(row.file))it('preserves old assertion bodies and negative fixtures '+row.file,()=>{
   const edit=row.edits[0]!;expect(strip(edit.after_source)).toBe(strip(edit.before_source));expect(edit.after_source).not.toBe(edit.before_source);
   expect(edit.after_source).not.toMatch(/from ['"]\.\/helpers\/wechatBaseAuthorSourceBinding['"]/u);
  });
 }
 for(const row of proof.full_additions)it('binds the whole new file '+row.file,()=>{const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(proof.sources.some(value=>value.file===row.file)).toBe(false);});
 for(const row of proof.PHP_sources)it('retains complete fixed PHP source '+row.file,()=>{expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes);expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let index=0;index<frozen.length;index+=64)it('keeps frozen predecessor chunk '+index,()=>{for(const [file,hash]of frozen.slice(index,index+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
 const observed=Object.entries(proof.observed_unchanged);
 for(let index=0;index<observed.length;index+=32)it('keeps untouched consumer chunk '+index,()=>{for(const [file,hash]of observed.slice(index,index+32))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
  it('binds the true8097 inventory and exact changed/new source partition',()=>{
   expect(proof.baseline).toEqual({file_count:8097,sha256:'85af34759537839980c13e63b4deb6bf78506e2a840b69ee08391649a609a4e8'});expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
   const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[],byName=new Map(before.map(value=>[value.path,value]));expect(byName.size).toBe(8097);expect(frozen).toHaveLength(1748);expect(proof.predecessor_readports).toHaveLength(38);expect(new Set(proof.predecessor_readports).size).toBe(38);
   const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
   const names=[...new Set([...inventory,...before.map(value=>value.path)])].filter(name=>name&&!proof.publication_outputs_excluded.includes(name)&&!proof.generated_outputs_excluded_prefixes.some(prefix=>name.startsWith(prefix))).sort();expect(proof.controlled_source_manifest.map(value=>value.path)).toEqual(names);
   const changed:string[]=[],added:string[]=[];for(const row of proof.controlled_source_manifest){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength,row.path).toBe(row.bytes);expect(sha(raw),row.path).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)changed.push(row.path);}
   expect(proof.sources.map(value=>value.file)).toEqual(changed);expect(proof.full_additions.map(value=>value.file)).toEqual(added);
  });
  it('normalizes only this helper own proof pin and freezes the immutable Base helper',()=>{
   const raw=read('workers-ts/test/helpers/wechatOpenAuthorSourceBinding.ts');expect(raw).toMatch(/const WECHAT_OPEN_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u);
   expect(sha(raw.replace(/const WECHAT_OPEN_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u,"const WECHAT_OPEN_AUTHOR_PROOF_SHA='<PIN>';"))).toBe(proof.normalized_helper_sha256);
   expect(sha(read('workers-ts/test/helpers/wechatBaseAuthorSourceBinding.ts'))).toBe('8bb578cb62c304dc204059f4fbf44ec2cd8f6e138267bbd43fff909f89bac6fc');
   expect(sha(read('workers-ts/audit/wechat-base-author-source-binding-20261027.json'))).toBe('83044aa84930da025bc1aeb4f902e4c5824b53a69c0633b443abe874726f0341');
  });
  it('binds both complete ledger publication images to five physical origin records',()=>{
   expect(Object.keys(proof.predecessor_publication_origins).sort()).toEqual(['base_accepted_manifest','base_before_manifest','base_receipt','base_validation_manifest','open_before_manifest']);
   for(const row of Object.values(proof.predecessor_publication_origins)){expect(sha(row.raw_utf8)).toBe(row.sha256);expect(readFileSync(row.file,'utf8')).toBe(row.raw_utf8);}
   const vm=new Map((JSON.parse(proof.predecessor_publication_origins.base_validation_manifest!.raw_utf8)as Member[]).map(value=>[value.path,value]));
   const am=new Map((JSON.parse(proof.predecessor_publication_origins.base_accepted_manifest!.raw_utf8)as Member[]).map(value=>[value.path,value]));
   expect(proof.predecessor_publication.map(value=>value.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);
   for(const row of proof.predecessor_publication){expect(readFileSync(row.validation_origin,'utf8')).toBe(row.validation_source);expect(readFileSync(row.accepted_origin,'utf8')).toBe(row.accepted_source);expect(sha(row.validation_source)).toBe(vm.get(row.file)!.sha256);expect(sha(row.accepted_source)).toBe(am.get(row.file)!.sha256);expect(reverseWechatOpenAuthorPredecessorPublication(row.file,row.accepted_source)).toBe(row.validation_source);expect(readWechatOpenAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(row.validation_source);for(const altered of [row.accepted_source+'\n',row.validation_source,row.accepted_source.slice(1)])expect(()=>reverseWechatOpenAuthorPredecessorPublication(row.file,altered)).toThrow();}
  });
  it('keeps8097 outer8076 Base8057 Menu8033 inner inventory command ports distinct',()=>{
   const args=['ls-files','-co','--exclude-standard','-z'],options={cwd:root,encoding:'utf8'};
   expect(wechatOpenAuthorPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8097);expect(wechatBaseAuthorPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8076);expect(wechatMenuAuthorPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8057);expect(bargainRecordsPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8033);
   expect(()=>wechatOpenAuthorPredecessorExecFileSync('git',['status'],options)).toThrow();expect(()=>wechatOpenAuthorPredecessorExecFileSync('git',args,{...options,cwd:resolve(root,'..')})).toThrow();
  });
  it('routes331 Base329 Menu327 Bargain321 Supplier generated members to exact physical views',()=>{
   const views=[{rows:proof.predecessor_generated_outputs,reader:readWechatOpenAuthorPredecessor,count:331},{rows:(wechatBaseAuthorSourceBinding as typeof wechatBaseAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatBaseAuthorPredecessor,count:329},{rows:(wechatMenuAuthorSourceBinding as typeof wechatMenuAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatMenuAuthorPredecessor,count:327},{rows:(bargainRecordsSourceBinding as typeof bargainRecordsSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readBargainRecordsPredecessor,count:321}];
   for(const view of views){expect(view.rows).toHaveLength(view.count);for(const row of view.rows){const raw=view.reader(resolve(root,row.path));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(sha(readFileSync(row.origin))).toBe(row.sha256);}}
   expect(()=>readWechatOpenAuthorPredecessor(resolve(root,'view/admin-ts/dist/no-pinned-member.js'))).toThrow();
  });
  it('binds the accepted Base5333 actual test identities without moving older receipts',()=>{
   expect(sha(proof.predecessor_receipt.raw_utf8)).toBe('f6ca7c4e4333947061cb5814c61a278a0982cb28fe2b8ae4d708d67ffccb6bbc');expect(JSON.parse(proof.predecessor_receipt.raw_utf8)).toMatchObject({status:'accepted',counts:{source:5333}});
   expect(readFileSync(proof.predecessor_source_report.file,'utf8')).toBe(proof.predecessor_source_report.raw_utf8);expect(sha(proof.predecessor_source_report.raw_utf8)).toBe(proof.predecessor_source_report.sha256);
   const report=JSON.parse(proof.predecessor_source_report.raw_utf8)as{testResults:Array<{name:string;assertionResults:Array<{fullName:string;status:string}>}>};
   const ids=report.testResults.flatMap(file=>file.assertionResults.filter(value=>value.status==='passed').map(value=>file.name.split('/workers-ts/').at(-1)+'\0'+value.fullName));expect(report.testResults).toHaveLength(38);expect(ids).toHaveLength(5333);expect(new Set(ids).size).toBe(5333);
  });
  it('runs actual current AST before archived reports and preserves845 full old variants',()=>{
   const actual=buildAdminFrontendApiAuditReport(),previous=buildWechatOpenAuthorPredecessorApiAuditReport();expect(sha(JSON.stringify(actual,null,2)+'\n')).toBe(proof.current_report.sha256);
   expect(previous.counts.callSites).toBe(807);expect(previous.calls).toHaveLength(845);expect(actual.counts.unregistered).toBe(0);expect(actual.counts.unresolved).toBe(0);expect(proof.retired_api_calls).toEqual([]);
   for(const old of previous.calls)expect(actual.calls).toContainEqual(old);
   const added=actual.calls.filter(value=>value.source.endsWith('/api/wechatOpen.ts'));expect(added).toHaveLength(4);for(const call of added)expect(call).toMatchObject({registered:true,availability:'executable'});
  });
  it('distinguishes fresh type snapshot from later proof JSON and own literal pin publication',()=>{
   const phases=proof.source_publication_maintenance,raw=readFileSync(phases.types.inputs.file,'utf8');expect(sha(raw)).toBe(phases.types.inputs.sha256);const rows=JSON.parse(raw)as Member[];expect(rows).toHaveLength(phases.types.inputs.count);expect(rows.some(value=>value.path==='workers-ts/audit/wechat-open-author-source-binding-20261027.json')).toBe(false);
   expect(phases.phase_contract.type_gate_proof_present).toBe(false);expect(phases.phase_contract.type_gate_helper_pin).toBe('PENDING_WECHAT_OPEN_AUTHOR_PROOF');expect(phases.phase_contract.publication_new_json).toBe('workers-ts/audit/wechat-open-author-source-binding-20261027.json');
   const prior=phases.application.own_files.find(value=>value.file==='workers-ts/test/helpers/wechatOpenAuthorSourceBinding.ts')!;expect(sha(prior.source)).toBe(prior.sha256);expect(rows.find(value=>value.path===prior.file)!.sha256).toBe(prior.sha256);expect(prior.source).toContain("const WECHAT_OPEN_AUTHOR_PROOF_SHA='PENDING_WECHAT_OPEN_AUTHOR_PROOF';");
   const current=read(prior.file),normalize=(value:string)=>value.replace(/const WECHAT_OPEN_AUTHOR_PROOF_SHA='[^']+';/u,"const WECHAT_OPEN_AUTHOR_PROOF_SHA='<PIN>';");expect(normalize(current)).toBe(normalize(prior.source));expect(current).toContain("const WECHAT_OPEN_AUTHOR_PROOF_SHA='"+sha(read('workers-ts/audit/wechat-open-author-source-binding-20261027.json'))+"';");
  });
  it('keeps exactly the two PHP fields and journals only authenticated owner and request UUID',()=>{
   expect(WECHAT_OPEN_KEYS).toEqual(['wechat_open_app_id','wechat_open_app_secret']);expect(WECHAT_OPEN_AUTHORITY_KEY).toBe('wechat_open_credentials_authority');
   const value=parseWechatOpenSave({request_id:'11111111-1111-4111-8111-111111111111',revision:'a'.repeat(64),settings:{wechat_open_app_id:'wx0123456789abcdef'},secrets:{wechat_open_app_secret:{action:'replace',value:'OwnedPrivateReplacement'}},database_credentials:true,confirmed:true});
   expect(wechatOpenPending(value,101)).toEqual({version:1,actor_id:101,request_id:value.request_id});expect(JSON.stringify(wechatOpenPending(value,101))).not.toContain('OwnedPrivateReplacement');
   expect(()=>parseWechatOpenSave({...value,secrets:{wechat_open_app_secret:{action:'keep',value:'hidden'}}})).toThrow();
  });
  it('requires complete disjoint shared envelopes and domain-specific fresh authority',()=>{
   const dispatcher=read('workers-ts/src/controllers/api/v1/AdminWechatBasicsController.ts'),author=read('workers-ts/src/services/admin/AdminWechatOpenService.ts');
   expect(dispatcher).toContain('parseWechatBaseSave(body)');expect(dispatcher).toContain('parseWechatOpenSave(body)');expect(dispatcher).toContain('if (base === open)');expect(dispatcher).toContain('new AdminWechatOpenService');
   expect(author).toContain("withAdminAuthorityWriteTx(this.container, actor, 'wechat_open.manage'");expect(author).toContain('LOCK TABLE ONLY public.system_config IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  });
  it('uses fresh complete credentials with deployment priority and exact database opt-in',()=>{
   const runtime=read('workers-ts/src/services/wechat/OpenPlatformRuntimeConfig.ts');expect(runtime).toContain("deployment !== undefined && deployment !== ''");expect(runtime).toContain("raw(WECHAT_OPEN_AUTHORITY_KEY) === 'database'");expect(runtime).toContain('validWechatOpenAppId(appId)');expect(runtime).toContain('createHmac');expect(runtime).toContain('JSON.stringify({ rows, deployment, authority })');expect(runtime).toContain('version: sql<string>`xmin::text`');expect(runtime).toContain('.limit(65)');expect(runtime).not.toContain('CONFIG_KV.get');expect(runtime).not.toContain('CONFIG_KV.put');
  });
  it('binds state and final identity publication to one account snapshot without provider I/O under the barrier',()=>{
   const oauth=read('workers-ts/src/services/wechat/WechatOpenWebAuthService.ts'),runtime=read('workers-ts/src/services/wechat/OpenPlatformRuntimeConfig.ts'),author=read('workers-ts/src/services/admin/AdminWechatOpenService.ts');
   expect(oauth).toContain('version: 2');expect(oauth).toContain('credentialsStamp: credentials.stamp');expect(oauth).toContain('await this.currentCredentials(config.stamp)');expect(runtime).toContain('pg_try_advisory_xact_lock_shared(731661,0)');expect(author).toContain('pg_try_advisory_xact_lock(731661,0)');expect(runtime).toContain('action(createContainerFromDb(tx), credentials)');expect(runtime).toContain('clock_timestamp() <= transaction_timestamp()');expect(oauth).toContain('clearToken(md5(issuedToken), this.env)');expect(oauth).toContain('crypto.randomUUID()');
  });
  it('keeps default JWT signing stable and uses per-issuance isolation only for Open identity publication',()=>{
   const jwt=read('workers-ts/src/utils/jwt.ts'),login=read('workers-ts/src/services/user/LoginService.ts'),oauth=read('workers-ts/src/services/wechat/WechatOpenWebAuthService.ts');
   expect(jwt).toContain('issuanceNonce?: string');expect(jwt).toContain('issuanceNonce === undefined ? {} : { nonce: issuanceNonce }');expect(login).toContain('onIssued?.(token)');expect(login).toContain('deferAgentLevelEvaluation = false');expect(oauth).toContain('evaluateAgentLevelsAfterRegistration(this.container, committedUid)');
  });
});
