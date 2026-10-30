import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport } from './helpers/diyPresaleAuthorSourceBinding';
import { reversePointsAuthorSource, applyPointsAuthorReport } from './helpers/diyPointsAuthorSourceBinding';
import { reverseCouponAuthorSource, applyCouponAuthorReport, couponAuthorSourceBinding } from './helpers/diyCouponAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyPromotionAuthorReport, reversePromotionAuthorSource, promotionAuthorSourceBinding as proof } from './helpers/diyPromotionAuthorSourceBinding';
import { communityAuthorSourceBinding, reverseCommunityAuthorSource } from './helpers/diyCommunityAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reverseCouponAuthorSource(file, reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? couponAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n')))))))));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const sourceFiles = proof.sources.map(row => row.file);

describe('exact promotion author increment preserves community and every earlier dated proof', () => {
  it('pins unchanged community editorial follow state bytes and the complete community predecessor', () => {
    for (const [file, expected] of [
      ['workers-ts/audit/diy-community-author-source-binding-20261024.json', 'dc461dd1511ddad0148e9831d84bbff99f323426fe0ba1045381a7456ddc1633'],
      ['workers-ts/audit/diy-community-author-php-parity-20261024.json', '96b35eaa70e0ff46260b5677f5e0078d277d310af978a940a879384f05f2bb67'],
      ['workers-ts/audit/diy-editorial-author-source-binding-20261024.json', '8b43939285cfee0f58a464e2757ea335f116c53cfa42210c02e08681d6ad8579'],
      ['workers-ts/audit/diy-editorial-author-php-parity-20261024.json', 'd9f450b1c3ca0f108fda2d059fa414f66f308e290d2e4afb84ab9028fd0ad950'],
      ['workers-ts/audit/diy-follow-author-source-binding-20261024.json', '7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8'],
      ['workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json', '8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9'],
    ]) expect(sha(read(file!))).toBe(expected);
    expect(proof.previous_report.sha256).toBe('4f44be0f8b0a4e7bfc45f2989cf1837d9bff29b7ecc25b52782fbaef42f29bab');
    expect(proof.previous_report.sha256).toBe(communityAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sourceFiles).toHaveLength(16);
    expect(new Set(sourceFiles).size).toBe(sourceFiles.length);
    expect(sourceFiles).toContain('view/admin-ts/src/pages/content/DiseList.vue');
    expect(sourceFiles).toContain('view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue');
    expect(sourceFiles).not.toContain('view/uniapp-ts/src/utils/diyCommerceConfig.ts');
    expect(sourceFiles).not.toContain('view/uniapp-ts/src/composables/useDiyCommerceWidget.ts');
    expect(sourceFiles).not.toContain('view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue');
    expect(sourceFiles).not.toContain('view/uniapp-ts/src/api/diyCommerce.ts');
    expect(reversePromotionAuthorSource('unrelated/file.ts', 'unchanged exact bytes')).toBe('unchanged exact bytes');
  });

  it.each(sourceFiles)('reconstructs only the complete captured predecessor at %s', file => {
    const row = proof.sources.find(item => item.file === file)!;
    expect(sha(read(file))).toBe(row.after_sha256);
    const prior = reversePromotionAuthorSource(file, read(file));
    expect(sha(prior)).toBe(row.before_sha256);
    const community = communityAuthorSourceBinding.sources.find(item => item.file === file);
    if (community) {
      expect(row.before_sha256).toBe(community.after_sha256);
      expect(sha(reverseCommunityAuthorSource(file, prior))).toBe(community.before_sha256);
    }
  });

  it.each(sourceFiles)('rejects extra source and changed inverse location at %s', file => {
    expect(() => reversePromotionAuthorSource(file, read(file) + '\n// unreviewed drift\n')).toThrow();
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === file)!;
    row.edits[0]!.after_line++;
    expect(() => reversePromotionAuthorSource(file, read(file), binding)).toThrow();
  });

  it('reconstructs only the Dice source hash and three existing call lines with all703/741 retained', () => {
    expect(applyPromotionAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(applyCouponAuthorReport(current))))))));
    expect(sha(read(proof.current_report.file))).toBe(proof.current_report.sha256);
    expect(current.counts).toEqual(before.counts);
    expect(current.backend).toEqual(before.backend);
    expect(current.counts).toEqual({ callSites: 703, pathVariants: 741, registered: 741, executable: 741, controlledUnavailable: 0, unregistered: 0, unresolved: 0 });
    expect(proof.report_changes.map(row => [row.array, row.index])).toEqual([['frontendSources', 104], ['calls', 732], ['calls', 733], ['calls', 734]]);
    const shifts: number[] = [];
    for (const row of proof.report_changes) {
      const a = { ...row.before }, b = { ...row.after };
      if (row.array === 'calls') { const shift = Number(b.line) - Number(a.line); expect(Number.isInteger(shift) && shift > 0).toBe(true); shifts.push(shift); delete a.line; delete b.line; }
      else { expect(a.file).toBe('view/admin-ts/src/pages/content/DiseList.vue'); delete a.sha256; delete b.sha256; }
      expect(a).toEqual(b);
    }
    expect(new Set(shifts).size).toBe(1);
  });

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects complete predecessor %s drift', kind => {
    const changed = structuredClone(before);
    if (kind === 'counts') changed.counts.registered++;
    if (kind === 'route') changed.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') changed.calls[0].line++;
    if (kind === 'source') changed.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') changed.methodology.scope = 'unreviewed';
    expect(() => applyPromotionAuthorReport(changed)).toThrow();
  });

  it.each(['counts', 'backend', 'before-row', 'after-row', 'before-hash', 'after-hash'] as const)('rejects report proof %s drift', kind => {
    const changed = structuredClone(proof);
    if (kind === 'counts') (changed.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') changed.backend_unchanged = false;
    if (kind === 'before-row') changed.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'after-row') changed.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') changed.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'after-hash') changed.current_report.sha256 = '0'.repeat(64);
    expect(() => applyPromotionAuthorReport(before, changed)).toThrow();
  });

  it.each(['duplicate-edit', 'before-hash', 'after-hash', 'edit-body', 'slot-bypass'] as const)('rejects exact source proof %s drift', kind => {
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === 'view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue')!;
    let source = read(row.file);
    if (kind === 'duplicate-edit') source += row.edits[0]!.after_source;
    if (kind === 'before-hash') row.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') row.after_sha256 = '0'.repeat(64);
    if (kind === 'edit-body') row.edits[0]!.after_source += '// unreviewed';
    if (kind === 'slot-bypass') source = source.replace('DiyPromotionWidget', 'UnreviewedPromotionWidget');
    expect(() => reversePromotionAuthorSource(row.file, source, binding)).toThrow();
  });
});

const parityRaw = read('workers-ts/audit/diy-promotion-author-php-parity-20261025.json');
const parity = JSON.parse(parityRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string }>;
  PHP_behavior_evidence: Array<{ file: string; start_line: number; end_line: number; source: string }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  assets: unknown[];
  default_binding: { top_level_keys: number; compact_json_sha256: string; complete_literal: Record<string, unknown> };
};

describe('independent full additions and immutable promotion PHP authority', () => {
  it('pins five real source files, all30default keys, delegated goodList and five actual nav styles', () => {
    expect(sha(parityRaw)).toBe('2aa9f63d0e2b2ea4e9f28586f751191488081d302ee609eb9bab17c66815104a');
    expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parity.PHP_sources.map(row => [row.file, row.raw_sha256])).toEqual([
      ['view/admin/src/components/mobilePage/home_product.vue', 'c6e6a1525a6e8a6640ba5458ff1bc2a8eb6c2bb9f09d392b77de3735c58debf3'],
      ['view/admin/src/components/mobileConfig/c_home_product.vue', 'e7ae8e2325220cafdf07143d948dcc0e1813563960608e3836decd4b41f93c09'],
      ['view/uniapp/pages/index/components/promotionList.vue', 'fcbdb487dcb34cc5650101daca593165c748332e1c91a5536a3d3d530f39ee71'],
      ['view/admin/src/components/mobileConfigRight/c_promotion.vue', '96a9ee32103ce253cd9dc7f18d4ffdde9bc8193b32dc53ab6fb19904bad65dec'],
      ['view/uniapp/pages/index/components/goodList.vue', '8d321aefec7d26ee00f0e8e6f1b3ed58f77b4e8f6552095cefdae8bdaa4b69bf'],
    ]);
    expect(parity.default_binding.top_level_keys).toBe(30);
    expect(Object.keys(parity.default_binding.complete_literal)).toHaveLength(30);
    expect(parity.default_binding.compact_json_sha256).toBe('56836da289757873d8b7d95ebf3ff65df4c445980d0646434a2804178352be90');
    expect(sha(JSON.stringify(parity.default_binding.complete_literal))).toBe(parity.default_binding.compact_json_sha256);
    const styles = parity.PHP_behavior_evidence[0]!.source;
    for (const marker of ['styleConfig.tabVal == 1', 'styleConfig.tabVal == 2', 'styleConfig.tabVal == 3', 'styleConfig.tabVal == 4', 'styleConfig.tabVal == 0', '<goodList']) expect(styles).toContain(marker);
    expect(parity.PHP_behavior_evidence[1]!.source).toContain("color = '#ffffff'");
    const delegation = parity.PHP_behavior_evidence.find(row => row.file.endsWith('/promotionList.vue') && row.start_line === 196)!.source;
    for (const marker of ['goodsList: this.activeValue.goodsList', 'brandList: this.activeValue.brandConfig', 'classVal: this.activeValue.selectConfig.activeValue', 'goodsLabel: this.activeValue.goodsLabel', 'goodsSort:']) expect(delegation).toContain(marker);
    const request = parity.PHP_behavior_evidence.find(row => row.file.endsWith('/goodList.vue'))!.source;
    expect(request).toContain('if (this.typeConfig == 1)');
    expect(request).toContain("ids: this.dataConfig.goodsList.ids.join(',')");
    expect(request.indexOf('} else {')).toBeLessThan(request.indexOf('priceOrder:'));
    expect(parity.sources.map(row => row.file)).toEqual([
      'view/admin-ts/src/utils/diyPromotionDefaults.ts',
      'view/admin-ts/src/utils/diyPromotionEditor.ts',
      'view/admin-ts/src/utils/diyPromotionProjection.ts',
      'view/admin-ts/src/components/content/DiyPromotionEditor.vue',
      'view/admin-ts/src/components/content/DiyPromotionPreview.vue',
      'view/common/diyPromotion.ts',
      'view/uniapp-ts/src/components/diy/DiyPromotionWidget.vue',
      'view/admin-ts/scripts/diy-promotion-editor-model-runtime.test.cjs',
      'view/uniapp-ts/src/composables/useDiyPromotion.ts',
      'view/uniapp-ts/src/utils/diyPromotion.ts',
      'view/admin-ts/scripts/diy-promotion-editor-runtime.test.cjs',
      'view/uniapp-ts/scripts/diy-promotion-author-runtime.test.cjs',
      'workers-ts/test/diy-promotion-author-media.test.ts',
    ]);
    expect(parity.sources).toHaveLength(13);
    expect(parity.assets).toEqual([]);
  });

  it.each(parity.sources.map(row => row.file))('pins and exactly reverses only complete new source %s', file => {
    const row = parity.sources.find(item => item.file === file)!;
    expect(row.before_sha256).toBe(sha(''));
    expect(row.edits).toHaveLength(1);
    expect(row.edits[0]!.before_source).toBe('');
    expect(sha(read(file))).toBe(row.after_sha256);
    expect(reverseRouteSourceFollowup(read(file), row)).toBe('');
  });

  it.each(parity.sources.map(row => row.file))('rejects current or recorded full-add drift at %s', file => {
    const row = parity.sources.find(item => item.file === file)!;
    expect(() => reverseRouteSourceFollowup(read(file) + '\n// unreviewed\n', row)).toThrow();
    const changed = structuredClone(row); changed.edits[0]!.after_line = 2;
    expect(() => reverseRouteSourceFollowup(read(file), changed)).toThrow();
  });
});
