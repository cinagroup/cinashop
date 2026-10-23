import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { reverseNavigationAuthorSource, applyNavigationAuthorReport, navigationAuthorSourceBinding as proof } from './helpers/diyNavigationAuthorSourceBinding';
const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n?/g, '\n');
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
const sourceFile = 'workers-ts/audit/diy-navigation-author-source-binding-20261023.json';
const previous = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
describe('exact additive navigation author source and API inventory increment', () => {
  it('pins the full new proof, three exact source inverses and the immutable preceding current report', () => {
    expect(sha(read(sourceFile))).toBe('91d6a8f07f1330ddabceff904a9ace6fe4c5641756b9faee838c4a117f3f99fd');
    expect(proof.sources.map(row => row.file)).toEqual(['workers-ts/src/routes/adminapi.ts','workers-ts/src/routes/v1/index.ts','view/admin-ts/src/pages/content/DiseList.vue']);
    expect(proof.sources.map(row => row.edits.length)).toEqual([2,2,3]);
    for (const row of proof.sources) { expect(sha(read(row.file))).toBe(row.after_sha256); expect(sha(reverseNavigationAuthorSource(row.file,read(row.file)))).toBe(row.before_sha256); }
    expect(proof.previous_report.sha256).toBe('920ed25edd6321c32da0a5599fa370cbfda6a0204167e58977e3b1032f023f23');
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
  });
  it('reconstructs every current route/call/source using only ten exact GET registrations and five executable consumer paths', () => {
    expect(applyNavigationAuthorReport(previous)).toEqual(current); expect(buildAdminFrontendApiAuditReport()).toEqual(current);
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
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
    const changed=structuredClone(proof), entry=changed.sources.find(item=>item.file===row.file)!; let source=read(row.file);
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
