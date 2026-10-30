import { createHash } from 'node:crypto';
import { readWechatMenuAuthorPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { wechatMenuAuthorPredecessorExecFileSync as execFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWechatMenuAuthorPredecessorApiAuditReport as buildAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
import { bargainRecordsSourceBinding as bound, reverseBargainRecordsSource, reverseBargainRecordsPredecessorPublication,
  readBargainRecordsPredecessor, buildBargainRecordsPredecessorApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const root=resolve(import.meta.dirname,'../..'), sha=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const read=(file:string)=>readFileSync(resolve(root,file),'utf8');
type Origin={file:string;raw_utf8:string;sha256:string};
const proof=bound as typeof bound & { baseline_manifest:Origin; predecessor_receipt:Origin;
  controlled_source_manifest:Array<{path:string;bytes:number;sha256:string}>; publication_outputs_excluded:string[];
  generated_outputs_excluded_prefixes:string[]; normalized_helper_sha256:string };
const strip=(source:string)=>source.replace(/^import[\s\S]*?;\n/gmu,'');
describe('complete bargain records current source and immutable predecessor evidence',()=>{
  for(const row of proof.sources) {
    it('binds whole current and prior source '+row.file,()=>{
      const raw=read(row.file); expect(sha(raw)).toBe(row.after_sha256);
      expect(sha(reverseBargainRecordsSource(row.file,raw))).toBe(row.before_sha256);
      expect(readBargainRecordsPredecessor(resolve(root,row.file),'utf8')).toBe(row.edits[0]!.before_source);
    });
    it('rejects changed current or forged whole predecessor '+row.file,()=>{
      const raw=read(row.file); for(const wrong of [raw.slice(1),raw+'\n',raw+raw])expect(()=>reverseBargainRecordsSource(row.file,wrong)).toThrow();
      const wrong={...proof,sources:proof.sources.map(item=>item===row?{...item,before_sha256:'0'.repeat(64)}:item)};
      expect(()=>reverseBargainRecordsSource(row.file,raw,wrong)).toThrow();
    });
    if(proof.predecessor_readports.includes(row.file))it('preserves old source assertions and negative fixtures '+row.file,()=>{
      const edit=row.edits[0]!; expect(strip(edit.after_source)).toBe(strip(edit.before_source));
      expect(edit.after_source).not.toBe(edit.before_source);
    });
  }
  for(const row of proof.full_additions)it('binds complete new file '+row.file,()=>{
    const raw=readFileSync(resolve(root,row.file));expect(raw.byteLength).toBe(row.bytes);expect(sha(raw)).toBe(row.sha256);
    expect(proof.sources.some(item=>item.file===row.file)).toBe(false);
  });
  for(const row of proof.PHP_sources)it('retains full fixed active PHP source '+row.file,()=>{
    expect(sha(row.raw_utf8)).toBe(row.sha256);expect(Buffer.byteLength(row.raw_utf8)).toBe(row.bytes);
    expect(row.git_blob).toMatch(/^[a-f0-9]{40}$/u);expect(proof.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
  });
  const frozen=Object.entries(proof.frozen_predecessor_evidence);
  for(let i=0;i<frozen.length;i+=64)it('preserves immutable evidence chunk '+i,()=>{
    for(const[file,hash]of frozen.slice(i,i+64))expect(sha(readFileSync(resolve(root,file))),file).toBe(hash);
  });
  it('binds the actual 8033-file baseline, all current controlled membership and exact changed/new partition',()=>{
    expect(proof.baseline).toEqual({file_count:8033,sha256:'5f3f5b15edd60ea445a869644f377fb110f3e04cf3b7319a607ae7d05edd06a2'});
    expect(sha(proof.baseline_manifest.raw_utf8)).toBe(proof.baseline.sha256);
    const before=JSON.parse(proof.baseline_manifest.raw_utf8)as Array<{path:string;bytes:number;sha256:string}>, byName=new Map(before.map(row=>[row.path,row]));
    expect(byName.size).toBe(8033);expect(frozen).toHaveLength(1739);expect(proof.predecessor_readports).toHaveLength(35);
    const inventory=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0');
    const names=[...new Set([...inventory,...before.map(row=>row.path)])].filter(file=>file&&!proof.publication_outputs_excluded.includes(file)&&!proof.generated_outputs_excluded_prefixes.some(prefix=>file.startsWith(prefix))).sort();
    expect(proof.controlled_source_manifest.map(row=>row.path)).toEqual(names);
    const changed:string[]=[],added:string[]=[];
    for(const row of proof.controlled_source_manifest){const bytes=readFileSync(resolve(root,row.path));expect(bytes.byteLength,row.path).toBe(row.bytes);expect(sha(bytes),row.path).toBe(row.sha256);if(!byName.has(row.path))added.push(row.path);else if(byName.get(row.path)!.sha256!==row.sha256)changed.push(row.path);}
    expect(proof.sources.map(row=>row.file)).toEqual(changed);expect(proof.full_additions.map(row=>row.file)).toEqual(added);
    const receipt=JSON.parse(proof.predecessor_receipt.raw_utf8)as {status:string;counts:{source:number}};
    expect(sha(proof.predecessor_receipt.raw_utf8)).toBe('969f878b0846555b0eafb1a7eb6505ac642bdca0e335faab54cb914bf8352f2d');expect(receipt.status).toBe('accepted');expect(receipt.counts.source).toBe(4681);
  });
  it('binds the new helper with only its self-proof pin normalized',()=>{
    const raw=read('workers-ts/test/helpers/bargainRecordsSourceBinding.ts');
    expect(raw).toMatch(/const BARGAIN_RECORDS_PROOF_SHA='[a-f0-9]{64}';/u);
    expect(sha(raw.replace(/const BARGAIN_RECORDS_PROOF_SHA='[a-f0-9]{64}';/u,"const BARGAIN_RECORDS_PROOF_SHA='<PIN>';"))).toBe(proof.normalized_helper_sha256);
  });
  it('retains full physical predecessor ledger publication images and their manifest origins',()=>{
    expect(proof.predecessor_publication.map(row=>row.file)).toEqual(['MIGRATION_AUDIT.md','MIGRATION_CHECKLIST.md']);
    for(const origin of Object.values(proof.predecessor_publication_origins)){expect(sha(origin.raw_utf8)).toBe(origin.sha256);expect(readFileSync(origin.file,'utf8')).toBe(origin.raw_utf8);}
    for(const row of proof.predecessor_publication){expect(readFileSync(row.validation_origin,'utf8')).toBe(row.validation_source);expect(readFileSync(row.accepted_origin,'utf8')).toBe(row.accepted_source);expect(sha(row.validation_source)).toBe(row.validation_sha256);expect(sha(row.accepted_source)).toBe(row.accepted_sha256);expect(reverseBargainRecordsPredecessorPublication(row.file,row.accepted_source)).toBe(row.validation_source);expect(()=>reverseBargainRecordsPredecessorPublication(row.file,row.accepted_source+'\n')).toThrow();}
  });
  it('runs the real current API inventory and preserves every previous complete call object',()=>{
    const current=buildAdminFrontendApiAuditReport(), previous=buildBargainRecordsPredecessorApiAuditReport();
    expect(sha(JSON.stringify(current,null,2)+'\n')).toBe(proof.current_report.sha256);
    expect(current.counts.unregistered).toBe(0);expect(current.counts.unresolved).toBe(0);
    expect(previous.calls).toHaveLength(827);expect(proof.retired_api_calls).toEqual([]);
    for(const old of previous.calls)expect(current.calls).toContainEqual(old);
    expect(current.calls.filter(row=>row.source.endsWith('/api/bargainRecords.ts'))).toHaveLength(6);
  });
});
