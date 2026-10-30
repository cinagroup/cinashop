import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport } from './helpers/diyPresaleAuthorSourceBinding';
import { reversePointsAuthorSource, applyPointsAuthorReport } from './helpers/diyPointsAuthorSourceBinding';
import { reverseCouponAuthorSource, applyCouponAuthorReport } from './helpers/diyCouponAuthorSourceBinding';
import { reversePromotionAuthorSource, applyPromotionAuthorReport } from './helpers/diyPromotionAuthorSourceBinding';
import { reverseCommunityAuthorSource, applyCommunityAuthorReport } from './helpers/diyCommunityAuthorSourceBinding';
import { reverseEditorialAuthorSource, applyEditorialAuthorReport, editorialAuthorSourceBinding } from './helpers/diyEditorialAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyFollowAuthorReport, reverseFollowAuthorSource, followAuthorSourceBinding as proof } from './helpers/diyFollowAuthorSourceBinding';

const root = resolve(import.meta.dirname, '../..');
// The follow proof keeps its dated report and source bytes; peel only the exact later editorial layer.
const read = (file: string) => reverseEditorialAuthorSource(file, reverseCommunityAuthorSource(file, reversePromotionAuthorSource(file, reverseCouponAuthorSource(file, reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? editorialAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n'))))))))))));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const source = read(proof.source.file);

describe('exact follow author layer preserves the existing state author and complete historical inventories', () => {
  it('pins the unchanged state fixture and its complete report before the three exact follow source edits', () => {
    const stateRaw = read('workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json');
    expect(sha(stateRaw)).toBe('8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9');
    const state = JSON.parse(stateRaw);
    expect(proof.source.before_sha256).toBe(state.source.after_sha256);
    expect(proof.previous_report.sha256).toBe(state.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sha(source)).toBe(proof.source.after_sha256);
    expect(sha(reverseFollowAuthorSource(proof.source.file, source))).toBe(state.source.after_sha256);
    expect(proof.source.edits).toHaveLength(3);
    expect(reverseFollowAuthorSource('unrelated/source.ts', 'exact unrelated bytes')).toBe('exact unrelated bytes');
  });

  it('reconstructs the complete current report using one source hash and three existing call-line shifts', () => {
    expect(applyFollowAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(applyCouponAuthorReport(applyPromotionAuthorReport(applyCommunityAuthorReport(applyEditorialAuthorReport(current)))))))))));
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual(before.counts);
    expect(current.backend).toEqual(before.backend);
    expect(current.counts).toEqual({ callSites: 703, pathVariants: 741, registered: 741, executable: 741, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(proof.report_changes.filter(change => change.array === 'frontendSources')).toHaveLength(1);
    expect(proof.report_changes.filter(change => change.array === 'calls')).toHaveLength(3);
    for (const change of proof.report_changes) {
      expect(change.after.file ?? change.after.source).toBe('view/admin-ts/src/pages/content/DiseList.vue');
      const a = { ...change.before }, b = { ...change.after };
      if (change.array === 'calls') { delete a.line; delete b.line; }
      else { delete a.sha256; delete b.sha256; }
      expect(a).toEqual(b);
    }
  });

  it.each(['extra-source', 'duplicate-edit', 'canonical-bypass', 'before-hash', 'after-hash', 'location', 'edit-body'] as const)('rejects unreviewed %s before entering any historical source inverse', kind => {
    const binding = structuredClone(proof);
    let supplied = source;
    if (kind === 'extra-source') supplied += '\n// unreviewed\n';
    if (kind === 'duplicate-edit') supplied += binding.source.edits[0]!.after_source;
    if (kind === 'canonical-bypass') supplied = supplied.replace('canonicalFollowValue(canonicalStateValue', 'canonicalStateValue');
    if (kind === 'before-hash') binding.source.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') binding.source.after_sha256 = '0'.repeat(64);
    if (kind === 'location') binding.source.edits[0]!.after_line++;
    if (kind === 'edit-body') binding.source.edits[0]!.after_source += '// unreviewed';
    expect(() => reverseFollowAuthorSource(binding.source.file, supplied, binding)).toThrow();
  });

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects predecessor %s mutation without filtering old inventory', kind => {
    const supplied = structuredClone(before);
    if (kind === 'counts') supplied.counts.registered++;
    if (kind === 'route') supplied.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') supplied.calls[0].line++;
    if (kind === 'source') supplied.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') supplied.methodology.scope = 'unreviewed';
    expect(() => applyFollowAuthorReport(supplied)).toThrow();
  });

  it.each(['counts', 'backend', 'row', 'result-row', 'before-hash', 'result-hash'] as const)('rejects binding %s mutation instead of broadening the accepted report', kind => {
    const binding = structuredClone(proof);
    if (kind === 'counts') (binding.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') binding.backend_unchanged = false;
    if (kind === 'row') binding.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'result-row') binding.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') binding.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'result-hash') binding.current_report.sha256 = '0'.repeat(64);
    expect(() => applyFollowAuthorReport(before, binding)).toThrow();
  });
});
