import { reverseListAuthorSource, applyListAuthorReport, listAuthorSourceBinding as listProof } from './helpers/diyListAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { reverseCarouselAuthorSource, applyCarouselAuthorReport, carouselAuthorSourceBinding as proof } from './helpers/diyCarouselAuthorSourceBinding';
// Exact additive state-author adapter; original definitions and dated proofs below remain intact.
const stateAuthorHistoricalRaw = readFileSync(resolve(import.meta.dirname, 'fixtures/diy-state-author-historical-bindings-20261024.json'), 'utf8');
const stateAuthorHash = (value: string) => createHash('sha256').update(value).digest('hex');
if (stateAuthorHash(stateAuthorHistoricalRaw) !== '8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9') throw Error('State historical fixture bytes differ');
const stateAuthorHistorical = JSON.parse(stateAuthorHistoricalRaw) as {
  source: RouteSourceFollowup & { file: string };
  previous_report: { original_file: string; sha256: string; raw_utf8: string };
  current_report: { file: string; sha256: string };
  report_changes: Array<{ array: 'frontendSources' | 'calls'; index: number; before: Record<string, unknown>; after: Record<string, unknown> }>;
};
if (stateAuthorHash(stateAuthorHistorical.previous_report.raw_utf8) !== '31c8996982ab02e35fa6b7a30910ed1d915a807a3e3f10006d8b42258dd79a73') throw Error('Archived complete list report bytes differ');
function beforeStateAuthorSource(file: string, source: string): string {
  return file === stateAuthorHistorical.source.file ? reverseRouteSourceFollowup(source, stateAuthorHistorical.source) : source;
}
function applyStateAuthorReport<T>(before: T): T {
  if (stateAuthorHash(JSON.stringify(before, null, 2) + '\n') !== stateAuthorHistorical.previous_report.sha256) throw Error('State report complete predecessor differs');
  const updated = structuredClone(before) as unknown as { frontendSources: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>> };
  for (const change of stateAuthorHistorical.report_changes) {
    const values = updated[change.array];
    if (!['frontendSources', 'calls'].includes(change.array) || JSON.stringify(values?.[change.index]) !== JSON.stringify(change.before)) throw Error('State report exact predecessor row differs');
    values[change.index] = structuredClone(change.after);
  }
  if (stateAuthorHash(JSON.stringify(updated, null, 2) + '\n') !== stateAuthorHistorical.current_report.sha256) throw Error('State report complete result differs');
  return updated as unknown as T;
}

const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>beforeStateAuthorSource(file,readFileSync(resolve(root,file),'utf8').replace(/\r\n?/gu,'\n')),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const before=JSON.parse(read(proof.previous_report.file)),current=JSON.parse(read(listProof.previous_report.file));
describe('whole-source-bound carousel author integration preserves complete historical API inventory',()=>{
  it('pins exact proof, immutable predecessor archive, current report and three unique source edits',()=>{
    expect(sha(read('workers-ts/audit/diy-carousel-author-source-binding-20261023.json'))).toBe('e09f9227d29faa4932810e66e12d4c1d57c5d4db6e233ce29284b3253b4dd0b6');
    expect(proof.sources.map(row=>row.file)).toEqual(['view/admin-ts/src/pages/content/DiseList.vue']);expect(proof.sources[0]!.edits).toHaveLength(3);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);expect(sha(read(listProof.previous_report.file))).toBe(proof.current_report.sha256);
    for(const row of proof.sources){expect(sha(reverseListAuthorSource(row.file,read(row.file)))).toBe(row.after_sha256);expect(sha(reverseCarouselAuthorSource(row.file,reverseListAuthorSource(row.file,read(row.file))))).toBe(row.before_sha256);}
  });
  it('reconstructs every old route/call/resource using only one exact source hash and three shifted call lines',()=>{
    expect(applyCarouselAuthorReport(before)).toEqual(current);expect(buildAdminFrontendApiAuditReport()).toEqual(applyStateAuthorReport(applyListAuthorReport(current)));expect(current.counts).toEqual(before.counts);expect(current.backend).toEqual(before.backend);expect(current.counts).toMatchObject({callSites:699,pathVariants:737,registered:737,unregistered:0,unresolved:0});
    expect(proof.report_changes.filter(c=>c.array==='frontendSources')).toHaveLength(1);expect(proof.report_changes.filter(c=>c.array==='calls')).toHaveLength(3);
    for(const change of proof.report_changes){expect(change.after.file??change.after.source).toBe('view/admin-ts/src/pages/content/DiseList.vue');const old={...change.before},next={...change.after};if(change.array==='calls'){delete old.line;delete next.line;}else{delete old.sha256;delete next.sha256;}expect(next).toEqual(old);}
  });
  it.each(['extra-line','duplicate-editor','canonicalizer','before-hash','after-hash','location'] as const)('rejects unreviewed %s before any historical inverse',kind=>{
    const altered=structuredClone(proof),row=altered.sources[0]!;let source=reverseListAuthorSource(row.file,read(row.file));
    if(kind==='extra-line')source+='\n// unreviewed\n';if(kind==='duplicate-editor')source+=row.edits[0]!.after_source;if(kind==='canonicalizer')source=source.replace('canonicalCarouselValue(canonicalNavigationValue','canonicalNavigationValue');if(kind==='before-hash')row.before_sha256='0'.repeat(64);if(kind==='after-hash')row.after_sha256='0'.repeat(64);if(kind==='location')row.edits[0]!.after_line++;
    expect(()=>reverseCarouselAuthorSource(row.file,source,altered)).toThrow();
  });
  it.each(['counts','source','call-line'])('rejects changed report predecessor %s',kind=>{const altered=structuredClone(before);if(kind==='counts')altered.counts.registered++;else{const change=proof.report_changes.find(c=>c.array===(kind==='source'?'frontendSources':'calls'))!;altered[change.array][change.index][kind==='source'?'sha256':'line']='unreviewed';}expect(()=>applyCarouselAuthorReport(altered)).toThrow();});
});
