import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport } from './helpers/diyPresaleAuthorSourceBinding';
import { reversePointsAuthorSource, applyPointsAuthorReport, pointsAuthorSourceBinding } from './helpers/diyPointsAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyCouponAuthorReport, reverseCouponAuthorSource, couponAuthorSourceBinding as proof } from './helpers/diyCouponAuthorSourceBinding';
import { promotionAuthorSourceBinding, reversePromotionAuthorSource } from './helpers/diyPromotionAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reversePointsAuthorSource(file, reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? pointsAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n'))))))));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const before = JSON.parse(read(proof.previous_report.file));
const current = JSON.parse(read(proof.current_report.file));
const sourceFiles = proof.sources.map(row => row.file);
const frozen = {
  "workers-ts/audit/diy-carousel-author-source-binding-20261023.json": "e09f9227d29faa4932810e66e12d4c1d57c5d4db6e233ce29284b3253b4dd0b6",
  "workers-ts/audit/diy-community-author-php-parity-20261024.json": "96b35eaa70e0ff46260b5677f5e0078d277d310af978a940a879384f05f2bb67",
  "workers-ts/audit/diy-community-author-source-binding-20261024.json": "dc461dd1511ddad0148e9831d84bbff99f323426fe0ba1045381a7456ddc1633",
  "workers-ts/audit/diy-editorial-author-php-parity-20261024.json": "d9f450b1c3ca0f108fda2d059fa414f66f308e290d2e4afb84ab9028fd0ad950",
  "workers-ts/audit/diy-editorial-author-source-binding-20261024.json": "8b43939285cfee0f58a464e2757ea335f116c53cfa42210c02e08681d6ad8579",
  "workers-ts/audit/diy-follow-author-source-binding-20261024.json": "7fac6edbe6b856c737f758c6d6952f449974e685098b065ac4c19dae0712a7d8",
  "workers-ts/audit/diy-list-author-source-binding-20261023.json": "4ddd06f3bef5ef330d46ec6289b76c81876e2d4da8d5bcd623dca73d540e3149",
  "workers-ts/audit/diy-navigation-author-source-binding-20261023.json": "91d6a8f07f1330ddabceff904a9ace6fe4c5641756b9faee838c4a117f3f99fd",
  "workers-ts/test/fixtures/diy-state-author-historical-bindings-20261024.json": "8ddc626ef49c2ada520940518c99a3b3bb803df5b1047308af9d4241ff96a7d9",
  "workers-ts/test/helpers/diyCarouselAuthorSourceBinding.ts": "68500365fa9f677dd7b937d571c734a9494d00c8ffcd9bb8cfd62292ce4afd18",
  "workers-ts/test/helpers/diyCommunityAuthorSourceBinding.ts": "14c6b27bed91b44892462e0600bde54bccd63f83db27019a26c67e23c7037c0e",
  "workers-ts/test/helpers/diyEditorialAuthorSourceBinding.ts": "051ce7caf8e73f56eee9e709d76ec7f1e1da90cbb4c27081de728d52333d68a8",
  "workers-ts/test/helpers/diyFollowAuthorSourceBinding.ts": "d95ceb5112631a497e210763962cc002dcb2c85467ae25f0c8a5038b5faab3b1",
  "workers-ts/test/helpers/diyListAuthorSourceBinding.ts": "fe89a23a69e3fc5c4491b740cce80118cf4577961b0cacdbc508b8e4b12a6e21",
  "workers-ts/test/helpers/diyNavigationAuthorSourceBinding.ts": "bcdc3fe7640973a35c50ac2804a845bf87a2abe5b5ed634a85e3f5e3466cf704",
  "workers-ts/audit/diy-promotion-author-source-binding-20261025.json": "fd3f186922cad714f642ec7b0dfc7a28ed96b5791f2cdab934d95ff697bd9b6b",
  "workers-ts/audit/diy-promotion-author-php-parity-20261025.json": "2aa9f63d0e2b2ea4e9f28586f751191488081d302ee609eb9bab17c66815104a",
  "workers-ts/test/helpers/diyPromotionAuthorSourceBinding.ts": "26a46bc8609cbafbbb2907535cdb8efcac9f22a03efda210294b785f28f6bda0"
} as const;
const fullAddFiles = [
  "view/admin-ts/src/utils/diyCouponDefaults.ts",
  "view/admin-ts/src/utils/diyCouponEditor.ts",
  "view/admin-ts/src/api/diyCouponAuthor.ts",
  "view/admin-ts/scripts/diy-coupon-editor-model-runtime.test.cjs",
  "view/admin-ts/scripts/diy-coupon-author-data-runtime.test.cjs",
  "view/admin-ts/src/components/content/DiyCouponEditor.vue",
  "view/admin-ts/src/components/content/DiyCouponPreview.vue",
  "view/admin-ts/src/components/content/DiyCouponPreviewCard.vue",
  "view/admin-ts/scripts/diy-coupon-editor-runtime.test.cjs",
  "view/common/diyCoupon.ts",
  "view/uniapp-ts/src/components/diy/DiyCouponWidget.vue",
  "view/uniapp-ts/src/components/diy/DiyCouponCard.vue",
  "view/uniapp-ts/src/composables/useDiyCoupon.ts",
  "view/uniapp-ts/scripts/diy-coupon-author-runtime.test.cjs"
] as const;

describe('exact coupon author increment preserves all promotion and earlier evidence', () => {
  it('pins every old dated proof/helper, the complete promotion predecessor and exact reviewed scope', () => {
    for (const [file, expected] of Object.entries(frozen)) expect(sha(read(file))).toBe(expected);
    expect(proof.previous_report.sha256).toBe('f526b393bdbdc2fb80304a49cfe5d45bec11a79eeaef80a71e01cb8100235162');
    expect(proof.previous_report.sha256).toBe(promotionAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sourceFiles).toHaveLength(15);
    expect(new Set(sourceFiles).size).toBe(15);
    expect(sourceFiles).toContain('view/admin-ts/src/pages/content/DiseList.vue');
    expect(sourceFiles).toContain('view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue');
    for (const file of [
      'view/uniapp-ts/src/utils/diyCommerceConfig.ts',
      'view/uniapp-ts/src/composables/useDiyCommerceWidget.ts',
      'view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue',
      'view/uniapp-ts/src/api/diyCommerce.ts',
      'view/uniapp-ts/src/utils/diyCouponClaim.ts',
      'workers-ts/src/services/content/DiyEditorialMediaPolicy.ts',
      'view/uniapp-ts/src/utils/diyEditorialMediaLease.ts',
    ]) expect(sourceFiles).not.toContain(file);
    expect(reverseCouponAuthorSource('unrelated/file.ts', 'unchanged exact bytes')).toBe('unchanged exact bytes');
  });

  it.each(sourceFiles)('reconstructs the captured complete predecessor at %s', file => {
    const row = proof.sources.find(item => item.file === file)!;
    expect(sha(read(file))).toBe(row.after_sha256);
    const previous = reverseCouponAuthorSource(file, read(file));
    expect(sha(previous)).toBe(row.before_sha256);
    const promotion = promotionAuthorSourceBinding.sources.find(item => item.file === file);
    if (promotion) {
      expect(row.before_sha256).toBe(promotion.after_sha256);
      expect(sha(reversePromotionAuthorSource(file, previous))).toBe(promotion.before_sha256);
    }
  });

  it.each(sourceFiles)('rejects source drift and moved inverse locations at %s', file => {
    expect(() => reverseCouponAuthorSource(file, read(file) + '\n// unreviewed drift\n')).toThrow();
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === file)!;
    row.edits[0]!.after_line++;
    expect(() => reverseCouponAuthorSource(file, read(file), binding)).toThrow();
  });

  it('pins byte-identical Commerce/journal/canonical sources and pre-existing media policy/lease', () => {
    const rows = (proof as typeof proof & { observed_unchanged_sources: Array<{file:string;sha256:string}> }).observed_unchanged_sources;
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map(row => row.file)).size).toBe(12);
    for (const row of rows) { expect(sha(read(row.file))).toBe(row.sha256); expect(sourceFiles).not.toContain(row.file); }
    const priorMedia = promotionAuthorSourceBinding.sources.filter(row => row.file.endsWith('/DiyEditorialMediaPolicy.ts') || row.file.endsWith('/diyEditorialMediaLease.ts'));
    expect(priorMedia).toHaveLength(2);
    for (const row of priorMedia) expect(rows.find(item => item.file === row.file)?.sha256).toBe(row.after_sha256);
  });

  it('adapts only the Dice source hash and three call lines with all703/741 retained', () => {
    expect(applyCouponAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(applyPointsAuthorReport(current)))))));
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

  it.each(['counts', 'route', 'call', 'source', 'methodology'] as const)('rejects complete API predecessor %s drift', kind => {
    const changed = structuredClone(before);
    if (kind === 'counts') changed.counts.registered++;
    if (kind === 'route') changed.backend.registeredRoutes[0].handler = 'unreviewed';
    if (kind === 'call') changed.calls[0].line++;
    if (kind === 'source') changed.frontendSources[0].sha256 = '0'.repeat(64);
    if (kind === 'methodology') changed.methodology.scope = 'unreviewed';
    expect(() => applyCouponAuthorReport(changed)).toThrow();
  });

  it.each(['counts', 'backend', 'before-row', 'after-row', 'before-hash', 'after-hash'] as const)('rejects API proof %s drift', kind => {
    const changed = structuredClone(proof);
    if (kind === 'counts') (changed.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') changed.backend_unchanged = false;
    if (kind === 'before-row') changed.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'after-row') changed.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') changed.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'after-hash') changed.current_report.sha256 = '0'.repeat(64);
    expect(() => applyCouponAuthorReport(before, changed)).toThrow();
  });

  it.each(['duplicate-edit', 'before-hash', 'after-hash', 'edit-body', 'branch-bypass'] as const)('rejects exact source proof %s drift', kind => {
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === 'view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue')!;
    let source = read(row.file);
    if (kind === 'duplicate-edit') source += row.edits[0]!.after_source;
    if (kind === 'before-hash') row.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') row.after_sha256 = '0'.repeat(64);
    if (kind === 'edit-body') row.edits[0]!.after_source += '// unreviewed';
    if (kind === 'branch-bypass') source = source.replace('DiyCouponWidget', 'UnreviewedCouponWidget');
    expect(() => reverseCouponAuthorSource(row.file, source, binding)).toThrow();
  });
});

const parityRaw = read('workers-ts/audit/diy-coupon-author-php-parity-20261025.json');
const parity = JSON.parse(parityRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string }>;
  PHP_behavior_evidence: Array<{ file: string; start_line: number; end_line: number; source: string }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  assets: unknown[];
  default_binding: { top_level_keys: number; compact_json_sha256: string; complete_literal: Record<string, unknown> };
  boundaries: Record<string, string>;
};

describe('coupon complete additions and immutable fixed-PHP active template authority', () => {
  it('pins three real PHP files, all24default keys, five active layouts and explicit read/write/media boundaries', () => {
    expect(sha(parityRaw)).toBe('ed67ffe4e40c8f59b6f95d1f113a7b2120abe85feff690dd3e01f38110391c6e');
    expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parity.PHP_sources.map(row => [row.file, row.raw_sha256])).toEqual([
      ['view/admin/src/components/mobilePage/home_coupon.vue', 'aec344597c104f7f03772cdf83dc35c912b340964d8dfeb29fa307d06dab793d'],
      ['view/admin/src/components/mobileConfig/c_home_coupon.vue', '561533c066e6d80e15e71bc03bd7fa02e08072e73924f22de6fb78a839500093'],
      ['view/uniapp/pages/index/components/coupon.vue', '5b0c3b430f4a2d7830ac6849b61edc35c140632c8c812d722680fbb4ae895c93'],
    ]);
    expect(parity.default_binding.top_level_keys).toBe(24);
    expect(Object.keys(parity.default_binding.complete_literal)).toHaveLength(24);
    expect(parity.default_binding.compact_json_sha256).toBe('4ad457fc9475b96a9c1ab87fc9c87b0b1918cada7740d16e42cd3725dfbfffc6');
    expect(sha(JSON.stringify(parity.default_binding.complete_literal))).toBe(parity.default_binding.compact_json_sha256);
    const template = parity.PHP_behavior_evidence.find(row => row.file.endsWith('/coupon.vue') && row.start_line === 1)!.source;
    for (const marker of ['coupon1', 'coupon2', 'coupon3', 'coupon4', 'coupon5', 'couponMoneyColor', 'goCoupon']) expect(template).toContain(marker);
    expect(template).not.toContain('index<4');
    expect(template).toContain('<view class="info" :style="[couponMoneyColor]">');
    const publicLogic = parity.PHP_behavior_evidence.find(row => row.file.endsWith('/coupon.vue') && row.start_line === 188)!.source;
    for (const marker of ['that.$config.LIMIT', 'this.dataConfig.numberConfig.val >= limit', 'getCoupons({', 'setCouponReceive(item.id)', "url: '/pages/activity/coupon/index'", 'valList[3]']) expect(publicLogic).toContain(marker);
    const css = parity.PHP_behavior_evidence.find(row => row.file.endsWith('/coupon.vue') && row.start_line === 348)!.source;
    for (const marker of ['width: 156rpx', 'width: 204rpx', 'width: 274rpx', 'width: 140rpx', 'width: 228rpx', 'width: 296rpx', 'margin-right: 12rpx']) expect(css).toContain(marker);
    expect(parity.boundaries.quantity).toContain('not established');
    expect(parity.boundaries.preview).toContain('No preview=1 fixture');
    expect(parity.boundaries.media).toContain('No authored raster slot');
    expect(parity.sources.map(row => row.file)).toEqual(fullAddFiles);
    expect(parity.sources).toHaveLength(14);
    expect(parity.assets).toEqual([]);
  });

  it.each(fullAddFiles)('pins and exactly reverses the complete new source %s', file => {
    const row = parity.sources.find(item => item.file === file)!;
    expect(row.before_sha256).toBe(sha(''));
    expect(row.edits).toHaveLength(1);
    expect(row.edits[0]!.before_source).toBe('');
    expect(sha(read(file))).toBe(row.after_sha256);
    expect(reverseRouteSourceFollowup(read(file), row)).toBe('');
  });

  it.each(fullAddFiles)('rejects current or recorded full-add drift at %s', file => {
    const row = parity.sources.find(item => item.file === file)!;
    expect(() => reverseRouteSourceFollowup(read(file) + '\n// unreviewed\n', row)).toThrow();
    const changed = structuredClone(row); changed.edits[0]!.after_line = 2;
    expect(() => reverseRouteSourceFollowup(read(file), changed)).toThrow();
  });
});
