import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport } from './helpers/diyPresaleAuthorSourceBinding';
import { reversePointsAuthorSource, applyPointsAuthorReport } from './helpers/diyPointsAuthorSourceBinding';
import { reverseCouponAuthorSource, applyCouponAuthorReport } from './helpers/diyCouponAuthorSourceBinding';
import { reversePromotionAuthorSource, applyPromotionAuthorReport, promotionAuthorSourceBinding } from './helpers/diyPromotionAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyCommunityAuthorReport, reverseCommunityAuthorSource, communityAuthorSourceBinding as proof } from './helpers/diyCommunityAuthorSourceBinding';
import { editorialAuthorSourceBinding, reverseEditorialAuthorSource } from './helpers/diyEditorialAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reversePromotionAuthorSource(file, reverseCouponAuthorSource(file, reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? promotionAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n'))))))))));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const sourceFiles = [
  'view/admin-ts/src/pages/content/DiseList.vue', 'view/admin-ts/src/api/community.ts',
  'view/uniapp-ts/src/utils/diyCommunity.ts', 'view/uniapp-ts/src/composables/useDiyCommunity.ts',
  'view/uniapp-ts/src/components/diy/DiyCommunityWidget.vue', 'workers-ts/src/services/content/DiyEditorialMediaPolicy.ts',
  'view/uniapp-ts/src/utils/diyEditorialMediaLease.ts', 'view/admin-ts/scripts/helpers/diy-navigation-runtime.cjs',
  'view/uniapp-ts/scripts/diy-community-runtime.test.cjs',
  'workers-ts/test/admin-frontend-api-audit.test.ts', 'workers-ts/test/diy-carousel-author-source-binding.test.ts',
  'workers-ts/test/diy-list-author-source-binding.test.ts', 'workers-ts/test/diy-navigation-author-source-binding.test.ts',
  'workers-ts/test/diy-follow-author-source-binding.test.ts', 'workers-ts/test/diy-editorial-author-source-binding.test.ts',
  'workers-ts/test/diy-community-frontend.test.ts',
  'view/admin-ts/package.json', 'view/uniapp-ts/package.json', 'workers-ts/package.json', '.github/workflows/workers-runtime-linux.yml',
];

describe('exact community author increment preserves all dated source and API inventories', () => {
  it('pins unchanged editorial/follow/state proofs, the complete prior report and every reviewed source path', () => {
    expect(sha(read('workers-ts/audit/diy-editorial-author-source-binding-20261024.json'))).toBe('8b43939285cfee0f58a464e2757ea335f116c53cfa42210c02e08681d6ad8579');
    expect(sha(read('workers-ts/audit/diy-editorial-author-php-parity-20261024.json'))).toBe('d9f450b1c3ca0f108fda2d059fa414f66f308e290d2e4afb84ab9028fd0ad950');
    expect(sha(read('workers-ts/audit/diy-follow-author-source-binding-20261024.json'))).toBe('7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8');
    expect(sha(read('workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json'))).toBe('8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9');
    expect(proof.previous_report.sha256).toBe(editorialAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(proof.sources.map(row => row.file)).toEqual(sourceFiles);
    expect(proof.sources[0]!.before_sha256).toBe(editorialAuthorSourceBinding.source.after_sha256);
    const dice = reverseCommunityAuthorSource(sourceFiles[0]!, read(sourceFiles[0]!));
    expect(sha(reverseEditorialAuthorSource(sourceFiles[0]!, dice))).toBe(editorialAuthorSourceBinding.source.before_sha256);
    expect(reverseCommunityAuthorSource('unrelated/file.ts', 'unchanged exact bytes')).toBe('unchanged exact bytes');
  });

  it.each(sourceFiles)('reconstructs the complete captured predecessor at %s', file => {
    const row = proof.sources.find(row => row.file === file)!;
    expect(sha(read(file))).toBe(row.after_sha256);
    expect(sha(reverseCommunityAuthorSource(file, read(file)))).toBe(row.before_sha256);
  });

  it.each(sourceFiles)('rejects extra source or changed exact inverse location at %s', file => {
    expect(() => reverseCommunityAuthorSource(file, read(file) + '\n// unreviewed drift\n')).toThrow();
    const binding = structuredClone(proof), row = binding.sources.find(row => row.file === file)!;
    row.edits[0]!.after_line++;
    expect(() => reverseCommunityAuthorSource(file, read(file), binding)).toThrow();
  });

  it('reconstructs only two source hashes and three line shifts with every endpoint and count retained', () => {
    expect(applyCommunityAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(applyCouponAuthorReport(applyPromotionAuthorReport(current)))))))));
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual(before.counts);
    expect(current.backend).toEqual(before.backend);
    expect(current.counts).toEqual({ callSites: 703, pathVariants: 741, registered: 741, executable: 741, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(proof.report_changes.map(row => [row.array, row.index])).toEqual([['frontendSources', 15], ['frontendSources', 104], ['calls', 732], ['calls', 733], ['calls', 734]]);
    for (const row of proof.report_changes) {
      const a = { ...row.before }, b = { ...row.after };
      if (row.array === 'calls') { expect(Number(b.line) - Number(a.line)).toBe(3); delete a.line; delete b.line; }
      else { delete a.sha256; delete b.sha256; }
      expect(a).toEqual(b);
    }
  });

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects complete predecessor %s drift without hiding any historical rows', kind => {
    const changed = structuredClone(before);
    if (kind === 'counts') changed.counts.registered++;
    if (kind === 'route') changed.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') changed.calls[0].line++;
    if (kind === 'source') changed.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') changed.methodology.scope = 'unreviewed';
    expect(() => applyCommunityAuthorReport(changed)).toThrow();
  });

  it.each(['counts', 'backend', 'before-row', 'after-row', 'before-hash', 'after-hash'] as const)('rejects report proof %s drift instead of accepting a broader increment', kind => {
    const changed = structuredClone(proof);
    if (kind === 'counts') (changed.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') changed.backend_unchanged = false;
    if (kind === 'before-row') changed.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'after-row') changed.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') changed.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'after-hash') changed.current_report.sha256 = '0'.repeat(64);
    expect(() => applyCommunityAuthorReport(before, changed)).toThrow();
  });

  it.each(['duplicate-edit', 'before-hash', 'after-hash', 'edit-body', 'canonical-bypass'] as const)('rejects source proof %s drift', kind => {
    const binding = structuredClone(proof), row = binding.sources[0]!;
    let source = read(row.file);
    if (kind === 'duplicate-edit') source += row.edits[0]!.after_source;
    if (kind === 'before-hash') row.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') row.after_sha256 = '0'.repeat(64);
    if (kind === 'edit-body') row.edits[0]!.after_source += '// unreviewed';
    if (kind === 'canonical-bypass') source = source.replace('canonicalCommunityValue(canonicalEditorialValue', 'canonicalEditorialValue');
    expect(() => reverseCommunityAuthorSource(row.file, source, binding)).toThrow();
  });
});

const parityRaw = read('workers-ts/audit/diy-community-author-php-parity-20261024.json');
const parity = JSON.parse(parityRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string }>;
  PHP_flow_evidence: Array<{ file: string; start_line: number; end_line: number; source: string }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  assets: Array<{ file: string; before_exists: boolean; after_sha256: string; bytes: number; width: number; height: number }>;
  default_binding: { top_level_keys: number; compact_json_sha256: string };
};

describe('independent community complete additions and exact fixed-PHP authority', () => {
  it('pins the separate manifest, three original sources, 36 default keys and both original PNG copies', () => {
    expect(sha(parityRaw)).toBe('96b35eaa70e0ff46260b5677f5e0078d277d310af978a940a879384f05f2bb67');
    expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parity.PHP_sources.map(row => [row.file, row.raw_sha256])).toEqual([
      ['view/admin/src/components/mobilePage/home_community.vue', '748f9410bee33dc16f2e59e5a7a7bd4cc67e6f9434d9af789dfcb03d44f97bcc'],
      ['view/admin/src/components/mobileConfig/c_community.vue', '6e4250dc590e71a4d0d4137a7924406fca8b3af5791bcfe560cffeef8b5174b6'],
      ['view/uniapp/pages/index/components/community.vue', 'b23c714d7e72d377d23ada3c26d2c49b73fe6a2741de3280ca74ae6ff7605671'],
    ]);
    expect(parity.PHP_flow_evidence.map(row => row.start_line)).toEqual([278, 337, 354]);
    expect(parity.PHP_flow_evidence[0]!.source).toContain('this.boxHeight = []');
    expect(parity.PHP_flow_evidence[0]!.source).toContain('this.waterFall()');
    expect(parity.PHP_flow_evidence[1]!.source).toContain('this.rightList.length < this.leftList.length');
    expect(parity.PHP_flow_evidence[1]!.source).toContain('this.boxHeight[0] > this.boxHeight[1]');
    expect(parity.PHP_flow_evidence[2]!.source).toContain('this.$nextTick');
    expect(parity.default_binding).toMatchObject({ top_level_keys: 36, compact_json_sha256: '02be08a3bd63da9147cf65db1a1c56ae474be297b7b1971ea46b28efc8e32b6d' });
    expect(parity.assets.map(row => row.file)).toEqual(['view/admin-ts/public/static/images/diy/community.png', 'view/uniapp-ts/src/static/images/diy/community.png']);
    for (const asset of parity.assets) {
      expect(asset.before_exists).toBe(false);
      expect(asset).toMatchObject({ after_sha256: '48785691c5387e98d65dc662913a3fdd3d146db9152b042d51f1f2647c8d8b4c', bytes: 1886, width: 128, height: 32 });
      expect(sha(readFileSync(resolve(root, asset.file)))).toBe(asset.after_sha256);
    }
    expect(parity.sources).toHaveLength(13);
  });

  it.each(Array.from({ length: 13 }, (_, index) => index))('pins and exactly reverses only complete new source %s', index => {
    const binding = parity.sources[index]!, source = read(binding.file);
    expect(sha(source)).toBe(binding.after_sha256);
    expect(binding.before_sha256).toBe(sha(''));
    expect(binding.edits).toEqual([{ before_source: '', after_source: source, before_line: 1, after_line: 1 }]);
    expect(reverseRouteSourceFollowup(source, binding)).toBe('');
  });

  it.each(Array.from({ length: 13 }, (_, index) => index))('rejects unrelated addition or misplaced inverse in complete new source %s', index => {
    const binding = parity.sources[index]!;
    expect(() => reverseRouteSourceFollowup(read(binding.file) + '\n// unreviewed\n', binding)).toThrow();
    const changed = structuredClone(binding); changed.edits[0]!.after_line++;
    expect(() => reverseRouteSourceFollowup(read(binding.file), changed)).toThrow();
  });
});
