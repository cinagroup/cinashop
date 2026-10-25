import { reverseCommunityAuthorSource, reverseCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { reverseCommerceAuthorSource, reverseCommerceAuthorReport } from './helpers/diyCommerceAuthorSourceBinding';
import { reverseEditorialAuthorSource, applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { reverseListAuthorSource, applyListAuthorReport } from './helpers/diyListAuthorSourceBinding';
import { reverseCarouselAuthorSource, applyCarouselAuthorReport, carouselAuthorSourceBinding as carouselProof } from './helpers/diyCarouselAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { reverseNavigationAuthorSource, applyNavigationAuthorReport, navigationAuthorSourceBinding as proof } from './helpers/diyNavigationAuthorSourceBinding';
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
  source = reverseCommunityAuthorSource(file, source);
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

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => beforeStateAuthorSource(file, readFileSync(resolve(root, file), 'utf8').replace(/\r\n?/g, '\n'));
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const sourceFile = 'workers-ts/audit/diy-navigation-author-source-binding-20261023.json';
const previous = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(carouselProof.previous_report.file));
describe('exact additive navigation author source and API inventory increment', () => {
  it('pins the full new proof, three exact source inverses and the immutable preceding current report', () => {
    expect(sha(read(sourceFile))).toBe('91d6a8f07f1330ddabceff904a9ace6fe4c5641756b9faee838c4a117f3f99fd');
    expect(proof.sources.map(row => row.file)).toEqual(['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','view/admin-ts/src/pages/content/DiseList.vue']);
    expect(proof.sources.map(row => row.edits.length)).toEqual([2,2,3]);
    for (const row of proof.sources) { expect(sha(reverseCarouselAuthorSource(row.file,reverseListAuthorSource(row.file,read(row.file))))).toBe(row.after_sha256); expect(sha(reverseNavigationAuthorSource(row.file,reverseCarouselAuthorSource(row.file,reverseListAuthorSource(row.file,read(row.file)))))).toBe(row.before_sha256); }
    expect(proof.previous_report.sha256).toBe('920ed25edd6321c32da0a5599fa370cbfda6a0204167e58977e3b1032f023f23');
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
  });
  it('reconstructs every current route/call/source using only ten exact GET registrations and five executable consumer paths', () => {
    expect(applyNavigationAuthorReport(previous)).toEqual(current); expect(reverseCommerceAuthorReport(reverseCommunityAuthorReport(buildAdminFrontendApiAuditReport()))).toEqual(applyEditorialAuthorReport(applyStateAuthorReport(applyListAuthorReport(applyCarouselAuthorReport(current)))));
    expect(sha(read(carouselProof.previous_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual({...previous.counts,callSites:previous.counts.callSites+3,pathVariants:previous.counts.pathVariants+5,registered:previous.counts.registered+5,executable:previous.counts.executable+5});
    const arrays=proof.report_reconstruction.arrays, routes=arrays.registered_routes!.additions.map(row=>row.value), calls=arrays.calls!.additions.map(row=>row.value);
    const resources=['hot-words','link-categories','link-targets','tab-categories','tab-targets'];
    expect(routes.map(row=>String(row.path)).sort()).toEqual(['/dise/author-options/','/api/admin/dise/author-options/'].flatMap(prefix=>resources.map(name=>prefix+name)).sort());
    expect(routes.every(row=>row.method==='GET'&&String(row.handler).startsWith('AdminDiyAuthorOptions.'))).toBe(true);
    expect(calls.map(row=>row.path).sort()).toEqual(resources.map(name=>'/dise/author-options/'+name).sort());
    expect(calls.every(row=>row.source==='view/admin-ts/src/api/diyAuthorOptions.ts'&&row.registered===true&&row.availability==='executable')).toBe(true);
    expect(arrays.frontend_sources!.additions.map(row=>row.value.file)).toEqual(['view/admin-ts/src/api/diyAuthorOptions.ts']);
  });
  for (const row of proof.sources) it.each(['extra-line','duplicate-increment','before-hash','after-hash','location'] as const)('rejects %s mutation at '+row.file, kind => {
    const changed=structuredClone(proof), entry=changed.sources.find(item=>item.file===row.file)!; let source=reverseCarouselAuthorSource(row.file,reverseListAuthorSource(row.file,read(row.file)));
    if(kind==='extra-line')source+='\n// unreviewed source\n';
    if(kind==='duplicate-increment')source+=entry.edits[0]!.after_source;
    if(kind==='before-hash')entry.before_sha256='0'.repeat(64);
    if(kind==='after-hash')entry.after_sha256='0'.repeat(64);
    if(kind==='location')entry.edits[0]!.after_line++;
    expect(()=>reverseNavigationAuthorSource(row.file,source,changed)).toThrow();
  });
  it.each(['counts','backend-source','reviewed-line'] as const)('rejects changed report predecessor %s rather than filtering old inventory', kind => {
    const changed=structuredClone(previous);
    if(kind==='counts')changed.counts.registered++;
    if(kind==='backend-source')changed.backend.sha256='0'.repeat(64);
    if(kind==='reviewed-line'){const delta=proof.report_reconstruction.arrays.registered_routes!.changes.find(row=>row.before.line!==undefined)!;changed.backend.registeredRoutes[delta.index].line++;}
    expect(()=>applyNavigationAuthorReport(changed)).toThrow();
  });
});
