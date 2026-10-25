import { reverseCommerceAuthorSource, reverseCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { reverseEditorialAuthorSource, applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { reverseListAuthorSource, applyListAuthorReport, listAuthorSourceBinding as proof } from './helpers/diyListAuthorSourceBinding';
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
  source = reverseCommerceAuthorSource(file, source);
  source = reverseEditorialAuthorSource(file, source);
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

const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>file===stateAuthorHistorical.previous_report.original_file?stateAuthorHistorical.previous_report.raw_utf8:beforeStateAuthorSource(file,readFileSync(resolve(root,file),'utf8').replace(/\r\n?/gu,'\n')),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const before=JSON.parse(read(proof.previous_report.file)),current=JSON.parse(read(proof.current_report.file));
describe('complete source-bound list author increment retains every historical contract',()=>{
  it('pins immutable predecessor, seven changed production sources and exact complete report reconstruction',()=>{
    expect(sha(read('workers-ts/audit/diy-list-author-source-binding-20261023.json'))).toBe('4ddd06f3bef5ef330d46ec6289b76c81876e2d4da8d5bcd623dca73d540e3149');
    expect(proof.sources.map(row=>row.file)).toEqual(['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','workers-ts/src/controllers/api/v1/AdminDiyAuthorOptionsController.ts','workers-ts/src/services/admin/AdminDiyAuthorOptionsService.ts','workers-ts/src/services/admin/AdminPermissionService.ts','view/admin-ts/src/pages/content/DiseList.vue','view/uniapp-ts/src/components/diy/DiyListProductCard.vue']);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    for(const row of proof.sources){expect(sha(read(row.file))).toBe(row.after_sha256);expect(sha(reverseListAuthorSource(row.file,read(row.file)))).toBe(row.before_sha256);}
    expect(applyListAuthorReport(before)).toEqual(current);expect(reverseCommerceAuthorReport(buildAdminFrontendApiAuditReport())).toEqual(applyEditorialAuthorReport(applyStateAuthorReport(current)));
  });
  it('adds exactly eight GET registrations and four actual Admin calls without discarding old inventory',()=>{
    expect(current.counts).toEqual({...before.counts,callSites:before.counts.callSites+4,pathVariants:before.counts.pathVariants+4,registered:before.counts.registered+4,executable:before.counts.executable+4});
    const arrays=proof.report_reconstruction.arrays,resources=['list-products','list-brands','list-labels','list-article-categories'],routes=arrays.registered_routes!.additions.map(a=>a.value),calls=arrays.calls!.additions.map(a=>a.value);
    expect(routes.map(row=>row.path).sort()).toEqual(['/dise/author-options/','/api/admin/dise/author-options/'].flatMap(prefix=>resources.map(name=>prefix+name)).sort());
    expect(routes.every(row=>row.method==='GET'&&String(row.handler).startsWith('AdminDiyAuthorOptions.'))).toBe(true);
    expect(calls.map(row=>row.path).sort()).toEqual(resources.map(name=>'/dise/author-options/'+name).sort());expect(calls.every(row=>row.source==='view/admin-ts/src/api/diyListAuthor.ts'&&row.registered===true&&row.availability==='executable')).toBe(true);
    expect(arrays.frontend_sources!.additions.map(a=>a.value.file)).toEqual(['view/admin-ts/src/api/diyListAuthor.ts']);expect(current.unregistered).toEqual([]);expect(current.unresolved).toEqual([]);
  });
  for(const row of proof.sources)it.each(['extra-line','duplicate-edit','before-hash','after-hash','location'] as const)('rejects unreviewed %s at '+row.file,kind=>{const p=structuredClone(proof),changed=p.sources.find(r=>r.file===row.file)!;let source=read(row.file);if(kind==='extra-line')source+='\n// unreviewed\n';if(kind==='duplicate-edit')source+=changed.edits[0]!.after_source;if(kind==='before-hash')changed.before_sha256='0'.repeat(64);if(kind==='after-hash')changed.after_sha256='0'.repeat(64);if(kind==='location')changed.edits[0]!.after_line++;expect(()=>reverseListAuthorSource(row.file,source,p)).toThrow();});
  it.each(['counts','route','call','source','methodology'] as const)('rejects complete report predecessor mutation %s',kind=>{const changed=structuredClone(before);if(kind==='counts')changed.counts.registered++;if(kind==='route')changed.backend.registeredRoutes[0].handler='unreviewed';if(kind==='call')changed.calls[0].line++;if(kind==='source')changed.frontendSources[0].sha256='0'.repeat(64);if(kind==='methodology')changed.methodology.scope='unreviewed';expect(()=>applyListAuthorReport(changed)).toThrow();});
  it.each(['counts','addition','row','result-hash'] as const)('rejects proof report mutation %s',kind=>{const p=structuredClone(proof);if(kind==='counts')(p.report_reconstruction.after_counts as Record<string,number>).registered++;if(kind==='addition')p.report_reconstruction.arrays.calls!.additions[0]!.value.path='/unreviewed';if(kind==='row')p.report_reconstruction.arrays.calls!.changes[0]!.before.line=0;if(kind==='result-hash')p.current_report.sha256='0'.repeat(64);expect(()=>applyListAuthorReport(before,p)).toThrow();});
});
