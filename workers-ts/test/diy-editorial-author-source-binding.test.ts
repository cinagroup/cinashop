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
import { reverseCommunityAuthorSource, applyCommunityAuthorReport, communityAuthorSourceBinding } from './helpers/diyCommunityAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyEditorialAuthorReport, reverseEditorialAuthorSource, editorialAuthorSourceBinding as proof } from './helpers/diyEditorialAuthorSourceBinding';
import { followAuthorSourceBinding, reverseFollowAuthorSource } from './helpers/diyFollowAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reverseCommunityAuthorSource(file, reversePromotionAuthorSource(file, reverseCouponAuthorSource(file, reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === 'workers-ts/audit/admin-frontend-api-contracts.json' ? communityAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n')))))))))));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const source = read(proof.source.file);

describe('exact editorial author layer preserves all follow, state and earlier complete API inventories', () => {
  it('pins the unchanged follow proof, complete predecessor report and three exact source edits', () => {
    expect(sha(read('workers-ts/audit/diy-follow-author-source-binding-20261024.json'))).toBe('7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8');
    expect(sha(read('workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json'))).toBe('8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9');
    expect(proof.source.before_sha256).toBe(followAuthorSourceBinding.source.after_sha256);
    expect(proof.previous_report.sha256).toBe(followAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sha(source)).toBe(proof.source.after_sha256);
    const previousSource = reverseEditorialAuthorSource(proof.source.file, source);
    expect(sha(previousSource)).toBe(followAuthorSourceBinding.source.after_sha256);
    expect(sha(reverseFollowAuthorSource(proof.source.file, previousSource))).toBe(followAuthorSourceBinding.source.before_sha256);
    expect(proof.source.edits).toHaveLength(3);
    expect(reverseEditorialAuthorSource('unrelated/source.ts', 'exact unrelated bytes')).toBe('exact unrelated bytes');
  });

  it('reconstructs every old row with one source hash and three line shifts, matching the current source-derived report', () => {
    expect(applyEditorialAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(applyCouponAuthorReport(applyPromotionAuthorReport(applyCommunityAuthorReport(current))))))))));
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual(before.counts);
    expect(current.backend).toEqual(before.backend);
    expect(current.counts).toEqual({ callSites: 703, pathVariants: 741, registered: 741, executable: 741, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(proof.report_changes.filter(change => change.array === 'frontendSources')).toHaveLength(1);
    expect(proof.report_changes.filter(change => change.array === 'calls')).toHaveLength(3);
    for (const change of proof.report_changes) {
      expect(change.after.file ?? change.after.source).toBe('view/admin-ts/src/pages/content/DiseList.vue');
      const a = { ...change.before }, b = { ...change.after };
      if (change.array === 'calls') { expect(Number(b.line) - Number(a.line)).toBe(3); delete a.line; delete b.line; }
      else { delete a.sha256; delete b.sha256; }
      expect(a).toEqual(b);
    }
  });

  it.each(['extra-source', 'duplicate-edit', 'canonical-bypass', 'before-hash', 'after-hash', 'location', 'edit-body'] as const)('rejects unreviewed %s before entering any historical inverse', kind => {
    const binding = structuredClone(proof);
    let supplied = source;
    if (kind === 'extra-source') supplied += '\n// unreviewed\n';
    if (kind === 'duplicate-edit') supplied += binding.source.edits[0]!.after_source;
    if (kind === 'canonical-bypass') supplied = supplied.replace('canonicalEditorialValue(canonicalFollowValue', 'canonicalFollowValue');
    if (kind === 'before-hash') binding.source.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') binding.source.after_sha256 = '0'.repeat(64);
    if (kind === 'location') binding.source.edits[0]!.after_line++;
    if (kind === 'edit-body') binding.source.edits[0]!.after_source += '// unreviewed';
    expect(() => reverseEditorialAuthorSource(binding.source.file, supplied, binding)).toThrow();
  });

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects predecessor %s mutation without filtering historical inventory', kind => {
    const supplied = structuredClone(before);
    if (kind === 'counts') supplied.counts.registered++;
    if (kind === 'route') supplied.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') supplied.calls[0].line++;
    if (kind === 'source') supplied.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') supplied.methodology.scope = 'unreviewed';
    expect(() => applyEditorialAuthorReport(supplied)).toThrow();
  });

  it.each(['counts', 'backend', 'row', 'result-row', 'before-hash', 'result-hash'] as const)('rejects binding %s mutation instead of broadening accepted source or report', kind => {
    const binding = structuredClone(proof);
    if (kind === 'counts') (binding.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') binding.backend_unchanged = false;
    if (kind === 'row') binding.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'result-row') binding.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') binding.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'result-hash') binding.current_report.sha256 = '0'.repeat(64);
    expect(() => applyEditorialAuthorReport(before, binding)).toThrow();
  });
});

const parityManifestRaw = read('workers-ts/audit/diy-editorial-author-php-parity-20261024.json');
const parityManifest = JSON.parse(parityManifestRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string; lines: number[] }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  unchanged_dispatcher_dependencies: Array<{ file: string; sha256: string }>;
  readonly_preview_source: { file: string; sha256: string };
};

describe('independent exact PHP parity source manifest', () => {
  it('pins the separate manifest and immutable PHP consumer evidence', () => {
    expect(sha(parityManifestRaw)).toBe('d9f450b1c3ca0f108fda2d059fa414f66f308e290d2e4afb84ab9028fd0ad950');
    expect(parityManifest.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parityManifest.PHP_sources.map(row => [row.file, row.raw_sha256])).toEqual([
      ['view/uniapp/pages/index/components/news.vue', '627d9dfb1e9255b38b9b5a7a805dbb32e288f9129e361cd2d8f4f840403c29f3'],
      ['view/uniapp/pages/index/components/follow.vue', 'f325205d078d466dbabd72fe08c2fca5d3fd46811ae83e9dae568562fe97cd80'],
    ]);
    expect(parityManifest.sources.map(row => row.file)).toEqual([
      'view/uniapp-ts/src/utils/diyEditorialConfig.ts',
      'view/admin-ts/src/utils/diyFollowProjection.ts',
      'view/admin-ts/src/components/content/DiyFollowEditor.vue',
      'view/admin-ts/scripts/diy-follow-editor-runtime.test.cjs',
      'view/uniapp-ts/src/composables/useDiyEditorialWidget.ts',
      'view/uniapp-ts/src/utils/diyEditorialLink.ts',
      'view/admin-ts/src/components/content/DiyEditorialEditor.vue',
      'view/admin-ts/src/utils/diyEditorialProjection.ts',
    ]);
    for (const dependency of parityManifest.unchanged_dispatcher_dependencies) expect(sha(read(dependency.file))).toBe(dependency.sha256);
    expect(sha(read(parityManifest.readonly_preview_source.file))).toBe(parityManifest.readonly_preview_source.sha256);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('reverses only the complete pinned PHP parity source %s', index => {
    const binding = parityManifest.sources[index]!, actual = read(binding.file);
    expect(sha(actual)).toBe(binding.after_sha256);
    expect(sha(reverseRouteSourceFollowup(actual, binding))).toBe(binding.before_sha256);
    expect(binding.edits).toHaveLength([3, 1, 1, 1, 2, 1, 1, 1][index]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('rejects extra source changes outside exact PHP parity source %s', index => {
    const binding = parityManifest.sources[index]!;
    expect(() => reverseRouteSourceFollowup(read(binding.file) + '\n// unrelated drift\n', binding)).toThrow();
    const changed = structuredClone(binding);
    changed.edits[0]!.after_line++;
    expect(() => reverseRouteSourceFollowup(read(binding.file), changed)).toThrow();
  });
});
