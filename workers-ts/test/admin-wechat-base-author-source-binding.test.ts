import {createHash} from 'node:crypto';
import {readWechatOpenAuthorPredecessor as readFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {wechatOpenAuthorPredecessorExecFileSync as execFileSync} from './helpers/wechatAppAuthorSourceBinding';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {buildWechatOpenAuthorPredecessorApiAuditReport as buildAdminFrontendApiAuditReport} from './helpers/wechatAppAuthorSourceBinding';
import {WECHAT_BASE_PUBLIC_KEYS,WECHAT_BASE_SECRET_KEYS,normalizeWechatBaseValues,parseWechatBaseSave,wechatBasePending} from '../../view/common/wechatBase';
import {wechatBaseAuthorSourceBinding as bound,reverseWechatBaseAuthorSource,reverseWechatBaseAuthorPredecessorPublication,readWechatBaseAuthorPredecessor,readWechatMenuAuthorPredecessor,readBargainRecordsPredecessor,buildWechatBaseAuthorPredecessorApiAuditReport,wechatBaseAuthorPredecessorExecFileSync,wechatMenuAuthorPredecessorExecFileSync,bargainRecordsPredecessorExecFileSync,wechatMenuAuthorSourceBinding,bargainRecordsSourceBinding} from './helpers/wechatAppAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../..');
const sha=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const read=(name:string)=>readFileSync(resolve(root,name),'utf8');
const strip=(raw:string)=>raw.replace(/^import[\s\S]*?;\n/gmu,'');
type Origin={file:string;sha256:string;raw_utf8:string};
type Member={path:string;bytes:number;sha256:string};
type Generated=Member&{origin:string};
const proof=bound as typeof bound&{baseline_manifest:Origin;predecessor_receipt:Origin;normalized_helper_sha256:string;controlled_source_manifest:Member[];publication_outputs_excluded:string[];generated_outputs_excluded_prefixes:string[];predecessor_generated_outputs:Generated[];predecessor_source_report:Origin;source_publication_maintenance:{application:{own_files:Array<{file:string;sha256:string;source:string}>};types:{inputs:{file:string;sha256:string;count:number}};phase_contract:{type_gate_proof_present:boolean;type_gate_helper_pin:string;publication_new_json:string}}};
describe('complete official-account base author and runtime source preservation',()=>{
 for(const row of proof.sources){
  it('binds complete current and true prior source '+row.file,()=>{
   const raw=read(row.file),before=reverseWechatBaseAuthorSource(row.file,raw);expect(sha(raw)).toBe(row.after_sha256);expect(sha(before)).toBe(row.before_sha256);
   expect(readWechatBaseAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(before);expect(before.replace(row.edits[0]!.before_source,()=>row.edits[0]!.after_source)).toBe(raw);
  });
  it('rejects current drift and forged complete predecessor '+row.file,()=>{
   const raw=read(row.file);for(const altered of [raw.slice(1),raw+'\n',raw+raw])expect(()=>reverseWechatBaseAuthorSource(row.file,altered)).toThrow();
   const fake={...proof,sources:proof.sources.map(x=>x===row?{...x,before_sha256:'0'.repeat(64)}:x)};expect(()=>reverseWechatBaseAuthorSource(row.file,raw,fake)).toThrow();
  });
  if(proof.predecessor_readports.includes(row.file))it('preserves old assertion bodies and negative fixtures '+row.file,()=>{
   const edit=row.edits[0]!;expect(strip(edit.after_source)).toBe(strip(edit.before_source));expect(edit.after_source).not.toBe(edit.before_source);
   expect(edit.after_source).not.toMatch(/from ['"]\.\/helpers\/wechatMenuAuthorSourceBinding['"]/u);
  });
 }
 for(const row of proof.full_additions)it('binds the whole new file '+row.file,()=>{const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(proof.sources.some(x=>x.file===row.file)).toBe(false);});
 for(const row of proof.PHP_sources)it('retains complete fixed PHP source '+row.file,()=>{expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(row.raw_utf8)).toBe(row.sha256);expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes);expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let i=0;i<frozen.length;i+=64)it('keeps frozen predecessor chunk '+i,()=>{for(const [file,hash]of frozen.slice(i,i+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
 const observed=Object.entries(proof.observed_unchanged);
 for(let i=0;i<observed.length;i+=32)it('keeps untouched consumer chunk '+i,()=>{for(const [file,hash]of observed.slice(i,i+32))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);});
  it('binds the true8076 inventory and exact changed/new source partition',()=>{
   expect(proof.baseline).toEqual({file_count:8076,sha256:'23e138592d0a4dc67e08cc670ae78eb79438292972d2a287ca566a2f5bc5204a'});expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
   const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Member[],byName=new Map(before.map(x=>[x.path,x]));expect(byName.size).toBe(8076);expect(frozen).toHaveLength(1745);expect(proof.predecessor_readports).toHaveLength(37);expect(new Set(proof.predecessor_readports).size).toBe(37);
   const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
   const names=[...new Set([...inventory,...before.map(x=>x.path)])].filter(name=>name&&!proof.publication_outputs_excluded.includes(name)&&!proof.generated_outputs_excluded_prefixes.some(prefix=>name.startsWith(prefix))).sort();expect(proof.controlled_source_manifest.map(x=>x.path)).toEqual(names);
   const changed:string[]=[],added:string[]=[];for(const row of proof.controlled_source_manifest){const raw=readFileSync(resolve(root,row.path));expect(raw.byteLength,row.path).toBe(row.bytes);expect(sha(raw),row.path).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)changed.push(row.path);}
   expect(proof.sources.map(x=>x.file)).toEqual(changed);expect(proof.full_additions.map(x=>x.file)).toEqual(added);
  });
  it('normalizes only this helper own proof pin and freezes the immutable Menu helper',()=>{
   const raw=read('workers-ts/test/helpers/wechatBaseAuthorSourceBinding.ts');expect(raw).toMatch(/const WECHAT_BASE_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u);
   expect(sha(raw.replace(/const WECHAT_BASE_AUTHOR_PROOF_SHA='[a-f0-9]{64}';/u,"const WECHAT_BASE_AUTHOR_PROOF_SHA='<PIN>';"))).toBe(proof.normalized_helper_sha256);
   expect(sha(read('workers-ts/test/helpers/wechatMenuAuthorSourceBinding.ts'))).toBe('7fe34e23ea6859d39722b9f41e7522c545a2376b4231d00a1e09cffe49bd7e75');
  });
  it('binds both complete ledger publication images to five physical origin records',()=>{
   expect(Object.keys(proof.predecessor_publication_origins).sort()).toEqual(['base_before_manifest','menu_accepted_manifest','menu_before_manifest','menu_receipt','menu_validation_manifest']);for(const row of Object.values(proof.predecessor_publication_origins)){expect(sha(row.raw_utf8)).toBe(row.sha256);expect(readFileSync(row.file,'utf8')).toBe(row.raw_utf8);}
   const vm=new Map((JSON.parse(proof.predecessor_publication_origins.menu_validation_manifest!.raw_utf8)as Member[]).map(x=>[x.path,x]));const am=new Map((JSON.parse(proof.predecessor_publication_origins.menu_accepted_manifest!.raw_utf8)as Member[]).map(x=>[x.path,x]));expect(proof.predecessor_publication.map(x=>x.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);
   for(const row of proof.predecessor_publication){expect(readFileSync(row.validation_origin,'utf8')).toBe(row.validation_source);expect(readFileSync(row.accepted_origin,'utf8')).toBe(row.accepted_source);expect(sha(row.validation_source)).toBe(vm.get(row.file)!.sha256);expect(sha(row.accepted_source)).toBe(am.get(row.file)!.sha256);expect(reverseWechatBaseAuthorPredecessorPublication(row.file,row.accepted_source)).toBe(row.validation_source);expect(readWechatBaseAuthorPredecessor(resolve(root,row.file),'utf8')).toBe(row.validation_source);for(const altered of [row.accepted_source+'\n',row.validation_source,row.accepted_source.slice(1)])expect(()=>reverseWechatBaseAuthorPredecessorPublication(row.file,altered)).toThrow();}
  });
  it('keeps8076 outer8057 middle8033 inner inventory command ports distinct',()=>{
   const args=['ls-files','-co','--exclude-standard','-z'],options={cwd:root,encoding:'utf8'};expect(wechatBaseAuthorPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8076);expect(wechatMenuAuthorPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8057);expect(bargainRecordsPredecessorExecFileSync('git',args,options).split('\0').filter(Boolean)).toHaveLength(8033);expect(()=>wechatBaseAuthorPredecessorExecFileSync('git',['status'],options)).toThrow();expect(()=>wechatBaseAuthorPredecessorExecFileSync('git',args,{...options,cwd:resolve(root,'..')})).toThrow();
  });
  it('routes329 Menu327 Bargain321 Supplier generated members to exact physical views',()=>{
   const views=[{rows:proof.predecessor_generated_outputs,reader:readWechatBaseAuthorPredecessor,count:329},{rows:(wechatMenuAuthorSourceBinding as typeof wechatMenuAuthorSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readWechatMenuAuthorPredecessor,count:327},{rows:(bargainRecordsSourceBinding as typeof bargainRecordsSourceBinding&{predecessor_generated_outputs:Generated[]}).predecessor_generated_outputs,reader:readBargainRecordsPredecessor,count:321}];
   for(const view of views){expect(view.rows).toHaveLength(view.count);for(const row of view.rows){const raw=view.reader(resolve(root,row.path));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);expect(sha(readFileSync(row.origin))).toBe(row.sha256);}}
   expect(()=>readWechatBaseAuthorPredecessor(resolve(root,'view/admin-ts/dist/no-pinned-member.js'))).toThrow();
  });
  it('binds the accepted Menu5074 actual test identities without moving older receipts',()=>{
   expect(sha(proof.predecessor_receipt.raw_utf8)).toBe('f16388c6d47cb90b88e12a76beaf27902d03e19154d425d9922db993341702aa');expect(JSON.parse(proof.predecessor_receipt.raw_utf8)).toMatchObject({status:'accepted',counts:{source:5074}});expect(readFileSync(proof.predecessor_source_report.file,'utf8')).toBe(proof.predecessor_source_report.raw_utf8);expect(sha(proof.predecessor_source_report.raw_utf8)).toBe(proof.predecessor_source_report.sha256);
   const report=JSON.parse(proof.predecessor_source_report.raw_utf8)as{testResults:Array<{name:string;assertionResults:Array<{fullName:string;status:string}>}>};const ids=report.testResults.flatMap(file=>file.assertionResults.filter(x=>x.status==='passed').map(x=>file.name.split('/workers-ts/').at(-1)+'\0'+x.fullName));expect(report.testResults).toHaveLength(37);expect(ids).toHaveLength(5074);expect(new Set(ids).size).toBe(5074);
  });
  it('runs actual current AST before archived reports and preserves839 full old variants',()=>{
   const actual=buildAdminFrontendApiAuditReport(),previous=buildWechatBaseAuthorPredecessorApiAuditReport();expect(sha(JSON.stringify(actual,null,2)+'\n')).toBe(proof.current_report.sha256);expect(previous.counts.callSites).toBe(801);expect(previous.calls).toHaveLength(839);expect(actual.counts.callSites).toBe(807);expect(actual.calls).toHaveLength(845);expect(actual.counts.unregistered).toBe(0);expect(actual.counts.unresolved).toBe(0);expect(proof.retired_api_calls).toEqual([]);for(const old of previous.calls)expect(actual.calls).toContainEqual(old);expect(actual.calls.filter(x=>x.source.endsWith('/api/wechatBase.ts'))).toHaveLength(6);
  });
  it('distinguishes the fresh type snapshot from the later proof JSON and own literal pin publication',()=>{
   const phases=proof.source_publication_maintenance,raw=readFileSync(phases.types.inputs.file,'utf8');expect(sha(raw)).toBe(phases.types.inputs.sha256);const rows=JSON.parse(raw)as Member[];expect(rows).toHaveLength(phases.types.inputs.count);expect(rows.some(x=>x.path==='workers-ts/audit/wechat-base-author-source-binding-20261027.json')).toBe(false);
   expect(phases.phase_contract.type_gate_proof_present).toBe(false);expect(phases.phase_contract.type_gate_helper_pin).toBe('PENDING_WECHAT_BASE_AUTHOR_PROOF');expect(phases.phase_contract.publication_new_json).toBe('workers-ts/audit/wechat-base-author-source-binding-20261027.json');
   const prior=phases.application.own_files.find(x=>x.file==='workers-ts/test/helpers/wechatBaseAuthorSourceBinding.ts')!;expect(sha(prior.source)).toBe(prior.sha256);expect(rows.find(x=>x.path===prior.file)!.sha256).toBe(prior.sha256);expect(prior.source).toContain("const WECHAT_BASE_AUTHOR_PROOF_SHA='PENDING_WECHAT_BASE_AUTHOR_PROOF';");
   const current=read(prior.file),normalize=(value:string)=>value.replace(/const WECHAT_BASE_AUTHOR_PROOF_SHA='[^']+';/u,"const WECHAT_BASE_AUTHOR_PROOF_SHA='<PIN>';");expect(normalize(current)).toBe(normalize(prior.source));expect(current).toContain("const WECHAT_BASE_AUTHOR_PROOF_SHA='"+sha(read('workers-ts/audit/wechat-base-author-source-binding-20261027.json'))+"';");
  });
  it('keeps six public fields and three secret intents as the complete original writable form',()=>{
   expect(WECHAT_BASE_PUBLIC_KEYS).toEqual(['wechat_appid','wechat_encode','share_qrcode','spread_share_forever','wechat_qrcode','create_wechat_user']);expect(WECHAT_BASE_SECRET_KEYS).toEqual(['wechat_appsecret','wechat_encodingaeskey','wechat_token']);
   for(const mode of [0,1,2])expect(normalizeWechatBaseValues({wechat_appid:'',wechat_encode:mode,share_qrcode:0,spread_share_forever:0,wechat_qrcode:'',create_wechat_user:1}).wechat_encode).toBe(mode);
  });
  it('journals only owner and UUID rather than replacement material or its hash',()=>{
   const action=parseWechatBaseSave({request_id:'11111111-1111-4111-8111-111111111111',revision:'a'.repeat(64),settings:{wechat_appid:'',wechat_encode:0,share_qrcode:0,spread_share_forever:0,wechat_qrcode:'',create_wechat_user:1},secrets:{wechat_appsecret:{action:'replace',value:'PrivateReplacement'},wechat_encodingaeskey:{action:'clear'},wechat_token:{action:'keep'}},database_callback:false,confirmed:true});
   expect(wechatBasePending(action,101)).toEqual({version:1,actor_id:101,request_id:action.request_id});expect(JSON.stringify(wechatBasePending(action,101))).not.toContain('PrivateReplacement');expect(()=>parseWechatBaseSave({...action,secrets:{...action.secrets,wechat_token:{action:'keep',value:'Unexpected'}}})).toThrow();
  });
  it('preserves deployment priority and requires exact explicit database authority without mini fallback',()=>{
   const runtime=read('workers-ts/src/services/wechat/OfficialAccountRuntimeConfig.ts'),callback=read('workers-ts/src/services/wechat/WechatCallbackService.ts');expect(runtime).toContain('WECHAT_OFFICIAL_CALLBACK_TOKEN || env.WECHAT_OFFICIAL_CALLBACK_AES_KEY');expect(runtime).toContain("raw(WECHAT_BASE_CALLBACK_AUTHORITY_KEY) !== 'database'");expect(runtime).toContain("mode: 2, authority: 'deployment'");expect(callback).toContain('receiveOfficial');expect(callback).toContain('receiveEncrypted');expect(callback).toContain('receiveNormalized');
  });
  it('stamps the complete same-snapshot credential rows and namespaces access tokens and tickets',()=>{
   const runtime=read('workers-ts/src/services/wechat/OfficialAccountRuntimeConfig.ts');expect(runtime).toContain('readOfficialAccountCredentialsInTx');expect(runtime).toContain('createHmac');expect(runtime).toContain('JSON.stringify(rows)');expect(runtime).toContain('rowVersion: sql<string>`xmin::text`');expect(runtime).toContain('.limit(65)');expect(runtime).toContain("'access-token' | 'jsapi-ticket'");expect(runtime).not.toContain('CONFIG_KV');
   for(const file of ['OfficialAccountQrcodeService.ts','WechatAuthService.ts','WechatNotificationProvider.ts'])expect(read('workers-ts/src/services/wechat/'+file)).toContain('officialCredentialCacheKey');
  });
  it('coordinates permanent QR publication through the current App-safe advisory protocol',()=>{
   const qr=read('workers-ts/src/services/wechat/OfficialAccountQrcodeService.ts'),author=read('workers-ts/src/services/admin/AdminWechatBaseService.ts');expect(qr).toContain('pg_try_advisory_xact_lock_shared(731659,0)');expect(author).toContain('pg_try_advisory_xact_lock(731659,0)');expect(qr).not.toMatch(/LOCK TABLE[^\n]*systemConfig/u);expect(qr).toContain('currentCredentials.stamp !== credentials.stamp');expect(qr).toContain('await this.synchronizeTarget(tx,');expect(qr).toContain('maintenance/raw SQL writers are outside this advisory protocol');
  });
  it('keeps derived API and existing QR history distinct from stored public and secret fields',()=>{
   const page=read('view/admin-ts/src/pages/content/WechatBaseAuthor.vue'),author=read('workers-ts/src/services/admin/AdminWechatBaseService.ts');expect(page).toContain('公众号基础设置');expect(page).toContain('wechatBasePending');expect(author).toContain('LOCK TABLE ONLY public.qrcode IN SHARE ROW EXCLUSIVE MODE NOWAIT');expect(author).toContain("input.settings.wechat_appid !== this.text(before, 'wechat_appid')");expect(author).toContain('ticket');
  });
});
