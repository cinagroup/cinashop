import { beforeConfigClassReport } from './helpers/configClassSourceBinding';
import { reverseSearchHotwordsSource } from './helpers/searchHotwordsSourceBinding';
import { reverseLiveBroadcastAuthorSource, applyLiveBroadcastAuthorReport } from './helpers/diyLiveBroadcastAuthorSourceBinding';
import { reverseSeckillAuthorSource, applySeckillAuthorReport } from './helpers/diySeckillAuthorSourceBinding';
import { reverseBargainAuthorSource, applyBargainAuthorReport } from './helpers/diyBargainAuthorSourceBinding';
import { reverseCombinationAuthorSource, applyCombinationAuthorReport } from './helpers/diyCombinationAuthorSourceBinding';
import { reversePresaleAuthorSource, applyPresaleAuthorReport, presaleAuthorSourceBinding } from './helpers/diyPresaleAuthorSourceBinding';
import { createHash } from 'node:crypto';
import { readAdminProfileThenErrorPagesThenBrowserLogThenConfigClassPredecessor as readFileSync } from './helpers/wechatAppAuthorSourceBinding';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdminProfilePredecessorApiAuditReport as buildCurrentAdminFrontendApiAuditReport } from './helpers/wechatAppAuthorSourceBinding';
const buildAdminFrontendApiAuditReport=()=>beforeConfigClassReport(buildCurrentAdminFrontendApiAuditReport());
import { applyPointsAuthorReport, reversePointsAuthorSource, pointsAuthorSourceBinding as proof } from './helpers/diyPointsAuthorSourceBinding';
import { couponAuthorSourceBinding, reverseCouponAuthorSource } from './helpers/diyCouponAuthorSourceBinding';
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from './helpers/routeSourceIncrement';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => reversePresaleAuthorSource(file, reverseCombinationAuthorSource(file, reverseBargainAuthorSource(file, reverseSeckillAuthorSource(file, reverseLiveBroadcastAuthorSource(file,reverseSearchHotwordsSource(file,readFileSync(resolve(root, file === proof.current_report.file ? presaleAuthorSourceBinding.previous_report.file : file), 'utf8').replace(/\r\n?/gu, '\n')))))));
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
  "workers-ts/test/helpers/diyPromotionAuthorSourceBinding.ts": "26a46bc8609cbafbbb2907535cdb8efcac9f22a03efda210294b785f28f6bda0",
  "workers-ts/audit/diy-coupon-author-source-binding-20261025.json": "5c3f700a231dc7840bf65d66dc857b3e7c611a48e8be311e8b735fd96e8bcbbc",
  "workers-ts/audit/diy-coupon-author-php-parity-20261025.json": "ed67ffe4e40c8f59b6f95d1f113a7b2120abe85feff690dd3e01f38110391c6e",
  "workers-ts/test/helpers/diyCouponAuthorSourceBinding.ts": "6464453af98b0063b7c61f13a3147c4ab0aeebf2782b42ec39e555e9178dfbf1"
} as const;
const fullAddFiles = [
  "view/admin-ts/src/utils/diyPointsDefaults.ts",
  "view/admin-ts/src/utils/diyPointsEditor.ts",
  "view/admin-ts/src/api/diyPointsAuthor.ts",
  "view/admin-ts/scripts/diy-points-editor-model-runtime.test.cjs",
  "view/admin-ts/scripts/diy-points-author-data-runtime.test.cjs",
  "view/admin-ts/src/components/content/DiyPointsEditor.vue",
  "view/admin-ts/src/components/content/DiyPointsPreview.vue",
  "view/admin-ts/src/components/content/DiyPointsPreviewCard.vue",
  "view/admin-ts/scripts/diy-points-editor-runtime.test.cjs",
  "view/common/diyPoints.ts",
  "view/uniapp-ts/src/components/diy/DiyPointsWidget.vue",
  "view/uniapp-ts/src/components/diy/DiyPointsCard.vue",
  "view/uniapp-ts/src/composables/useDiyPoints.ts",
  "view/uniapp-ts/scripts/diy-points-author-runtime.test.cjs",
  "workers-ts/test/diy-points-author-media.test.ts"
] as const;

describe('exact points author increment preserves all coupon and earlier evidence', () => {
  it('pins every old dated proof/helper, the complete coupon predecessor and exact reviewed scope', () => {
    for (const [file, expected] of Object.entries(frozen)) expect(sha(read(file))).toBe(expected);
    expect(proof.previous_report.sha256).toBe('844e662e047c8eaa3786741267ed6b63dd73eb779a1440aa4a7ab684af7a91cc');
    expect(proof.previous_report.sha256).toBe(couponAuthorSourceBinding.current_report.sha256);
    expect(sha(read(proof.previous_report.file))).toBe(proof.previous_report.sha256);
    expect(sourceFiles).toHaveLength(20);
    expect(new Set(sourceFiles).size).toBe(20);
    expect(sourceFiles).toContain('view/admin-ts/src/pages/content/DiseList.vue');
    expect(sourceFiles).toContain('view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue');
    for (const file of [
      'view/uniapp-ts/src/utils/diyCommerceConfig.ts',
      'view/uniapp-ts/src/composables/useDiyCommerceWidget.ts',
      'view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue',
      'view/uniapp-ts/src/api/diyCommerce.ts',
      'view/uniapp-ts/src/utils/diyPointsClaim.ts',
    ]) expect(sourceFiles).not.toContain(file);
    expect(reversePointsAuthorSource('unrelated/file.ts', 'unchanged exact bytes')).toBe('unchanged exact bytes');
  });

  it.each(sourceFiles)('reconstructs the captured complete predecessor at %s', file => {
    const row = proof.sources.find(item => item.file === file)!;
    expect(sha(read(file))).toBe(row.after_sha256);
    const previous = reversePointsAuthorSource(file, read(file));
    expect(sha(previous)).toBe(row.before_sha256);
    const promotion = couponAuthorSourceBinding.sources.find(item => item.file === file);
    if (promotion) {
      expect(row.before_sha256).toBe(promotion.after_sha256);
      expect(sha(reverseCouponAuthorSource(file, previous))).toBe(promotion.before_sha256);
    }
  });

  it.each(sourceFiles)('rejects source drift and moved inverse locations at %s', file => {
    expect(() => reversePointsAuthorSource(file, read(file) + '\n// unreviewed drift\n')).toThrow();
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === file)!;
    row.edits[0]!.after_line++;
    expect(() => reversePointsAuthorSource(file, read(file), binding)).toThrow();
  });

  it('pins unchanged legacy Commerce/canonical/helper bytes and exact prior media predecessors', () => {
    const rows = (proof as typeof proof & { observed_unchanged_sources: Array<{file:string;sha256:string}> }).observed_unchanged_sources;
    expect(rows).toHaveLength(7); expect(new Set(rows.map(row => row.file)).size).toBe(7);
    for (const row of rows) { expect(sha(read(row.file))).toBe(row.sha256); expect(sourceFiles).not.toContain(row.file); }
    const previousRows = (couponAuthorSourceBinding as typeof couponAuthorSourceBinding & { observed_unchanged_sources: Array<{file:string;sha256:string}> }).observed_unchanged_sources;
    for (const file of ['workers-ts/src/services/content/DiyEditorialMediaPolicy.ts','view/uniapp-ts/src/utils/diyEditorialMediaLease.ts']) {
      const current = proof.sources.find(row => row.file === file)!;
      expect(current.before_sha256).toBe(previousRows.find(row => row.file === file)!.sha256);
    }
    for (const file of ['view/uniapp-ts/scripts/diy-promotion-author-runtime.test.cjs','view/uniapp-ts/scripts/diy-coupon-author-runtime.test.cjs']) expect(sourceFiles).toContain(file);
  });

  it('adapts only the Dice source hash and three call lines with all703/741 retained', () => {
    expect(applyPointsAuthorReport(before)).toEqual(current);
    expect(buildAdminFrontendApiAuditReport()).toEqual(applyLiveBroadcastAuthorReport(applySeckillAuthorReport(applyBargainAuthorReport(applyCombinationAuthorReport(applyPresaleAuthorReport(current))))));
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
    expect(() => applyPointsAuthorReport(changed)).toThrow();
  });

  it.each(['counts', 'backend', 'before-row', 'after-row', 'before-hash', 'after-hash'] as const)('rejects API proof %s drift', kind => {
    const changed = structuredClone(proof);
    if (kind === 'counts') (changed.counts_unchanged as Record<string, number>).registered++;
    if (kind === 'backend') changed.backend_unchanged = false;
    if (kind === 'before-row') changed.report_changes[0]!.before.sha256 = '0'.repeat(64);
    if (kind === 'after-row') changed.report_changes[0]!.after.sha256 = '0'.repeat(64);
    if (kind === 'before-hash') changed.previous_report.sha256 = '0'.repeat(64);
    if (kind === 'after-hash') changed.current_report.sha256 = '0'.repeat(64);
    expect(() => applyPointsAuthorReport(before, changed)).toThrow();
  });

  it.each(['duplicate-edit', 'before-hash', 'after-hash', 'edit-body', 'branch-bypass'] as const)('rejects exact source proof %s drift', kind => {
    const binding = structuredClone(proof), row = binding.sources.find(item => item.file === 'view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue')!;
    let source = read(row.file);
    if (kind === 'duplicate-edit') source += row.edits[0]!.after_source;
    if (kind === 'before-hash') row.before_sha256 = '0'.repeat(64);
    if (kind === 'after-hash') row.after_sha256 = '0'.repeat(64);
    if (kind === 'edit-body') row.edits[0]!.after_source += '// unreviewed';
    if (kind === 'branch-bypass') source = source.replace('DiyPointsWidget', 'UnreviewedPointsWidget');
    expect(() => reversePointsAuthorSource(row.file, source, binding)).toThrow();
  });
});

const parityRaw = read('workers-ts/audit/diy-points-author-php-parity-20261025.json');
const parity = JSON.parse(parityRaw) as {
  PHP_ref: string;
  PHP_sources: Array<{ file: string; raw_sha256: string }>;
  PHP_behavior_evidence: Array<{ file: string; start_line: number; end_line: number; source: string }>;
  sources: Array<RouteSourceFollowup & { file: string }>;
  assets: unknown[];
  default_binding: { top_level_keys: number; compact_json_sha256: string; complete_literal: Record<string, unknown> };
  boundaries: Record<string, string>;
};

describe('points complete additions and fixed-PHP active author/template authority', () => {
  it('pins five original sources,44 complete defaults, three explicit static mappings and all public-vs-author boundaries', () => {
    expect(sha(parityRaw)).toBe('bb7086d358c0d4b8177abd3bb72ef21627381c2edf521f80fb3b96c9ad6eaea2');
    expect(parity.PHP_ref).toBe('8ed2a5b139f9170dd11b0dff91803f2fd59e40a5');
    expect(parity.PHP_sources.map(row => [row.file,row.raw_sha256])).toEqual([
  [
    "view/admin/src/components/mobilePage/points_mall.vue",
    "fc9b3b735f38295cc49247470c85fb2d78f131f938dab31bc301a2300b9ffa87"
  ],
  [
    "view/admin/src/components/mobileConfig/c_points_mall.vue",
    "bfff5179e89177007c006bb804c331a3b472afdb6b22a278cc319b2b5adb1676"
  ],
  [
    "view/uniapp/pages/index/components/pointsMall.vue",
    "b544c1d9543f40d5cf3501cc2234b73aa019ff905a1ceefc037ad8276497f18d"
  ],
  [
    "view/uniapp/api/activity.js",
    "a523651afff92535cc78663a98a25198a56be24ff22415e772507db2d637a22a"
  ],
  [
    "view/uniapp/static/css/unocss.css",
    "02476cc8672acc825838b249bc1b0e7265d8cfe7954cb59a4b78aa72e5cfd523"
  ]
]);
    expect(parity.default_binding.top_level_keys).toBe(44); expect(Object.keys(parity.default_binding.complete_literal)).toHaveLength(44);
    expect(parity.default_binding.compact_json_sha256).toBe('e4d210829d08b1e1428a766f50982115c7d847beacdfc1d5a6be6569173e22ad');
    expect(sha(JSON.stringify(parity.default_binding.complete_literal))).toBe(parity.default_binding.compact_json_sha256);
    const defaults=parity.default_binding.complete_literal as Record<string,Record<string,unknown>>;
    expect(defaults.imgBgConfig!.url).toBe('@PHP_API_ROOT@/statics/images/pointsBg.png'); expect(defaults.imgConfig!.url).toBe('@/assets/images/points01.png'); expect(defaults.imgConfig2!.url).toBe('@/assets/images/points02.png');
    const mappings=(parity.default_binding as typeof parity.default_binding & {static_image_mappings:Array<{path:string[];TS_reference:string}>}).static_image_mappings;
    expect(mappings.map(row=>[row.path,row.TS_reference])).toEqual([[['imgBgConfig','url'],'/static/images/diy/points-bg.png'],[['imgConfig','url'],'/static/images/diy/points-title.png'],[['imgConfig2','url'],'/static/images/diy/points-title-alt.png']]);
    const template=parity.PHP_behavior_evidence.find(row=>row.file.endsWith('/pointsMall.vue')&&row.start_line===1)!.source;
    for(const marker of ['goodStyleConfig.tabVal == 0','goodStyleConfig.tabVal == 1','goodStyleConfig.tabVal == 2','width="224rpx" height="224rpx"','height="212rpx"','height="324rpx"','newVip3.png','goGoodsDetails(item.id)','<text>更多</text>'])expect(template).toContain(marker);
    const computed=parity.PHP_behavior_evidence.find(row=>row.file.endsWith('/pointsMall.vue')&&row.start_line===92)!.source;
    for(const marker of ["this.dataConfig.imgConfig2.url","this.dataConfig.imgConfig.url","'font-size': this.dataConfig.bntNumber.val","case 2:","fontStyle = 'italic'","valList[3]","this.dataConfig.goodsPriceColor2.color[0].item","this.dataConfig.goodsPriceColor.color[0].item","${this.dataConfig.topConfig.val}rpx"])expect(computed).toContain(marker);
    const behavior=parity.PHP_behavior_evidence.find(row=>row.file.endsWith('/pointsMall.vue')&&row.start_line===199)!.source;
    for(const marker of ['this.$config.LIMIT','getStoreIntegralList({','page: 1','type=4','/pages/activity/points_mall/index'])expect(behavior).toContain(marker);
    const request=parity.PHP_behavior_evidence.find(row=>row.file.endsWith('/activity.js'))!.source;expect(request).toContain("request.get('store_integral/list'");expect(request).toContain('noAuth: true');
    for(const marker of ['rightBntConfig','titleColor','titleNumber','goodsNameColor2','goodsUnitPriceColor2','bottomBgColor'])expect(parity.boundaries.metadata).toContain(marker);
    expect(parity.boundaries.lease).toContain('pure signed-ticket renewal'); expect(parity.boundaries.preview).toContain('PHP LIMIT absent');
    expect(parity.sources.map(row=>row.file)).toEqual(fullAddFiles);expect(parity.sources).toHaveLength(15);expect(parity.assets).toHaveLength(8);
  });

  it.each(fullAddFiles)('pins and exactly reverses complete new source %s',file=>{
    const row=parity.sources.find(item=>item.file===file)!;expect(row.before_sha256).toBe(sha(''));expect(row.edits).toHaveLength(1);expect(row.edits[0]!.before_source).toBe('');expect(sha(read(file))).toBe(row.after_sha256);expect(reverseRouteSourceFollowup(read(file),row)).toBe('');
  });
  it.each(fullAddFiles)('rejects current or recorded full-add drift at %s',file=>{
    const row=parity.sources.find(item=>item.file===file)!;expect(()=>reverseRouteSourceFollowup(read(file)+'\n//unreviewed\n',row)).toThrow();const changed=structuredClone(row);changed.edits[0]!.after_line=2;expect(()=>reverseRouteSourceFollowup(read(file),changed)).toThrow();
  });

  it.each([
    ['points-bg.png','public/statics/images/pointsBg.png','f091108145214600a2ce57a7837147675b0bb590848088f5fb7d84d43fbdbd7f'],
    ['points-title.png','view/admin/src/assets/images/points01.png','c010c32a90caaa85a5603acb8e2711f8628c2bc0486ec130658aa1b58cb5aa2a'],
    ['points-title-alt.png','view/admin/src/assets/images/points02.png','f762f3bf6d887ead5283f94327693f76afd71c9cd662ee3c5e73f79b8e660ddd'],
    ['points-icon.png','public/statics/images/newVip3.png','878811dad1f6760dd07500fa94f95f1dc9bb632ba5680c43e7797038c24b485d'],
  ])('pins exact dual-platform original PNG bytes at%s without authorizing the decorative icon',(name,original,expected)=>{
    const rows=parity.assets as Array<{file:string;PHP_file:string;after_sha256:string;before_exists:boolean;bytes:number}>;
    const matches=rows.filter(row=>row.file.endsWith('/'+name));expect(matches).toHaveLength(2);
    for(const row of matches){expect(row.PHP_file).toBe(original);expect(row.after_sha256).toBe(expected);expect(row.before_exists).toBe(false);const data=readFileSync(resolve(root,row.file));expect(sha(data)).toBe(expected);expect(data.byteLength).toBe(row.bytes);}
    expect(parity.default_binding.complete_literal).not.toHaveProperty('icon');
  });
});
