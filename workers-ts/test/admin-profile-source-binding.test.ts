import { readPlatformMenuPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlatformMenuPredecessorApiAuditReport as buildAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
import { adminProfileSourceBinding as proof, reverseAdminProfileSource, readAdminProfilePredecessor,
  readAdminProfileThenErrorPagesPredecessor, readAdminProfileThenErrorPagesThenBrowserLogPredecessor,
  readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor } from './helpers/wechatAppAuthorSourceBinding';
import { reverseErrorPagesSource } from './helpers/errorPagesSourceBinding';
import { reverseBrowserLogSource } from './helpers/browserLogSourceBinding';
import { reverseConfigClassSource } from './helpers/configClassSourceBinding';
const root=resolve(import.meta.dirname,'../..'),read=(f:string)=>readFileSync(resolve(root,f),'utf8'),sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
describe('complete Admin profile PHP provenance, exact additive production sources and preserved historical assertions',()=>{
 for(const entry of proof.sources){
  it(`pins complete actual source and reversible predecessor ${entry.file}`,()=>{const current=read(entry.file);expect(sha(current)).toBe(entry.after_sha256);expect(sha(reverseAdminProfileSource(entry.file,current))).toBe(entry.before_sha256);expect(sha(readAdminProfilePredecessor(resolve(root,entry.file)))).toBe(entry.before_sha256);});
  it(`rejects truncation, append, duplicate or forged source ${entry.file}`,()=>{for(const current of [read(entry.file).slice(1),read(entry.file)+'\n// unreviewed\n',read(entry.file)+read(entry.file)])expect(()=>reverseAdminProfileSource(entry.file,current)).toThrow();const bad=structuredClone(proof);bad.sources.find(r=>r.file===entry.file)!.before_sha256='0'.repeat(64);expect(()=>reverseAdminProfileSource(entry.file,read(entry.file),bad)).toThrow();});
  if(entry.file.startsWith('workers-ts/test/'))it(`preserves all historical assertions and negative fixtures ${entry.file}`,()=>{const strip=(s:string)=>s.split('\n').filter(line=>!line.startsWith('import ')).join('\n');expect(strip(entry.edits[0]!.after_source)).toBe(strip(entry.edits[0]!.before_source));});
 }
 for(const entry of proof.full_additions)it(`pins complete new implementation or real runtime suite ${entry.file}`,()=>{const raw=readFileSync(resolve(root,entry.file));expect(raw.byteLength).toBe(entry.bytes);expect(sha(raw)).toBe(entry.sha256);});
 for(const entry of proof.PHP_sources)it(`binds full fixed PHP original ${entry.file}`,()=>{expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');expect(sha(entry.raw_utf8)).toBe(entry.sha256);expect(new TextEncoder().encode(entry.raw_utf8).byteLength).toBe(entry.bytes);});
 const frozen=Object.entries(proof.frozen_predecessor_evidence);
 for(let start=0;start<frozen.length;start+=64)it(`keeps all dated predecessor bytes ${start+1}..${Math.min(start+64,frozen.length)}`,()=>{
  for(const [file,hash]of frozen.slice(start,start+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
 });
 it('uses the actual current AST inventory with precisely eight additive calls and no unavailable/unregistered/unresolved path',()=>{
  const report=buildAdminFrontendApiAuditReport(),current=read(proof.current_report.file);expect(JSON.stringify(report,null,2)+'\n').toBe(current);expect(sha(current)).toBe(proof.current_report.sha256);
  const previous=JSON.parse(proof.previous_report.raw_utf8);expect(sha(proof.previous_report.raw_utf8)).toBe(proof.previous_report.sha256);expect(report.counts).toEqual({callSites:717,pathVariants:755,registered:755,executable:755,controlledUnavailable:0,unregistered:0,unresolved:0});
  for(const call of previous.calls)expect(report.calls).toContainEqual(call);
  expect(report.calls.filter(call=>call.source==='view/admin-ts/src/api/profile.ts')).toHaveLength(8);
 });
 it('composes complete current -> exception -> browser-log -> config-class sources without editing historical helpers',()=>{
  for(const file of ['view/admin-ts/src/router/index.ts','.github/workflows/workers-runtime-linux.yml']){
   const profile=reverseAdminProfileSource(file,read(file)),error=reverseErrorPagesSource(file,profile),browser=reverseBrowserLogSource(file,error);
   expect(readAdminProfileThenErrorPagesPredecessor(resolve(root,file),'utf8')).toBe(error);
   expect(readAdminProfileThenErrorPagesThenBrowserLogPredecessor(resolve(root,file),'utf8')).toBe(browser);
   expect(readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor(resolve(root,file),'utf8')).toBe(reverseConfigClassSource(file,browser));
  }
 });
 it('retains the original shared auth/credential/attachment/SMS implementations and registers only self-owned operations',()=>{
  for(const f of ['view/admin-ts/src/utils/auth.ts','view/admin-ts/src/utils/request.ts','view/admin-ts/src/stores/auth.ts','workers-ts/src/middleware/admin-auth.ts','workers-ts/src/middleware/admin-runtime-auth.ts','workers-ts/src/services/message/SmsVerificationService.ts','workers-ts/src/services/system/AttachmentService.ts']){expect(proof.sources.some(row=>row.file===f)).toBe(false);expect(sha(readFileSync(resolve(root,f)))).toBe(proof.observed_unchanged[f]);}
  expect(read('.github/workflows/workers-runtime-linux.yml')).toContain('npm run test:profile');
  expect(JSON.parse(read('view/admin-ts/package.json')).scripts['test:profile']).toContain('--test-concurrency=1');
 });
});
